import { describe, expect, it } from 'vitest';
import { LOCAL_RUNNER_ALT_NAMES, mintLocalTls } from './tls.js';
import { X509Certificate } from 'node:crypto';

describe('mintLocalTls', () => {
  it('mints a parseable key + leaf pair', async () => {
    const tls = await mintLocalTls();
    expect(tls.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(tls.certPem).toContain('BEGIN CERTIFICATE');
    const cert = new X509Certificate(tls.certPem);
    expect(cert.subject).toContain('nexus-local-runner');
  });

  it('includes loopback alt names so https://localhost verifies', async () => {
    const tls = await mintLocalTls();
    const cert = new X509Certificate(tls.certPem);
    expect(tls.altNames).toEqual([...LOCAL_RUNNER_ALT_NAMES]);
    expect(cert.subjectAltName).toContain('DNS:localhost');
    expect(cert.subjectAltName).toContain('127.0.0.1');
  });

  it('reports an expiry and a fingerprint', async () => {
    const tls = await mintLocalTls({ days: 30 });
    expect(tls.notAfter).toBeTruthy();
    expect(tls.fingerprint).toBeTruthy();
  });
});
