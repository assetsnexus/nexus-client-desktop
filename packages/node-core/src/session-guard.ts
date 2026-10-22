/**
 * Session-loss detection (Phase 3).
 *
 * The portal can remove a desktop device (`anx.device.remove`). The region then
 * soft-deletes the device row (`active=false, removed=true`) and its
 * authorization layer rejects *every* subsequent command from that device with a
 * device-validation failure. From the desktop's point of view a device removal
 * is therefore indistinguishable from a lost session: the token is structurally
 * valid but no longer usable.
 *
 * Rather than guess, we classify the region's error shape. Anything that proves
 * the session/device is dead — an explicit revocation code, a device-validation
 * message, or an authentication failure — must tear down *all* local access:
 * tokens, secure storage, active sync schedules and mounts, and the signed-in UI.
 *
 * A `403` is deliberately *not* session loss: it is an authorization decision
 * (RBAC permission, execution/onboarding gate, regulatory bundle) about one
 * command, and the region reports device revocation as a `401`
 * device-validation failure instead. Treating `403` as loss signed the user out
 * whenever any single command was not permitted.
 */

export type SessionLossReason = 'device_revoked' | 'unauthorized' | 'expired';

export type SessionLoss = {
  lost: true;
  reason: SessionLossReason;
  message: string;
  /** True when we can be confident the device itself was removed. */
  deviceRevoked: boolean;
};

export type SessionOk = { lost: false };

export function classifySessionFailure(input: {
  responseCode: number;
  message?: string | null;
  code?: string | null;
}): SessionLoss | SessionOk {
  const code = (input.code ?? '').toUpperCase();
  const message = input.message ?? '';
  const lower = message.toLowerCase();

  const explicitlyRevoked =
    code === 'DEVICE_REVOKED' ||
    code === 'DEVICE_REMOVED' ||
    code === 'AUTH_FAILED' ||
    /device (validation failed|has been removed|is inactive)/.test(lower) ||
    /device.*(revoked|removed|no longer active)/.test(lower);

  if (explicitlyRevoked) {
    return {
      lost: true,
      reason: 'device_revoked',
      deviceRevoked: true,
      message: message || 'Device has been removed and is no longer active',
    };
  }

  // An expired/revoked token, or an idle-session expiry, is a dead session even
  // though the region reports it as a 401.
  const expiredEvidence =
    code === 'TOKEN_EXPIRED' ||
    code === 'SESSION_IDLE_EXPIRED' ||
    lower.includes('token expired') ||
    lower.includes('invalid or expired token') ||
    lower.includes('session expired');
  if (expiredEvidence) {
    return {
      lost: true,
      reason: 'expired',
      deviceRevoked: false,
      message: message || 'Token expired',
    };
  }

  if (input.responseCode === 401) {
    return {
      lost: true,
      reason: 'unauthorized',
      deviceRevoked: /device/.test(lower) && /(removed|revoked|inactive)/.test(lower),
      message: message || 'Unauthorized',
    };
  }
  // A 403 is an *authorization* decision (RBAC permission, policy/onboarding
  // gate, regulatory bundle), never proof the session is dead. The region
  // reports device revocation as a 401 device-validation failure, so treating
  // 403 as session loss would sign the user out whenever a single command is
  // not permitted — e.g. an org member opening a panel whose catalog command
  // needs a permission they lack.
  return { lost: false };
}

/**
 * Given a command result shape (ok/responseCode/message), decide whether the
 * session is dead. Convenience over `classifySessionFailure` for senders that
 * only carry a boolean + code.
 */
export function sessionLostFromResult(result: {
  responseCode?: number;
  message?: string | null;
  code?: string | null;
}): SessionLoss | SessionOk {
  return classifySessionFailure({
    responseCode: result.responseCode ?? 0,
    message: result.message,
    code: result.code,
  });
}
