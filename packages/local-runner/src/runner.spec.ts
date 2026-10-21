import { describe, expect, it, vi } from 'vitest';
import {
  LocalRunnerError,
  assertHttpsEndpoint,
  buildByokRegistration,
  idempotencyKeyFor,
  isLoopbackEndpoint,
  listLocalRunners,
  parseByokRegistration,
  registerLocalRunner,
  runnerAvailable,
} from './runner.js';

const config = {
  id: 'ollama-local',
  name: 'Local Ollama',
  endpointUrl: 'https://127.0.0.1:11435/v1',
  apiKey: 'local-key',
};

describe('assertHttpsEndpoint', () => {
  it('rejects plaintext http with the region-matching reason', () => {
    expect(() => assertHttpsEndpoint('http://127.0.0.1:11434/v1')).toThrow(LocalRunnerError);
    try {
      assertHttpsEndpoint('http://127.0.0.1:11434/v1');
    } catch (e) {
      expect((e as LocalRunnerError).code).toBe('insecure_endpoint');
    }
  });

  it('rejects a non-absolute URL', () => {
    expect(() => assertHttpsEndpoint('not-a-url')).toThrow(/not an absolute URL/);
  });

  it('accepts https', () => {
    expect(() => assertHttpsEndpoint('https://127.0.0.1:11435/v1')).not.toThrow();
  });
});

describe('isLoopbackEndpoint', () => {
  it('detects loopback hosts', () => {
    expect(isLoopbackEndpoint('https://127.0.0.1:1/v1')).toBe(true);
    expect(isLoopbackEndpoint('https://localhost/v1')).toBe(true);
    expect(isLoopbackEndpoint('https://[::1]/v1')).toBe(true);
    expect(isLoopbackEndpoint('https://gpu.example.com/v1')).toBe(false);
    expect(isLoopbackEndpoint('bogus')).toBe(false);
  });
});

describe('buildByokRegistration', () => {
  it('produces the region payload for an edge BYOK provider', () => {
    const payload = buildByokRegistration(config, { idempotencyKey: 'k1' });
    expect(payload).toEqual({
      scope: 'user',
      name: 'Local Ollama',
      kind: 'edge_gpu_sidecar',
      endpointUrl: 'https://127.0.0.1:11435/v1',
      apiKey: 'local-key',
      hostingType: 'edge_processing',
      idempotencyKey: 'k1',
    });
  });

  it('carries extra headers when present and defaults scope to user', () => {
    const payload = buildByokRegistration({ ...config, headers: { 'x-trace': '1' } }, { idempotencyKey: 'k1' });
    expect(payload.headers).toEqual({ 'x-trace': '1' });
    expect(payload.scope).toBe('user');
  });

  it('honors an org scope', () => {
    expect(buildByokRegistration(config, { scope: 'org', idempotencyKey: 'k1' }).scope).toBe('org');
  });

  it('requires a key and an idempotency key', () => {
    expect(() => buildByokRegistration({ ...config, apiKey: '' }, { idempotencyKey: 'k' })).toThrow(/apiKey/);
    expect(() => buildByokRegistration(config, { idempotencyKey: '' })).toThrow(/idempotencyKey/);
  });
});

describe('idempotencyKeyFor', () => {
  it('is stable for the same runner and changes with the endpoint', () => {
    const a = idempotencyKeyFor(config);
    expect(idempotencyKeyFor({ ...config })).toBe(a);
    expect(idempotencyKeyFor({ ...config, endpointUrl: 'https://127.0.0.1:9999/v1' })).not.toBe(a);
    expect(a.startsWith('local-runner:ollama-local:')).toBe(true);
  });
});

describe('parseByokRegistration', () => {
  it('reads provider/wrapper ids out of the `{ wrapper }` body', () => {
    const out = parseByokRegistration({
      responseCode: 200,
      responseObject: { wrapper: { providerId: 'p1', wrapperId: 'w1' } },
    });
    expect(out).toMatchObject({ providerId: 'p1', wrapperId: 'w1' });
  });

  it('tolerates a missing wrapper', () => {
    expect(parseByokRegistration({ responseObject: {} })).toMatchObject({ providerId: null, wrapperId: null });
  });
});

describe('registerLocalRunner', () => {
  it('sends anx.ai.byok.register with the built payload', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { wrapper: { providerId: 'p1', wrapperId: 'w1' } },
    }));
    const out = await registerLocalRunner(send as never, config);
    expect(out.providerId).toBe('p1');
    expect(send).toHaveBeenCalledWith(
      'anx.ai.byok.register',
      expect.objectContaining({ kind: 'edge_gpu_sidecar', hostingType: 'edge_processing' }),
    );
  });

  it('refuses to register an insecure endpoint before the round-trip', async () => {
    const send = vi.fn();
    await expect(
      registerLocalRunner(send as never, { ...config, endpointUrl: 'http://127.0.0.1:1/v1' }),
    ).rejects.toThrow(/https/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('listLocalRunners', () => {
  it('filters to edge_gpu_sidecar providers', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: {
        wrappers: [
          { providerId: 'p1', name: 'Local', kind: 'edge_gpu_sidecar', endpointUrl: 'https://127.0.0.1:1/v1' },
          { providerId: 'p2', name: 'OpenAI', kind: 'openai' },
        ],
      },
    }));
    const rows = await listLocalRunners(send as never);
    expect(rows).toEqual([
      { providerId: 'p1', name: 'Local', kind: 'edge_gpu_sidecar', endpointUrl: 'https://127.0.0.1:1/v1' },
    ]);
  });
});

describe('runnerAvailable', () => {
  it('is true only for the available state', () => {
    expect(runnerAvailable({ id: 'r', availability: 'available' })).toBe(true);
    expect(runnerAvailable({ id: 'r', availability: 'stopped' })).toBe(false);
    expect(runnerAvailable({ id: 'r', availability: 'error' })).toBe(false);
  });
});
