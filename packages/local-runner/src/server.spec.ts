import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:https';
import { mintLocalTls } from './tls.js';
import { startLocalRunnerServer, type LocalRunnerServer } from './server.js';

const servers: LocalRunnerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(over: { fetchFn?: typeof fetch } = {}) {
  const tls = await mintLocalTls({ days: 1 });
  const server = await startLocalRunnerServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    apiKey: 'local-key',
    keyPem: tls.keyPem,
    certPem: tls.certPem,
    fetchFn: over.fetchFn,
  });
  servers.push(server);
  return server;
}

/** Raw https client that ignores the self-signed loopback cert. */
function get(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startLocalRunnerServer', () => {
  it('binds loopback and reports a real port + /v1 endpoint', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.endpointUrl).toBe(`https://127.0.0.1:${server.port}/v1`);
  });

  it('serves the proxy over TLS and enforces the runner key', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('{"data":[{"id":"llama3"}]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const server = await start({ fetchFn: fetchFn as unknown as typeof fetch });

    const unauth = await get(server.port, '/v1/models', {});
    expect(unauth.status).toBe(401);

    const ok = await get(server.port, '/v1/models', { authorization: 'Bearer local-key' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).data[0].id).toBe('llama3');
  });

  it('closes idempotently', async () => {
    const server = await start();
    await server.close();
    await server.close();
  });
});
