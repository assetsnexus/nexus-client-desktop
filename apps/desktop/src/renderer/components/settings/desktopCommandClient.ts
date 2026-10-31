/**
 * Desktop `CommandClient` for the settings surface.
 *
 * The shared SDK helpers (contact-TTS, voice lists) speak the ANX command
 * envelope through a `CommandClient`. Inside the chat/companion webview that
 * client is `createRegionCommandClient` (which also routes through a native
 * host bridge), but the settings surface lives in the main renderer, which has
 * no such host — it talks to the region over plain `fetch` with the session
 * token from the main process.
 *
 * The result shape is normalized to what the SDK expects: `ok`, `responseCode`,
 * and `data`/`responseObject` unwrapped to the command payload.
 */

import type { CommandClient } from '@nexus/chat-core';

export type DesktopIdentity = {
  token: string;
  userId?: string | null;
  orgId?: string | null;
  role?: string | null;
  deviceId?: string | null;
};

export function createDesktopCommandClient(input: {
  apiBaseUrl: string;
  identity: DesktopIdentity;
  fetchFn?: typeof fetch;
}): CommandClient {
  const fetchFn = input.fetchFn ?? fetch;
  const apiBaseUrl = input.apiBaseUrl.replace(/\/$/, '');
  const identity = input.identity;

  return {
    async send(command: string, payload?: Record<string, unknown>) {
      const requestId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const body = {
        command,
        requestId,
        payload: payload || {},
        identity: {
          userId: identity.userId || undefined,
          orgId: identity.orgId || undefined,
          role: identity.role || undefined,
          deviceId: identity.deviceId || undefined,
          token: identity.token,
        },
        responseExpected: true,
        timestamp: new Date().toISOString(),
      };
      const res = await fetchFn(`${apiBaseUrl}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${identity.token}`,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const responseCode = Number(json.responseCode ?? json.status ?? res.status ?? 0);
      const data = json.responseObject ?? json.data ?? json;
      return {
        ok: responseCode >= 200 && responseCode < 300,
        data,
        responseCode,
        responseObject: data,
        message: typeof json.message === 'string' ? json.message : undefined,
        authorizationRequired: Boolean(json.authorizationRequired),
        authRequestId: json.authRequestId,
      };
    },
  };
}
