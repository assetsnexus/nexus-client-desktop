import { describe, expect, it, vi } from 'vitest';
import { createRunnerHandler } from './handler.js';

function handler(over: Partial<Parameters<typeof createRunnerHandler>[0]> = {}) {
  return createRunnerHandler({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    apiKey: 'local-key',
    ...over,
  });
}

describe('runner handler auth', () => {
  it('rejects a missing or wrong bearer', async () => {
    const h = handler();
    expect((await h({ method: 'GET', path: '/v1/models', headers: {} })).status).toBe(401);
    expect(
      (await h({ method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });

  it('accepts the right bearer', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const h = handler({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await h({ method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer local-key' } });
    expect(res.status).toBe(200);
  });

  it('answers an unauthenticated health probe', async () => {
    const h = handler();
    const res = await h({ method: 'GET', path: '/health', headers: {} });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});

describe('runner handler forwarding', () => {
  it('forwards GET /v1/models to the upstream base', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('{"data":[{"id":"llama3"}]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const h = handler({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await h({
      method: 'GET',
      path: '/v1/models',
      headers: { authorization: 'Bearer local-key' },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(res.body).data[0].id).toBe('llama3');
  });

  it('forwards POST /v1/chat/completions with the body and upstream bearer', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const h = handler({ fetchFn: fetchFn as unknown as typeof fetch });
    const body = JSON.stringify({ model: 'llama3', messages: [] });
    const res = await h({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const [, init] = fetchFn.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', body });
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer local-key' });
  });

  it('rejects unknown paths and methods', async () => {
    const h = handler();
    expect(
      (await h({ method: 'GET', path: '/v1/secret', headers: { authorization: 'Bearer local-key' } })).status,
    ).toBe(404);
    expect(
      (await h({ method: 'DELETE', path: '/v1/models', headers: { authorization: 'Bearer local-key' } })).status,
    ).toBe(405);
  });

  it('maps an upstream transport failure to 502', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const h = handler({ fetchFn: fetchFn as unknown as typeof fetch });
    const res = await h({ method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer local-key' } });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.type).toBe('bad_gateway');
  });
});
