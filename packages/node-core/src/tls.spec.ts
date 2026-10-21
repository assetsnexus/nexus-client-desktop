import { describe, expect, it } from 'vitest';
import { createHttpsAgent, looksLikePemCertificate, splitPemCertificates } from './tls.js';
import {
  createMemorySecureStore,
  scopedKey,
  SECURE_KEYS,
} from './secure-store.js';

const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const CERT_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';

describe('createHttpsAgent', () => {
  it('returns undefined when no CA and no insecure flag', () => {
    expect(createHttpsAgent({})).toBeUndefined();
    expect(createHttpsAgent({ caPem: '  ' })).toBeUndefined();
  });

  it('builds an agent when a CA is supplied', () => {
    const agent = createHttpsAgent({ caPem: CERT_A });
    expect(agent).toBeDefined();
    agent?.destroy();
  });

  it('builds an agent when allowInsecure is set', () => {
    const agent = createHttpsAgent({ allowInsecure: true });
    expect(agent).toBeDefined();
    agent?.destroy();
  });
});

describe('looksLikePemCertificate', () => {
  it('detects certificate blocks', () => {
    expect(looksLikePemCertificate(CERT_A)).toBe(true);
    expect(looksLikePemCertificate('not a cert')).toBe(false);
    expect(looksLikePemCertificate(null)).toBe(false);
  });
});

describe('splitPemCertificates', () => {
  it('returns each certificate block', () => {
    expect(splitPemCertificates(`${CERT_A}\n${CERT_B}`)).toEqual([CERT_A, CERT_B]);
  });

  it('returns an empty array for non-PEM input', () => {
    expect(splitPemCertificates('nope')).toEqual([]);
    expect(splitPemCertificates(undefined)).toEqual([]);
  });
});

describe('secure store', () => {
  it('stores, reads, and deletes values', async () => {
    const store = createMemorySecureStore();
    expect(await store.get('missing')).toBeNull();
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });

  it('seeds initial values', async () => {
    const store = createMemorySecureStore({ [SECURE_KEYS.token]: 'tok' });
    expect(await store.get(SECURE_KEYS.token)).toBe('tok');
  });
});

describe('scopedKey', () => {
  it('namespaces by subject id', () => {
    expect(scopedKey(SECURE_KEYS.token, 'u1')).toBe('auth.token:u1');
  });

  it('falls back to default when the subject is blank', () => {
    expect(scopedKey(SECURE_KEYS.token, null)).toBe('auth.token:default');
    expect(scopedKey(SECURE_KEYS.token, '   ')).toBe('auth.token:default');
  });
});
