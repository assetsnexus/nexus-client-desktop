import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import {
  certificateFingerprint,
  certificateFingerprints,
  certificateValidity,
  createHttpsAgent,
  describeCertificate,
  isIpLiteral,
  looksLikePemCertificate,
  normalizeFingerprint,
  parseCertificates,
  splitPemCertificates,
  verifyLeafIssuedByCa,
} from './tls.js';
import {
  createMemorySecureStore,
  scopedKey,
  SECURE_KEYS,
} from './secure-store.js';

const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const CERT_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';

// ─── Real certificate fixtures for custom-CA verification ────────────────────
// A CA + a leaf signed by it, generated with openssl (see the commit that added
// `verifyLeafIssuedByCa`). Using real certs is the point: the regression this
// guards ("Failed to fetch" against a self-signed region) only reproduces with
// genuine signatures, not string fixtures.
const CA_A = `-----BEGIN CERTIFICATE-----
MIIDWzCCAkOgAwIBAgIUP9QjQTnzNcDZpJGsfgzIS72Ofo8wDQYJKoZIhvcNAQEL
BQAwNTEgMB4GA1UEAwwXQU5YIFRlc3QgUmVnaW9uIFJvb3QgQ0ExETAPBgNVBAoM
CEFOWCBUZXN0MB4XDTI2MTAyMjAyNTUwNVoXDTM2MTAxOTAyNTUwNVowNTEgMB4G
A1UEAwwXQU5YIFRlc3QgUmVnaW9uIFJvb3QgQ0ExETAPBgNVBAoMCEFOWCBUZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7NcrNWjxubKsdG5sXZCM
dt0ES5GWRFPT7lSdoL/UJryabjKuK3G0q1vbRxHt3lZ9Zb6j8f0XVHIbODwix1en
TyXJAeK60VTSt9+rtarDnCqk7q6TxXnUv/T+O6B++vrFdQcELpv9WV9TgS/ssh67
DW4ZnwhfkfWP8PKIQZNKK0yiGp5Nbi5CzWntb7RSd2wSP3M9YfUXRGK3fMgnYlwf
INGx6B2QD3pqZST0f9LVongsTxzBWPB0FkGdMbtnuN/whIBRGsmr2vFVx0I52yKB
YjsCm+5x+om0ffOBXdR9pU/vZF3X9y7KxpTkWZux6D3ctzRFjTCgybE5bDg8Jols
+QIDAQABo2MwYTAdBgNVHQ4EFgQUTXOQcWOwoLWADeBLY75IBfZClsEwHwYDVR0j
BBgwFoAUTXOQcWOwoLWADeBLY75IBfZClsEwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAAxeWLqTHmIC1C5k9a4IkQvq
+Zm/iEdua5h1miYI69NkZq83hycXTZZv3BtA1ajW1aMmvMIfwcXA7UD+xaTXB1Ad
2lpOsZNwU7+GDgPDj4scLfDkiuxCostOvzVu4pi/+kTy93//UIOGOjNY4ZTQA2+K
LAJY7TH/xrHp7tMnKpsBTWQ2rINvTWHSAJjvypC9STVVkinglOQN+Vadz3T4+uoI
w43GE4BJ0miq3/vpS24oX0hdzD3XFziB6bkvntzle77lKq4mJ1MSGx8yvQdJbNmz
1HLTNeCUIwohKBx2dLdDTAspMue4c1MoVjRPrPJYjdCR0praNJuSYgsFKhBnQWM=
-----END CERTIFICATE-----`;

const LEAF_A = `-----BEGIN CERTIFICATE-----
MIIDnzCCAoegAwIBAgIUNEGYXL8prLNHPxXGfE+9eWZhabswDQYJKoZIhvcNAQEL
BQAwNTEgMB4GA1UEAwwXQU5YIFRlc3QgUmVnaW9uIFJvb3QgQ0ExETAPBgNVBAoM
CEFOWCBUZXN0MB4XDTI2MTAyMjAyNTUwNVoXDTI5MDEyNDAyNTUwNVowKzEWMBQG
A1UEAwwNYWxleGxhYi13cy1pOTERMA8GA1UECgwIQU5YIFRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCPMWYyTJXgZdbRw/8K9V5uhVtizaOeeAAU
u2yzQcoFiWyo4VJ+5rJLRBMM76JnQXgwNQQIUvMC1Q6I4FFpsfroA42jXWp0v3kE
tN9QYombcMkqWxbMvBZxuWBpaBhKFsCWzw5DMiZwYNM9VeTVfTRisC5YSf/pox5j
CjZgnqGgClkLPyDcJRZHdY2kU2G2blaChNl1JfCctWFTpDkn3QAfLACgGk9KWUdo
Ft3cCtW8TrUI99X6pUYRuY+7+JLUMVz/7pIkf3oogAyt49rsebkBZ3NZE7GvxjrK
o7Bs66S9k80cYKeDKHu1CXk/5AVD3i7f/7iHD8A79gr838alGD9jAgMBAAGjgbAw
ga0wOwYDVR0RBDQwMoINYWxleGxhYi13cy1pOYIJbG9jYWxob3N0hwR/AAABhxAA
AAAAAAAAAAAAAAAAAAABMAkGA1UdEwQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1Ud
JQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBQWecu/5QvGhMCjACLYzMJJ9K2FJjAf
BgNVHSMEGDAWgBRNc5BxY7CgtYAN4EtjvkgF9kKWwTANBgkqhkiG9w0BAQsFAAOC
AQEAIoj+9cYCEJgwopEcVbuT0J+zwRVoyBHQUItv1sIklMRU7YfUHAJskz6lghyb
hHyopXy1Z9wJL4LLT4mrgxInZJMMLdmoSTqY25ou7MGrXt3dICRQrSGyaUKtCxlr
gChMeeeHc8c7q4gXhetDrHgMiz7kYuZ1KWgLu+qeStMUM2UJt8/ReROVZ26Sl5Lf
aHLiJpX0fHLp4Rbrf1ZRL3ESEl+PPIAkjXd13FZDPEYojzo4dH/nrfPUPd1Ba/AE
ZZULVuD9gMROtSoPDJYXZPzu/SVfev8i4MAy6ux2kiAsWQjljkAwWz+hbUKVAJqa
QwtZXsdxso0ISt5gsE9KPQCAgQ==
-----END CERTIFICATE-----`;

// A leaf signed by a *different* CA — must never be accepted for CA_A.
const FOREIGN_LEAF = `-----BEGIN CERTIFICATE-----
MIIDjzCCAnegAwIBAgIUQ8VCeQN0zUAyZ0Z896cOBk2Dm10wDQYJKoZIhvcNAQEL
BQAwKDEWMBQGA1UEAwwNT3RoZXIgUm9vdCBDQTEOMAwGA1UECgwFT3RoZXIwHhcN
MjYxMDIyMDI1NjExWhcNMjkwMTI0MDI1NjExWjAoMRYwFAYDVQQDDA1hbGV4bGFi
LXdzLWk5MQ4wDAYDVQQKDAVPdGhlcjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAKFU+ywYY/S6pdHCzINFsK8acxHdDo61ra7d8SRZj07f+h3Np8qSjMqA
3Yyev+KQhRwMhxDDNzBxi4FDwxuDgsunuj69YM29+TXg+ala3XKmNM2iam4BQP25
iGnIYkdhMWERZVF3OAgABjCs9MUKagVh38z+jqGgRiL5DMcXEsSD4wloB5t2b6A2
g0gS0dMyZp/vgJ0h4D3p3HlfFV/zT73hSDxU3OgyX0AfqZ9biKPhvXl0HshGg3/j
O+k9hlRmWNHQjXpzRfXbcAokLGScDHcWVGqqAvJvGrnd6YuG2mboPxlh+Lsm7H/g
/9/LpYz2OrEjPxwkzU/v05c3XpX7NlUCAwEAAaOBsDCBrTA7BgNVHREENDAygg1h
bGV4bGFiLXdzLWk5gglsb2NhbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEw
CQYDVR0TBAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEw
HQYDVR0OBBYEFHEvkpUMdXRwqG8/nploj9F30T1EMB8GA1UdIwQYMBaAFCirKFda
0BKL6zycI79i9lTvyuVaMA0GCSqGSIb3DQEBCwUAA4IBAQCoUw6Q5C4Xi4mSUCwD
eTSJ9lDLn/qsKZz9N6AIyBFr/o7/VMnY12rQIxpSHcpacwxC0CI9q4E4yqvu8k8e
D+ocXLkIV4u1Le+75R8HKFhW7LOoTBAkoLpjv4HCT37MvnDTIucc/teYY56NYO1R
NtLC/kk8CyysyDrsv4miQ3Prx8yalXtTnI/2MCvOG4DSTfG5iCFPbojblcOIiCnX
+D7bZCbSqlR9ti3eY/Z+fYjz5qMk5szoh/IioohYi//i69BOzOs4PUnNK4mqGVL3
Kyj0CgQ9c9t1NbV2Co8RpWIk+/+zBBYvkG+i7HjsxBmEeHnfj0Z6GAmqwAWJwSIK
Mp/7
-----END CERTIFICATE-----`;

// A self-signed *server* certificate (leaf IS its own CA), matching what a local
// region node often serves when no separate CA is installed.
const SELF_SIGNED = `-----BEGIN CERTIFICATE-----
MIIDTzCCAjegAwIBAgIUUu0Zay+vVFOzFS/8XXIAacakJA8wDQYJKoZIhvcNAQEL
BQAwJzEWMBQGA1UEAwwNYWxleGxhYi13cy1pOTENMAsGA1UECgwEU2VsZjAeFw0y
NjEwMjIwMjU2MTFaFw0zNjEwMTkwMjU2MTFaMCcxFjAUBgNVBAMMDWFsZXhsYWIt
d3MtaTkxDTALBgNVBAoMBFNlbGYwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQChk8HgoQWpYo0PLko3vEDRqBtiGqnvpjK9RT8yn6XQlK5NLbBxrW4SDLXl
b60qz0Zw7nZ2ObZbMY/JamAhN20a05+kvkR6mXMv3XQ8fcGBpCWyRgxF3Oj15e6A
yr1nR8aaVuoS6Buo5Feg8/I6P7+G5GWkH3WyjWHxt7mgKYansokKH1AOU//vfWLn
vXNm/fqksDnWcVMwTYGItUA9sT/Vu5Y07LoKUZr8kcLy/oc+VuL6rql/1lYMsl7C
BlyM1JJg0kCFom6I2D+crvIsHArsAsIsEoNvrAlKfY2nslNkPLnQoF9b57Ytr/EN
z5kNKfCLJA9LW3YTKySoyQ4gZQ7pAgMBAAGjczBxMB0GA1UdDgQWBBQBOHTceE9k
HsnaoCOj4yJbngKukDAfBgNVHSMEGDAWgBQBOHTceE9kHsnaoCOj4yJbngKukDAe
BgNVHREEFzAVgg1hbGV4bGFiLXdzLWk5hwR/AAABMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBACSYnhDc36eLmlQS3mQM96IZc1BX0dfrWcAsddbv
8HzL6irYxCEq4ewiIm6C1l1sAOn2Umoj5cpyKLn+Mg0RnNH8dUFRhesRgkMt9aOT
LtLSRtHQpYlVhx9YvUjgqrnnn+BBtNHjrUuRR+cuFsqDqfs/6j9CbOhuEQp7+gLy
vBdnfzaJFfHGNrddRKLmIaXOEEgO7ReUhMNWlhvhUX6jcYbDXfifi+1HeArMmzSO
dHCN9eLrhoWRp2/SR8+7ZMXjSpgJB7j2xAZ//xHpfHRC90fs8JmLXQZYs87uTKdH
SuVEgUbeMCmEqKt4yGGunEH6hgM7iA0/BfYBz2hwp8RZcPc=
-----END CERTIFICATE-----`;

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

describe('normalizeFingerprint', () => {
  it('strips separators and uppercases', () => {
    expect(normalizeFingerprint('ab:cd:ef')).toBe('ABCDEF');
    expect(normalizeFingerprint(' 12 34 ')).toBe('1234');
    expect(normalizeFingerprint(null)).toBe('');
  });
});

describe('certificateFingerprints', () => {
  // A real self-signed cert (generated with openssl) so X509Certificate parsing
  // succeeds and the fingerprint is deterministic.
  const REAL_CERT = `-----BEGIN CERTIFICATE-----
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
  const REAL_FP = '0DE3710D94B5007B60188242A92F66AAE8F661A940C31677779FD0D6B18FFF2B';

  it('returns an empty set for non-PEM input', () => {
    expect(certificateFingerprints('nope').size).toBe(0);
    expect(certificateFingerprints(undefined).size).toBe(0);
  });

  it('computes the SHA-256 fingerprint of a real certificate', () => {
    const fps = certificateFingerprints(REAL_CERT);
    expect(fps.size).toBe(1);
    expect([...fps][0]).toBe(REAL_FP);
  });

  it('skips malformed blocks without throwing', () => {
    expect(certificateFingerprints(`${CERT_A}\n${REAL_CERT}`).size).toBe(1);
  });
});

describe('verifyLeafIssuedByCa — the "Failed to fetch" root cause', () => {
  const now = new Date('2026-10-22T12:00:00.000Z');

  it('accepts a leaf that is genuinely signed by the configured CA', () => {
    // THE regression: Chromium presents only the leaf for a private CA, so the
    // old fingerprint-vs-CA-bundle comparison never matched. Signature
    // verification is what actually proves trust.
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: 'alexlab-ws-i9',
      now,
    });
    expect(verdict.ok).toBe(true);
  });

  it('accepts an IP-literal host present in the leaf SANs', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: '127.0.0.1',
      now,
    });
    expect(verdict.ok).toBe(true);
  });

  it('accepts a self-signed server certificate that is itself the configured CA', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(SELF_SIGNED),
      caPem: SELF_SIGNED,
      hostname: 'alexlab-ws-i9',
      now,
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a leaf signed by a different CA (never a blanket accept)', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(FOREIGN_LEAF),
      caPem: CA_A,
      hostname: 'alexlab-ws-i9',
      now,
    });
    expect(verdict).toEqual({ ok: false, reason: 'not-issued-by-ca' });
  });

  it('rejects when no CA is configured', () => {
    expect(
      verifyLeafIssuedByCa({ leaf: new X509Certificate(LEAF_A), caPem: null, now }),
    ).toEqual({ ok: false, reason: 'no-ca' });
  });

  it('rejects a host the leaf does not cover', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: 'evil.example.com',
      now,
    });
    expect(verdict).toEqual({ ok: false, reason: 'host-mismatch' });
  });

  it('rejects an expired leaf even when the signature is valid', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: 'alexlab-ws-i9',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a not-yet-valid leaf', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: 'alexlab-ws-i9',
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(verdict).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('skips a stale entry in a multi-cert bundle and uses the valid one', () => {
    // The self-signed server cert first (not a match for LEAF_A), then the CA.
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: `${SELF_SIGNED}\n${CA_A}`,
      hostname: 'alexlab-ws-i9',
      now,
    });
    expect(verdict.ok).toBe(true);
  });

  it('reports the leaf fingerprint on success', () => {
    const verdict = verifyLeafIssuedByCa({
      leaf: new X509Certificate(LEAF_A),
      caPem: CA_A,
      hostname: 'localhost',
      now,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.fingerprint).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe('parseCertificates', () => {
  it('parses each certificate in a bundle and skips malformed blocks', () => {
    expect(parseCertificates(`${CA_A}\n${CERT_A}`)).toHaveLength(1);
    expect(parseCertificates(null)).toHaveLength(0);
  });
});

describe('certificateValidity / describeCertificate — runtime-portable dates', () => {
  it('reads the validity window without relying on Node-22 validFromDate', () => {
    const cert = new X509Certificate(LEAF_A);
    // Simulate Electron 33's Node 20 where these accessors are absent.
    Object.defineProperty(cert, 'validFromDate', { value: undefined, configurable: true });
    Object.defineProperty(cert, 'validToDate', { value: undefined, configurable: true });
    const { from, to } = certificateValidity(cert);
    expect(Number.isFinite(from)).toBe(true);
    expect(Number.isFinite(to)).toBe(true);
    expect(from).toBeLessThan(to);
  });

  it('verifyLeafIssuedByCa does not throw when validFromDate is missing', () => {
    const cert = new X509Certificate(LEAF_A);
    Object.defineProperty(cert, 'validFromDate', { value: undefined, configurable: true });
    Object.defineProperty(cert, 'validToDate', { value: undefined, configurable: true });
    expect(() =>
      verifyLeafIssuedByCa({ leaf: cert, caPem: CA_A, hostname: 'alexlab-ws-i9', now: new Date('2026-10-22T12:00:00Z') }),
    ).not.toThrow();
    expect(
      verifyLeafIssuedByCa({ leaf: cert, caPem: CA_A, hostname: 'alexlab-ws-i9', now: new Date('2026-10-22T12:00:00Z') }).ok,
    ).toBe(true);
  });

  it('describeCertificate returns display facts and null for junk', () => {
    const details = describeCertificate(LEAF_A);
    expect(details?.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(details?.subject).toContain('CN=');
    expect(details?.validTo).toMatch(/^\d{4}-/);
    expect(describeCertificate('not a cert')).toBeNull();
    expect(describeCertificate(null)).toBeNull();
  });
});

describe('isIpLiteral', () => {
  it('distinguishes IP literals from DNS names', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('alexlab-ws-i9')).toBe(false);
    expect(isIpLiteral('example.com')).toBe(false);
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
