import { describe, expect, it } from 'vitest';
import {
  AUDIT_VALUE_MAX_BYTES,
  REDACTED,
  compactKey,
  isSensitiveKey,
  redactValue,
  truncateForAudit,
} from './redaction.js';

describe('redaction — sensitive key detection', () => {
  it('flags tokens, passwords, PINs and private keys regardless of separators/case', () => {
    for (const key of [
      'token',
      'accessToken',
      'access_token',
      'apiKey',
      'API-KEY',
      'password',
      'passphrase',
      'pin',
      'privateKey',
      'client_secret',
      'authorization',
      'refresh-token',
      'sessionToken',
    ]) {
      expect(isSensitiveKey(key), `${key} should be sensitive`).toBe(true);
    }
  });

  it('leaves harmless and public-key names intact', () => {
    for (const key of ['name', 'path', 'content', 'argv', 'biometricPublicKey', 'publicKey', 'email']) {
      expect(isSensitiveKey(key), `${key} should NOT be sensitive`).toBe(false);
    }
  });

  it('flags the login / 2FA / device-link one-time credential shapes', () => {
    for (const key of [
      'code',
      'twoFactorCode',
      'verification_code',
      'loginToken',
      'challengeToken',
      'deviceCode',
      'userCode',
    ]) {
      expect(isSensitiveKey(key), `${key} should be sensitive`).toBe(true);
    }
    // A `code`-like name that is not a credential stays readable.
    for (const key of ['countryCode', 'errorCode', 'statusCode']) {
      expect(isSensitiveKey(key), `${key} should NOT be sensitive`).toBe(false);
    }
  });

  it('normalises keys by stripping separators', () => {
    expect(compactKey('API Key')).toBe('apikey');
    expect(compactKey('api_key')).toBe('apikey');
  });
});

describe('redactValue', () => {
  it('replaces sensitive properties at any depth, including inside arrays', () => {
    const out = redactValue({
      name: 'keep',
      apiKey: 'sk-live-123',
      nested: { password: 'hunter2', list: [{ token: 'abc' }, { ok: true }] },
    }) as Record<string, unknown>;

    expect(out.name).toBe('keep');
    expect(out.apiKey).toBe(REDACTED);
    const nested = out.nested as Record<string, unknown>;
    expect(nested.password).toBe(REDACTED);
    const list = nested.list as Array<Record<string, unknown>>;
    expect(list[0]!.token).toBe(REDACTED);
    expect(list[1]!.ok).toBe(true);
  });

  it('never emits an actual secret in the serialised output', () => {
    const serialized = JSON.stringify(redactValue({ token: 'super-secret-value', pin: '1234' }));
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('1234');
  });

  it('survives cycles without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redactValue(cyclic))).not.toThrow();
  });

  it('normalises Date and Error to serialisable shapes', () => {
    const out = redactValue({ when: new Date('2026-01-02T03:04:05.000Z'), err: new Error('boom') }) as {
      when: string;
      err: { name: string; message: string };
    };
    expect(out.when).toBe('2026-01-02T03:04:05.000Z');
    expect(out.err).toEqual({ name: 'Error', message: 'boom' });
  });
});

describe('truncateForAudit', () => {
  it('passes small values through unchanged', () => {
    const result = truncateForAudit({ a: 1 });
    expect(result.truncated).toBe(false);
    expect(result.value).toEqual({ a: 1 });
  });

  it('bounds an oversized payload into a preview object', () => {
    const huge = { big: 'x'.repeat(AUDIT_VALUE_MAX_BYTES + 100) };
    const result = truncateForAudit(huge);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(AUDIT_VALUE_MAX_BYTES);
    const value = result.value as { __auditTruncated: boolean; preview: string };
    expect(value.__auditTruncated).toBe(true);
    expect(value.preview.length).toBeLessThanOrEqual(AUDIT_VALUE_MAX_BYTES);
  });
});
