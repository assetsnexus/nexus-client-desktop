/**
 * Trust-decision core + trust store: the pure policy behind "trust this
 * certificate". Verifies the fail-closed defaults, the host+fingerprint scoping,
 * persistence, and that prompts coalesce instead of looping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCertificate } from '@nexus/node-core';
import {
  classifyCertFailure,
  createCertPromptBridge,
  createCertTrustStore,
  decideCertificateTrust,
  normalizeHost,
  pinKey,
  resolveCertRef,
} from './trusted-certs.js';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

// A real self-signed certificate (openssl), so fingerprinting exercises the
// actual X509 path. Kept in sync with `packages/node-core/src/tls.spec.ts`.
const SELF_SIGNED = `-----BEGIN CERTIFICATE-----
MIIC/zCCAeegAwIBAgIUI03yc0NqykImO9LAOz+pf+w9sSEwDQYJKoZIhvcNAQEL
BQAwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjEwMjEyMjE3NDNaFw0zNjEwMTgyMjE3
NDNaMA8xDTALBgNVBAMMBHRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCOK347SG41EU2SAz16akHbqJeBV0swnWyToYrucajI8G0zprG+wJq4eDLv
DlaB7v3TBCwgqsHRkG265uI3hkUretg0NLosxb3f0lxo9eyEGmRcl4AIL5g5FPiO
ThcMFFE0lBbKyKFzjl5QsJOBAV741q6S1l4qQOpBZYu8JoQX+VZb5OG/yWpEiHAB
oTqhAdvMcH+hWliJdAZobagejMHgvami04weQpY0b3QP0TIKew6XM6836YxEVItV
N/MQE+mZFBvymD388LjX/0qgnqWiJ13kEC6ZV9UDlVhO8HmpLG+Vhrk07r2ae8Mk
p3JPiNvng7EX6fWFGbpmvzng9/7hAgMBAAGjUzBRMB0GA1UdDgQWBBQksw1FaHV1
NrEkhiaBPmme0rKJiTAfBgNVHSMEGDAWgBQksw1FaHV1NrEkhiaBPmme0rKJiTAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAWrr032w5pb0n6gl4W
HSNE6NX9phKuOF3nMZDhHrXdnVCH1CmHrvJ9RAXOSxUU+8wA0qZ8dkKuyRJlMD+f
RxrF33JZ2le4JPM4LOjGOnx4WnVgw7w2c3XaKsUQPObEFcR1mbiou+9i8ZbbtsEP
LqJwbuGZFsnWgoSXAcnIRTz9IkZmHpcvu0sGfrFYOBggFSYOepChgJ6JDBkXyfOM
AO2cEhaeYiQZybSdfz9IxR9QWcotmPp3PpsDDeVcHQHeWdYV9NGsn6nUqVjKUiCj
+WqgtJzyZDpVO3pFb7FzhNFs5fbPIBrwQRW2NFBRlEa8IqpwUeY6867GpgRlvgRX
nzbv
-----END CERTIFICATE-----`;

const FP = describeCertificate(SELF_SIGNED)!.fingerprint;

const dirs: string[] = [];
function tmpStorePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'nexus-cert-'));
  dirs.push(d);
  return join(d, 'trusted-certs.json');
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const request = (hostname: string, data = SELF_SIGNED, verificationResult = 'CERT_AUTHORITY_INVALID') => ({
  hostname,
  certificate: { data },
  verificationResult,
});

describe('normalizeHost', () => {
  it('lowercases and strips port / IPv6 brackets', () => {
    expect(normalizeHost('Region.Example:3005')).toBe('region.example');
    expect(normalizeHost('[::1]:3005')).toBe('::1');
    expect(normalizeHost(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(normalizeHost('')).toBe('');
  });
});

describe('resolveCertRef', () => {
  it('resolves a host + real SHA-256 fingerprint from PEM data', () => {
    const ref = resolveCertRef(request('Region.Example:3005'));
    expect(ref?.host).toBe('region.example');
    expect(ref?.fingerprint).toBe(FP);
  });

  it('returns null when the host or certificate is unusable', () => {
    expect(resolveCertRef({ hostname: '', certificate: { data: SELF_SIGNED } })).toBeNull();
    expect(resolveCertRef({ hostname: 'h', certificate: { data: 'not a cert' } })).toBeNull();
  });
});

describe('classifyCertFailure', () => {
  it('maps Chromium verdicts to reasons', () => {
    expect(classifyCertFailure('CERT_AUTHORITY_INVALID')).toBe('authority-invalid');
    expect(classifyCertFailure('ERR_CERT_COMMON_NAME_INVALID')).toBe('name-mismatch');
    expect(classifyCertFailure('CERT_DATE_INVALID')).toBe('expired');
    expect(classifyCertFailure('')).toBe('unknown');
  });
});

describe('decideCertificateTrust', () => {
  const empty = { isTrusted: () => false };

  it('allows a chain Chromium already accepted', () => {
    expect(decideCertificateTrust(empty, { hostname: 'h', verificationResult: 'OK' })).toEqual({
      decision: 'allow',
    });
  });

  it('prompts on first sight of an unknown certificate', () => {
    const result = decideCertificateTrust(empty, request('region.example'));
    expect(result.decision).toBe('prompt');
    if (result.decision === 'prompt') {
      expect(result.info.host).toBe('region.example');
      expect(result.info.fingerprint).toBe(FP);
      expect(result.info.reason).toBe('authority-invalid');
    }
  });

  it('allows once the exact fingerprint is pinned for that host', () => {
    const store = { isTrusted: (host: string, fp: string) => host === 'region.example' && fp === FP };
    expect(decideCertificateTrust(store, request('region.example'))).toEqual({ decision: 'allow' });
  });

  it('still prompts for the same cert on a DIFFERENT host (scoped pin)', () => {
    const store = { isTrusted: (host: string, fp: string) => host === 'region.example' && fp === FP };
    expect(decideCertificateTrust(store, request('evil.example')).decision).toBe('prompt');
  });

  it('denies when the certificate cannot be scoped', () => {
    expect(decideCertificateTrust(empty, { hostname: 'h', verificationResult: 'CERT_AUTHORITY_INVALID' })).toEqual({
      decision: 'deny',
    });
    expect(decideCertificateTrust(empty, { hostname: '', certificate: { data: SELF_SIGNED } })).toEqual({
      decision: 'deny',
    });
  });
});

describe('createCertTrustStore', () => {
  it('persists a pin and survives a restart', () => {
    const path = tmpStorePath();
    const store = createCertTrustStore(path);
    expect(store.isTrusted('region.example', FP)).toBe(false);
    store.trust({ host: 'Region.Example', fingerprint: FP, subject: 'CN=test', issuer: 'CN=test', validFrom: null, validTo: null });
    expect(store.isTrusted('region.example', FP)).toBe(true);
    // New instance reads the same file.
    const reopened = createCertTrustStore(path);
    expect(reopened.isTrusted('region.example', FP)).toBe(true);
    expect(reopened.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  it('scopes trust to host AND fingerprint', () => {
    const store = createCertTrustStore(tmpStorePath());
    store.trust({ host: 'region.example', fingerprint: FP, subject: '', issuer: '', validFrom: null, validTo: null });
    expect(store.isTrusted('region.example', FP)).toBe(true);
    expect(store.isTrusted('other.example', FP)).toBe(false);
    expect(store.isTrusted('region.example', 'AB'.repeat(32))).toBe(false);
  });

  it('revokes by host (and optionally by fingerprint)', () => {
    const store = createCertTrustStore(tmpStorePath());
    store.trust({ host: 'region.example', fingerprint: FP, subject: '', issuer: '', validFrom: null, validTo: null });
    store.trust({ host: 'gw.example', fingerprint: FP, subject: '', issuer: '', validFrom: null, validTo: null });
    store.revoke('region.example');
    expect(store.isTrusted('region.example', FP)).toBe(false);
    expect(store.isTrusted('gw.example', FP)).toBe(true);
    store.revoke('gw.example', FP);
    expect(store.list()).toHaveLength(0);
  });

  it('ignores a malformed persisted file', () => {
    const store = createCertTrustStore('/dev/null/does-not-exist/trusted.json');
    expect(store.list()).toEqual([]);
  });
});

describe('createCertPromptBridge', () => {
  it('coalesces duplicate prompts and pins on approval', async () => {
    const store = createCertTrustStore(tmpStorePath());
    const onChanged = vi.fn();
    let resolveConfirm: (v: boolean) => void = () => {};
    const confirm = vi.fn(() => new Promise<boolean>((r) => (resolveConfirm = r)));
    const bridge = createCertPromptBridge({ store, confirm, onChanged });
    const info = { host: 'region.example', fingerprint: FP, subject: '', issuer: '', validFrom: null, validTo: null, verificationResult: 'CERT_AUTHORITY_INVALID', reason: 'authority-invalid' as const };

    bridge.requestTrust(info);
    bridge.requestTrust(info); // duplicate while open -> ignored
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bridge.pendingCount()).toBe(1);

    resolveConfirm(true);
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(0));
    expect(store.isTrusted('region.example', FP)).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not pin when the user cancels', async () => {
    const store = createCertTrustStore(tmpStorePath());
    const onChanged = vi.fn();
    const bridge = createCertPromptBridge({ store, confirm: async () => false, onChanged });
    bridge.requestTrust({ host: 'region.example', fingerprint: FP, subject: '', issuer: '', validFrom: null, validTo: null, verificationResult: 'CERT_AUTHORITY_INVALID', reason: 'authority-invalid' });
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(0));
    expect(store.isTrusted('region.example', FP)).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('pinKey normalizes host and fingerprint', () => {
    expect(pinKey('Region.Example:3005', FP.toLowerCase())).toBe(`region.example|${FP}`);
  });
});
