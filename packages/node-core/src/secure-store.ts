/**
 * Secure storage abstraction shared by the desktop app and the CLI.
 *
 * The desktop wires this to Electron `safeStorage` (OS keychain-backed
 * encryption); the CLI wires it to the OS keychain. Core logic only ever sees
 * this interface, so both hosts reuse it unchanged.
 */

/** A token/secret store keyed by an opaque string. */
export type SecureStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Well-known keys used by {@link SecureStore}. */
export const SECURE_KEYS = {
  /** Region auth token for the active identity. */
  token: 'auth.token',
  /** Device keypair JSON (private material). */
  deviceKeys: 'device.keys',
  /** Serialized connection config override. */
  connection: 'connection.config',
} as const;

/** Simple in-memory store for tests and headless runs. */
export function createMemorySecureStore(seed: Record<string, string> = {}): SecureStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/**
 * Namespace secure-store keys by identity so multiple local test accounts can
 * coexist (the temporary multi-account switcher keys by `userId`).
 */
export function scopedKey(base: string, subjectId: string | null | undefined): string {
  const id = typeof subjectId === 'string' && subjectId.trim() ? subjectId.trim() : 'default';
  return `${base}:${id}`;
}
