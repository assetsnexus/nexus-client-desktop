/**
 * Pure redaction + truncation for logs and the client-tool audit store.
 *
 * Both the local logger and the tool-audit entries run untrusted,
 * agent-supplied payloads through here before they are ever written to disk, so
 * a token, PIN, password or private key can never land in a log line or an audit
 * entry. Kept dependency-free (no `electron`, no `node:fs`) so it is trivially
 * unit-testable and safe to import from main and renderer alike.
 */

/** Marker substituted for any value whose key looks sensitive. */
export const REDACTED = '[redacted]';

/**
 * Compact (lower-cased, separators stripped) key names that are always
 * redacted. Covers tokens, passwords, PINs and private/secret keys; public keys
 * (e.g. `biometricPublicKey`) are intentionally left intact.
 */
const SENSITIVE_COMPACT = new Set([
  'password',
  'passphrase',
  'passwd',
  'pwd',
  'pin',
  'secret',
  'token',
  'apikey',
  'apisecret',
  'privatekey',
  'clientsecret',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'salt',
  'mnemonic',
  'otp',
  'jwt',
  'signature',
  'accesskey',
  'secretkey',
  'encryptionkey',
  'signingkey',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'authenticationtoken',
  // One-time credential shapes used by the login / 2FA / device-link flows. A
  // bare `code` key is only redacted when it is *exactly* `code` (below), while
  // the qualified names also match as substrings via `isSensitiveKey`'s regex,
  // so e.g. `twoFactorCode` / `verificationCode` cannot leak either.
  'code',
  'twofactorcode',
  'verificationcode',
  'logintoken',
  'challengetoken',
  'devicecode',
  'usercode',
]);

/** Lower-case a key and strip separators so `api_key`/`apiKey` compare equal. */
export function compactKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a property name looks like it carries a secret. Deliberately
 * over-inclusive (a redacted audit line is always preferable to a leaked one).
 */
export function isSensitiveKey(key: string): boolean {
  const compact = compactKey(key);
  if (!compact) return false;
  if (SENSITIVE_COMPACT.has(compact)) return true;
  return /(password|passphrase|passwd|secret|token|privatekey|apikey|credential|bearer)/.test(compact);
}

export type RedactOptions = {
  /** Stop descending past this depth (guards against pathological nesting). */
  maxDepth?: number;
  /** Keep at most this many array items. */
  maxArrayLength?: number;
};

/**
 * Deep-clone a value, replacing any sensitive-named property with `[redacted]`.
 * Cycles, `Date`s and `Error`s are normalised so the result always survives
 * `JSON.stringify`.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  const maxDepth = opts.maxDepth ?? 12;
  const maxArrayLength = opts.maxArrayLength ?? 500;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return '[max-depth]';
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) {
      const out = v.slice(0, maxArrayLength).map((item) => walk(item, depth + 1));
      if (v.length > maxArrayLength) out.push(`… ${v.length - maxArrayLength} more`);
      return out;
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(v as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(nested, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string (works in both main and renderer TS configs). */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Cap for a single redacted arg/result value in an audit entry. */
export const AUDIT_VALUE_MAX_BYTES = 8 * 1024;

export type TruncatedValue = {
  value: unknown;
  truncated: boolean;
  bytes: number;
};

/**
 * Serialise a (already redacted) value and, when it exceeds `maxBytes`, replace
 * it with a bounded preview object so one huge tool payload cannot bloat the
 * audit file. Returns the byte size either way so retention can account for it.
 */
export function truncateForAudit(value: unknown, maxBytes = AUDIT_VALUE_MAX_BYTES): TruncatedValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null) ?? 'null';
  } catch {
    serialized = '"[unserializable]"';
  }
  const bytes = byteLength(serialized);
  if (bytes <= maxBytes) return { value: value ?? null, truncated: false, bytes };
  return {
    value: { __auditTruncated: true, bytes, preview: serialized.slice(0, maxBytes) },
    truncated: true,
    bytes,
  };
}
