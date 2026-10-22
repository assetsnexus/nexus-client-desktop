import { describe, expect, it } from 'vitest';
import { classifySessionFailure, sessionLostFromResult } from './session-guard.js';

describe('classifySessionFailure', () => {
  it('treats the region device-validation failure as device revocation', () => {
    const out = classifySessionFailure({
      responseCode: 401,
      message: 'Device validation failed: Device has been removed and is no longer active',
    });
    expect(out.lost).toBe(true);
    if (out.lost) {
      expect(out.reason).toBe('device_revoked');
      expect(out.deviceRevoked).toBe(true);
    }
  });

  it('recognizes explicit revocation codes', () => {
    for (const code of ['DEVICE_REVOKED', 'DEVICE_REMOVED', 'AUTH_FAILED']) {
      const out = classifySessionFailure({ responseCode: 401, code });
      expect(out.lost).toBe(true);
      if (out.lost) expect(out.deviceRevoked).toBe(true);
    }
  });

  it('flags a bare 401 as unauthorized (session lost)', () => {
    const out = classifySessionFailure({ responseCode: 401, message: 'Unauthorized' });
    expect(out.lost).toBe(true);
    if (out.lost) expect(out.reason).toBe('unauthorized');
  });

  it('does NOT treat a 403 authorization denial as session loss', () => {
    // RBAC/policy/onboarding denials are about one command, not the session.
    // Treating them as loss signed the user out (e.g. opening a panel whose
    // catalog command needs a permission the caller lacks).
    for (const message of ['Access denied', 'FORBIDDEN', 'Insufficient permissions']) {
      const out = classifySessionFailure({ responseCode: 403, message, code: 'FORBIDDEN' });
      expect(out.lost).toBe(false);
    }
  });

  it('treats an idle-session expiry as an expired session', () => {
    const out = classifySessionFailure({
      responseCode: 401,
      code: 'SESSION_IDLE_EXPIRED',
      message: 'Your session expired after a period of inactivity. Sign in again.',
    });
    expect(out.lost).toBe(true);
    if (out.lost) expect(out.reason).toBe('expired');
  });

  it('treats an invalid/expired token 401 as an expired session', () => {
    const out = classifySessionFailure({ responseCode: 401, message: 'Invalid or expired token' });
    expect(out.lost).toBe(true);
    if (out.lost) expect(out.reason).toBe('expired');
  });

  it('detects an expired token', () => {
    const out = classifySessionFailure({ responseCode: 400, code: 'TOKEN_EXPIRED' });
    expect(out.lost).toBe(true);
    if (out.lost) expect(out.reason).toBe('expired');
  });

  it('leaves ordinary business errors alone', () => {
    expect(classifySessionFailure({ responseCode: 400, message: 'invalid folder name' }).lost).toBe(false);
    expect(classifySessionFailure({ responseCode: 404, message: 'file not found' }).lost).toBe(false);
    expect(classifySessionFailure({ responseCode: 500, message: 'boom' }).lost).toBe(false);
  });
});

describe('sessionLostFromResult', () => {
  it('maps a command result to a loss', () => {
    const out = sessionLostFromResult({ responseCode: 401, message: 'Device has been removed' });
    expect(out.lost).toBe(true);
  });

  it('reports not-lost for a healthy result', () => {
    expect(sessionLostFromResult({ responseCode: 200 }).lost).toBe(false);
  });
});
