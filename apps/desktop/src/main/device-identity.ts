/**
 * Pure resolution of the identity the region sender must carry.
 *
 * The region's authorization layer rejects every authenticated, non-exempt
 * command whose identity has no `deviceId` (`'anx.device.register'` and the
 * handful of pre-device commands are the only exceptions). A session can end up
 * without one for two reasons: it was recorded before device registration, or
 * the process restarted and only the token survived in the identity store while
 * the in-memory identity cache was empty.
 *
 * This helper folds the three sources the main process has — the identity-store
 * session (the token authority), the auth manager's in-memory cache, and the
 * locally stored device keypair — into one identity, so `deviceId` is present
 * whenever the machine actually owns a device keypair.
 */

export type IdentityLike =
  | {
      userId?: string | null;
      orgId?: string | null;
      role?: string | null;
      deviceId?: string | null;
      email?: string | null;
    }
  | null
  | undefined;

export type ResolvedIdentity = {
  userId: string | null;
  orgId: string | null;
  role: string | null;
  deviceId: string | null;
  email?: string | null;
};

/**
 * Precedence: the active session record wins (it is what the token belongs to),
 * the in-memory cache is the fallback, and the device keypair supplies
 * `deviceId` when neither carries one. A signed-out call (every source empty)
 * resolves to an all-null identity so callers never fabricate a device.
 *
 * `deviceKeysDeviceId` must only be passed for a device the region has
 * *acknowledged* (`registeredAt` set): asserting an unknown device id makes the
 * region answer a device-validation 401, which is worse than sending none.
 */
export function resolveAuthIdentity(input: {
  session?: IdentityLike;
  cached?: IdentityLike;
  deviceKeysDeviceId?: string | null;
}): ResolvedIdentity {
  const base = input.session ?? input.cached ?? null;
  return {
    userId: base?.userId ?? null,
    orgId: base?.orgId ?? null,
    role: base?.role ?? null,
    deviceId: base?.deviceId ?? input.deviceKeysDeviceId ?? null,
    email: base?.email ?? null,
  };
}
