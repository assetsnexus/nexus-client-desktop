/**
 * Cross-device login link client (RFC 8628-style "sign in with the Nexus app").
 *
 * The desktop has no session yet, so every call here is pre-auth: `start` and
 * `poll` are public region commands and the secret `deviceCode` is the only
 * capability. Approval happens on the signed-in mobile app, never here.
 */

import { sendCommand, type AuthClientOptions, type RegionResponse } from './auth.js';

export type DeviceLinkStartInput = {
  /** Region slug served by the node. Omit to use the node's managed region. */
  region?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
};

export type DeviceLinkStarted = {
  /** Secret half; keep in memory for polling, never render. */
  deviceCode: string;
  /** Short half; render as a QR and show for typing. */
  userCode: string;
  /**
   * Deep link that opens the ANX app straight into approval
   * (`assetsnexus://link?code=…`). Preferred QR payload; the portal URL is the
   * fallback for phones without the app.
   */
  appLink: string;
  /** Web fallback: the portal approval page. */
  verificationUri: string;
  expiresAt: string;
  interval: number;
};

export type DeviceLinkPollResult =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; token: unknown; session: unknown }
  | { status: 'denied' }
  | { status: 'expired' };

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function assertOk(res: RegionResponse, fallback: string): Record<string, unknown> {
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  if (res.responseCode < 200 || res.responseCode >= 300) {
    const errCode = (res.responseObject as any)?.code;
    const message =
      (typeof (res.responseObject as any)?.message === 'string' && (res.responseObject as any).message) ||
      res.message ||
      fallback;
    const error = new Error(message) as Error & { code?: string; responseCode?: number };
    if (typeof errCode === 'string') error.code = errCode;
    error.responseCode = res.responseCode;
    throw error;
  }
  return body;
}

/** `anx.auth.device-link.start` — mint a deviceCode + userCode pair. */
export async function startDeviceLink(
  opts: AuthClientOptions,
  input: DeviceLinkStartInput,
): Promise<DeviceLinkStarted> {
  const payload: Record<string, unknown> = {};
  if (input.region) payload.region = input.region;
  if (input.deviceName) payload.deviceName = input.deviceName;
  if (input.platform) payload.platform = input.platform;
  if (input.appVersion) payload.appVersion = input.appVersion;

  const res = await sendCommand(opts, 'anx.auth.device-link.start', payload);
  const body = assertOk(res, 'could not start sign-in link');
  const deviceCode = readString(body, 'deviceCode');
  const userCode = readString(body, 'userCode');
  if (!deviceCode || !userCode) {
    throw new Error('region returned an incomplete sign-in link');
  }
  return {
    deviceCode,
    userCode,
    appLink: readString(body, 'appLink') ?? `assetsnexus://link?code=${encodeURIComponent(userCode)}`,
    verificationUri: readString(body, 'verificationUri') ?? '',
    expiresAt: readString(body, 'expiresAt') ?? new Date(Date.now() + 5 * 60_000).toISOString(),
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
  };
}

/**
 * `anx.auth.device-link.poll` — exchange the secret deviceCode for the session.
 * The approved branch is consumed exactly once; a later poll returns `expired`.
 */
export async function pollDeviceLink(
  opts: AuthClientOptions,
  deviceCode: string,
): Promise<DeviceLinkPollResult> {
  const res = await sendCommand(opts, 'anx.auth.device-link.poll', { deviceCode });
  const body = assertOk(res, 'could not poll sign-in link');
  const status = readString(body, 'status');
  if (status === 'approved') {
    return { status: 'approved', token: body.token, session: body.session };
  }
  if (status === 'denied') return { status: 'denied' };
  if (status === 'expired') return { status: 'expired' };
  return {
    status: 'pending',
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
  };
}
