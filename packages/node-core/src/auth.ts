/**
 * Minimal region auth client for the desktop main process.
 *
 * Uses plain `fetch` with an optional custom CA agent so local/self-signed
 * region nodes work. 2FA is mandatory for every user (see SYS_GLOBAL): login
 * either returns a token or a `requiresTwoFactor` challenge that we complete
 * through `anx.auth.twoFactorLogin`.
 */

export type LoginCredentials = {
  email: string;
  password: string;
  orgId?: string | null;
};

export type TwoFactorChallenge = {
  authRequestId: string;
  /** Factors the region is willing to dispatch, when advertised. */
  factors: string[];
  message?: string;
};

export type LoginResult =
  | { kind: 'authenticated'; token: string; identity: AuthIdentity; region?: unknown }
  | { kind: 'two_factor_required'; challenge: TwoFactorChallenge };

export type AuthIdentity = {
  userId: string | null;
  orgId: string | null;
  role: string | null;
  deviceId: string | null;
  email?: string | null;
};

export type AuthError = {
  responseCode: number;
  message: string;
};

export class RegionAuthError extends Error {
  readonly responseCode: number;
  constructor(message: string, responseCode = 0) {
    super(message);
    this.name = 'RegionAuthError';
    this.responseCode = responseCode;
  }
}

/** Command envelope shape accepted by the region `/command` endpoint. */
export type CommandEnvelope = {
  command: string;
  requestId: string;
  payload: Record<string, unknown>;
  identity?: Record<string, unknown>;
  responseExpected: boolean;
  timestamp: string;
};

export type RegionResponse = {
  responseCode: number;
  responseObject: unknown;
  message?: string;
  authorizationRequired?: boolean;
  authRequestId?: string;
};

export type SendOptions = {
  identity?: Record<string, unknown> | null;
  token?: string | null;
  signal?: AbortSignal;
};

export type AuthClientOptions = {
  baseUrl: string;
  /** Extra headers, e.g. `X-Anx-App: nexus-desktop`. */
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
};

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Send one command envelope to `POST {baseUrl}/command` and normalize the
 * response. Never throws on non-2xx HTTP; only on transport failure.
 */
export async function sendCommand(
  opts: AuthClientOptions,
  command: string,
  payload: Record<string, unknown> = {},
  send: SendOptions = {},
): Promise<RegionResponse> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const identity: Record<string, unknown> = { ...(send.identity ?? {}) };
  if (send.token) identity.token = send.token;

  const envelope: CommandEnvelope = {
    command,
    requestId: generateRequestId(),
    payload: payload ?? {},
    identity: Object.keys(identity).length ? identity : undefined,
    responseExpected: true,
    timestamp: new Date().toISOString(),
  };

  let res: Response;
  try {
    res = await fetchFn(`${base}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(send.token ? { authorization: `Bearer ${send.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(envelope),
      signal: send.signal,
    });
  } catch (err) {
    throw new RegionAuthError(
      err instanceof Error ? err.message : 'network error contacting region',
      0,
    );
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const responseCode = Number(json.responseCode ?? json.status ?? res.status ?? 0);
  return {
    responseCode,
    responseObject: json.responseObject ?? json.data ?? json,
    message: typeof json.message === 'string' ? json.message : undefined,
    authorizationRequired: Boolean(json.authorizationRequired),
    authRequestId: typeof json.authRequestId === 'string' ? json.authRequestId : undefined,
  };
}

function readIdentity(source: Record<string, unknown>): AuthIdentity {
  const user = (source.user as Record<string, unknown>) ?? {};
  const device = (source.device as Record<string, unknown>) ?? {};
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
    return null;
  };
  return {
    userId: pick(source.userId, user.id, user.userId),
    orgId: pick(source.orgId, source.activeOrgId),
    role: pick(source.role, user.role),
    deviceId: pick(source.deviceId, device.id, device.deviceId),
    email: pick(source.email, user.email),
  };
}

function readFactors(source: Record<string, unknown>): string[] {
  const raw = source.factors ?? source.twoFactorFactors ?? source.availableFactors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === 'string' && f.trim() !== '');
}

function readToken(source: Record<string, unknown>): string | null {
  const t = source.token ?? source.accessToken ?? source.jwt;
  return typeof t === 'string' && t.trim() ? t : null;
}

/**
 * `anx.auth.login`. Returns an authenticated session or a 2FA challenge.
 */
export async function login(
  opts: AuthClientOptions,
  creds: LoginCredentials,
): Promise<LoginResult> {
  const payload: Record<string, unknown> = { email: creds.email, password: creds.password };
  if (creds.orgId) payload.orgId = creds.orgId;

  const res = await sendCommand(opts, 'anx.auth.login', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;

  const requiresTwoFactor =
    Boolean(body.requiresTwoFactor) ||
    Boolean(body.twoFactorRequired) ||
    res.authorizationRequired === true ||
    body.status === 'two_factor_required';

  const token = readToken(body);
  if (!requiresTwoFactor && token) {
    return { kind: 'authenticated', token, identity: readIdentity(body), region: body.region };
  }

  const authRequestId =
    res.authRequestId ??
    (typeof body.authRequestId === 'string' ? body.authRequestId : undefined);
  if (requiresTwoFactor || authRequestId) {
    if (!authRequestId) {
      throw new RegionAuthError(
        res.message ?? 'region requested two-factor auth without an authRequestId',
        res.responseCode,
      );
    }
    return {
      kind: 'two_factor_required',
      challenge: {
        authRequestId,
        factors: readFactors(body),
        message: res.message,
      },
    };
  }

  throw new RegionAuthError(res.message ?? 'login failed', res.responseCode);
}

export type TwoFactorLoginInput = {
  authRequestId: string;
  /** Verification code when the factor is email / sms / authenticator. */
  code?: string;
  /** Factor id, e.g. `email`, when the region needs it. */
  factor?: string;
  /** Device id being verified. */
  deviceId?: string | null;
};

/**
 * `anx.auth.twoFactorLogin` (also accepts the alternate `anx.auth.verify2fa`).
 * Returns a token on success.
 */
export async function twoFactorLogin(
  opts: AuthClientOptions,
  input: TwoFactorLoginInput,
): Promise<{ token: string; identity: AuthIdentity }> {
  const payload: Record<string, unknown> = { authRequestId: input.authRequestId };
  if (input.code != null) payload.code = input.code;
  if (input.factor) payload.factor = input.factor;
  if (input.deviceId) payload.deviceId = input.deviceId;

  const commands = ['anx.auth.twoFactorLogin', 'anx.auth.verify2fa'];
  let last: RegionResponse | null = null;
  for (const command of commands) {
    const res = await sendCommand(opts, command, payload);
    last = res;
    const body = (res.responseObject ?? {}) as Record<string, unknown>;
    const token = readToken(body);
    if (token) return { token, identity: readIdentity(body) };
    // Only fall through to the alternate command on a "not found" style code.
    if (res.responseCode !== 404 && res.responseCode !== 405) break;
  }
  throw new RegionAuthError(last?.message ?? 'two-factor verification failed', last?.responseCode ?? 0);
}
