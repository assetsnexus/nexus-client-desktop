/**
 * Renderer custom-CA trust — the regression behind "Failed to fetch".
 *
 * After login against a self-signed region, the renderer's conversations /
 * contacts lists showed `Failed to fetch` because the verify proc could not
 * recognise the region's certificate: Chromium presents only the leaf, so the
 * old fingerprint-vs-CA-bundle comparison never matched and the connection was
 * rejected. These tests exercise the exact deny/accept decision the proc makes,
 * using real certificates.
 */

import { describe, expect, it } from 'vitest';
import { certificateFingerprints } from '@nexus/node-core';
import { ACCEPT, createCustomCaVerifier, type VerifyRequest } from './custom-ca.js';

// CA + leaf signed by it (openssl). Kept in sync with
// `packages/node-core/src/tls.spec.ts`.
const CA = `-----BEGIN CERTIFICATE-----
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

const LEAF = `-----BEGIN CERTIFICATE-----
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

const verifier = (caPem = CA) => createCustomCaVerifier(caPem, certificateFingerprints(caPem));

const request = (leafPem: string, hostname: string, extra: Partial<VerifyRequest> = {}): VerifyRequest => ({
  hostname,
  verificationResult: 'CERT_AUTHORITY_INVALID',
  errorCode: -202,
  certificate: { data: leafPem },
  ...extra,
});

describe('createCustomCaVerifier', () => {
  it('accepts the region leaf even though Chromium presents no issuer chain', () => {
    // This is the fix: `issuerCert` is absent, so the old fingerprint pin
    // rejected the connection and every renderer fetch failed.
    expect(verifier()(request(LEAF, 'alexlab-ws-i9'))).toBe(ACCEPT);
  });

  it('accepts the leaf for an IP-literal host', () => {
    expect(verifier()(request(LEAF, '127.0.0.1'))).toBe(ACCEPT);
  });

  it('rejects a leaf signed by a CA we were not told to trust', () => {
    expect(verifier()(request(FOREIGN_LEAF, 'alexlab-ws-i9'))).toBe(-202);
  });

  it('rejects a trusted-CA leaf for the wrong host', () => {
    expect(verifier()(request(LEAF, 'evil.example.com'))).toBe(-202);
  });

  it('still accepts a public chain Chromium already verified', () => {
    const decide = verifier();
    // No leaf data (nothing presented) but Chromium reports OK.
    expect(decide({ hostname: 'region.example', verificationResult: 'OK' })).toBe(ACCEPT);
  });

  it('propagates Chromium error code when nothing matches', () => {
    const decide = verifier();
    expect(decide({ hostname: 'region.example', verificationResult: 'CERT_AUTHORITY_INVALID', errorCode: -202 })).toBe(-202);
  });

  it('defaults to a rejection when no error code is supplied', () => {
    const decide = verifier();
    expect(decide({ hostname: 'region.example', verificationResult: 'CERT_AUTHORITY_INVALID' })).toBe(-2);
  });

  it('accepts the leaf when Chromium supplies it as one of the trusted prints', () => {
    // Chain was fully presented (e.g. an OS-installed CA): the fingerprint fast
    // path must still succeed.
    const decide = createCustomCaVerifier(CA, certificateFingerprints(CA));
    expect(decide({ hostname: 'anything', certificate: { data: CA } })).toBe(ACCEPT);
  });

  it('never accepts a malformed certificate blob', () => {
    expect(verifier()({ hostname: 'alexlab-ws-i9', certificate: { data: 'not a cert' }, errorCode: -202 })).toBe(-202);
  });
});
