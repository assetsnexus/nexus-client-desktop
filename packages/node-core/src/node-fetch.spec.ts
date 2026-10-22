import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createNodeFetch } from './node-fetch.js';

const servers: Server[] = [];
const CERT_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('createNodeFetch', () => {
  it('returns the global fetch when no CA and no insecure flag', () => {
    expect(createNodeFetch({})).toBe(fetch);
    expect(createNodeFetch({ caPem: '   ' })).toBe(fetch);
  });

  it('performs a plain http request (no CA needed)', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    const port = await listen(server);
    const fetchFn = createNodeFetch({ caPem: 'unused-for-http' });
    const res = await fetchFn(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ path: '/health', method: 'GET' });
  });

  it('POSTs a body and reports non-2xx without throwing', async () => {
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        res.writeHead(418, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: Buffer.concat(chunks).toString('utf8') }));
      });
    });
    const port = await listen(server);
    const fetchFn = createNodeFetch({ caPem: 'unused-for-http' });
    const res = await fetchFn(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'anx.auth.login' }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ received: '{"command":"anx.auth.login"}' });
  });

  it('follows a redirect to a GET and drops the body', async () => {
    const server = createHttpServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`method=${req.method}`);
    });
    const port = await listen(server);
    const fetchFn = createNodeFetch({ caPem: 'unused-for-http' });
    const res = await fetchFn(`http://127.0.0.1:${port}/start`, {
      method: 'POST',
      body: 'payload',
    });
    expect(await res.text()).toBe('method=GET');
  });

  it('trusts a self-signed cert when its CA is supplied, and rejects it otherwise', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    // A self-signed cert for 127.0.0.1 signed by this key.
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'nodefetch-'));
    const keyPath = join(dir, 'k.pem');
    const certPath = join(dir, 'c.pem');
    writeFileSync(keyPath, keyPem);
    execFileSync('openssl', [
      'req', '-x509', '-new', '-key', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ]);
    const certPem = readFileSync(certPath, 'utf8');

    const server = createHttpsServer({ key: keyPem, cert: certPem }, (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const port = await listen(server);

    // With the matching CA: trusted.
    const trusted = createNodeFetch({ caPem: certPem });
    const res = await trusted(`https://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    // With an unrelated CA: verification must fail (never silently accept).
    const untrusted = createNodeFetch({ caPem: CERT_A });
    await expect(untrusted(`https://127.0.0.1:${port}/`)).rejects.toBeTruthy();
  });
});
