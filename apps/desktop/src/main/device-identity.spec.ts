import { describe, expect, it } from 'vitest';
import { resolveAuthIdentity } from './device-identity.js';

describe('resolveAuthIdentity', () => {
  it('returns the session record when the store has it', () => {
    expect(
      resolveAuthIdentity({
        session: { userId: 'u1', orgId: 'o1', role: 'owner', deviceId: 'dev-1' },
      }),
    ).toMatchObject({ userId: 'u1', orgId: 'o1', role: 'owner', deviceId: 'dev-1' });
  });

  it('repairs a missing deviceId from the stored device keypair', () => {
    // The regression case: a session recorded before device registration (or one
    // hydrated after a restart) carries no deviceId, and the region answers 401
    // 'Device ID is required' for every authenticated command.
    const out = resolveAuthIdentity({
      session: { userId: 'u1', orgId: 'o1', role: 'owner', deviceId: null },
      deviceKeysDeviceId: 'dev-from-keys',
    });
    expect(out.deviceId).toBe('dev-from-keys');
    expect(out.userId).toBe('u1');
  });

  it('prefers the session over the in-memory cache', () => {
    const out = resolveAuthIdentity({
      session: { userId: 'u1', deviceId: 'dev-session' },
      cached: { userId: 'u0', deviceId: 'dev-cached' },
      deviceKeysDeviceId: 'dev-keys',
    });
    expect(out.userId).toBe('u1');
    expect(out.deviceId).toBe('dev-session');
  });

  it('falls back to the cache when the store has no active session', () => {
    const out = resolveAuthIdentity({
      session: null,
      cached: { userId: 'u2', orgId: null, role: null, deviceId: 'dev-2' },
      deviceKeysDeviceId: null,
    });
    expect(out).toMatchObject({ userId: 'u2', deviceId: 'dev-2' });
  });

  it('keeps deviceId null when signed out and no keypair exists', () => {
    // Never fabricate a device: no session, no cache, no keys -> no deviceId.
    const out = resolveAuthIdentity({ deviceKeysDeviceId: null });
    expect(out).toEqual({
      userId: null,
      orgId: null,
      role: null,
      deviceId: null,
      email: null,
    });
  });

  it('does not invent a device for an anonymous session that has keys', () => {
    // Keys alone are not a session: userId stays null so callers can tell a
    // signed-out state apart from a signed-in one.
    const out = resolveAuthIdentity({ deviceKeysDeviceId: 'dev-9' });
    expect(out.userId).toBeNull();
    expect(out.deviceId).toBe('dev-9');
  });
});
