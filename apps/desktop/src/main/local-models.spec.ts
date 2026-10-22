import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_BACKENDS,
  comfyQueueUrl,
  comfySystemStatsUrl,
  normalizeLocalBackend,
  normalizeLocalBackends,
  ollamaPsUrl,
  ollamaTagsUrl,
  parseComfyQueue,
  parseOllamaLoaded,
  parseOllamaModels,
  probeBackend,
  probeLocalModels,
  selectRoutableBackend,
  validateBackendUrl,
  type JsonRequest,
} from './local-models.js';
import type { LocalModelBackend, LocalModelBackendStatus } from '../shared/ipc.js';

const ollama = DEFAULT_LOCAL_BACKENDS[0]!;
const comfy = DEFAULT_LOCAL_BACKENDS[1]!;

/** A request stub keyed by URL suffix, so a probe's two calls are independent. */
function routes(map: Record<string, { ok?: boolean; status?: number; body?: unknown }>): {
  request: JsonRequest;
  calls: Array<{ url: string; init: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const request: JsonRequest = async (url, init) => {
    calls.push({ url, init: init as Record<string, unknown> });
    for (const [suffix, res] of Object.entries(map)) {
      if (url.endsWith(suffix)) {
        return { ok: res.ok ?? true, status: res.status ?? 200, body: res.body ?? {} };
      }
    }
    return { ok: false, status: 404, body: {} };
  };
  return { request, calls };
}

function status(over: Partial<LocalModelBackendStatus>): LocalModelBackendStatus {
  return {
    backend: ollama,
    health: 'healthy',
    models: [],
    busy: false,
    loadedModels: [],
    checkedAt: 'now',
    ...over,
  };
}

describe('defaults', () => {
  it('seeds Ollama enabled and ComfyUI disabled, both without TLS relaxation', () => {
    expect(ollama.kind).toBe('ollama');
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(ollama.enabled).toBe(true);
    expect(comfy.kind).toBe('comfyui');
    expect(comfy.enabled).toBe(false);
    for (const b of DEFAULT_LOCAL_BACKENDS) {
      expect(b.ignoreTls).toBe(false);
      expect(b.apiKey).toBeNull();
      expect(b.customCaPem).toBeNull();
    }
  });
});

describe('endpoint builders', () => {
  it('builds each kind\u2019s endpoints and trims trailing slashes', () => {
    expect(ollamaTagsUrl('http://h:11434')).toBe('http://h:11434/api/tags');
    expect(ollamaTagsUrl('http://h:11434/')).toBe('http://h:11434/api/tags');
    expect(ollamaPsUrl('http://h:11434/')).toBe('http://h:11434/api/ps');
    expect(comfySystemStatsUrl('http://c:8188/')).toBe('http://c:8188/system_stats');
    expect(comfyQueueUrl('http://c:8188')).toBe('http://c:8188/queue');
  });
});

describe('parseOllamaModels', () => {
  it('maps names and sizes', () => {
    const rows = parseOllamaModels({
      models: [{ name: 'llama3:8b', size: 4_700_000_000 }, { name: 'qwen2.5' }],
    });
    expect(rows).toEqual([
      { id: 'llama3:8b', name: 'llama3:8b', sizeBytes: 4_700_000_000 },
      { id: 'qwen2.5', name: 'qwen2.5', sizeBytes: null },
    ]);
  });

  it('tolerates missing or malformed payloads', () => {
    expect(parseOllamaModels(null)).toEqual([]);
    expect(parseOllamaModels({})).toEqual([]);
    expect(parseOllamaModels({ models: 'nope' })).toEqual([]);
    expect(parseOllamaModels({ models: [{ size: 1 }, { name: '' }] })).toEqual([]);
  });
});

describe('parseOllamaLoaded', () => {
  it('reads the loaded model names, tolerating junk', () => {
    expect(parseOllamaLoaded({ models: [{ name: 'llama3' }, { model: 'qwen' }] })).toEqual([
      'llama3',
      'qwen',
    ]);
    expect(parseOllamaLoaded({})).toEqual([]);
    expect(parseOllamaLoaded(null)).toEqual([]);
    expect(parseOllamaLoaded({ models: [null, { name: '' }] })).toEqual([]);
  });
});

describe('parseComfyQueue', () => {
  it('summarises running + pending and derives busy', () => {
    expect(parseComfyQueue({ queue_running: [[], []], queue_pending: [[]] })).toEqual({
      running: 2,
      pending: 1,
      busy: true,
    });
    expect(parseComfyQueue({ queue_running: [], queue_pending: [] })).toEqual({
      running: 0,
      pending: 0,
      busy: false,
    });
    expect(parseComfyQueue(null)).toEqual({ running: 0, pending: 0, busy: false });
  });
});

describe('probeBackend', () => {
  it('reports healthy with models and not busy when Ollama is idle', async () => {
    const { request } = routes({
      '/api/tags': { body: { models: [{ name: 'llama3' }] } },
      '/api/ps': { body: { models: [] } },
    });
    const out = await probeBackend(ollama, { request });
    expect(out.health).toBe('healthy');
    expect(out.models).toHaveLength(1);
    expect(out.busy).toBe(false);
    expect(out.backend.id).toBe('ollama-local');
  });

  it('marks Ollama busy and lists loaded models', async () => {
    const { request } = routes({
      '/api/tags': { body: { models: [{ name: 'llama3' }] } },
      '/api/ps': { body: { models: [{ name: 'llama3' }] } },
    });
    const out = await probeBackend(ollama, { request });
    expect(out.busy).toBe(true);
    expect(out.loadedModels).toEqual(['llama3']);
  });

  it('stays healthy when the best-effort ps probe fails', async () => {
    const { request } = routes({
      '/api/tags': { body: { models: [] } },
      '/api/ps': { ok: false, status: 500 },
    });
    const out = await probeBackend(ollama, { request });
    expect(out.health).toBe('healthy');
    expect(out.busy).toBe(false);
    expect(out.detail).toContain('500');
  });

  it('reports unreachable on a non-ok tags response', async () => {
    const { request } = routes({ '/api/tags': { ok: false, status: 500 } });
    const out = await probeBackend(ollama, { request });
    expect(out.health).toBe('unreachable');
    expect(out.detail).toBe('HTTP 500');
  });

  it('reports unreachable on transport failure', async () => {
    const request: JsonRequest = async () => {
      throw new Error('ECONNREFUSED');
    };
    const out = await probeBackend(ollama, { request });
    expect(out.health).toBe('unreachable');
    expect(out.detail).toContain('ECONNREFUSED');
  });

  it('never probes a disabled instance', async () => {
    const request = vi.fn();
    const out = await probeBackend(comfy, { request: request as unknown as JsonRequest });
    expect(out.health).toBe('disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('probes ComfyUI health and queue', async () => {
    const enabled: LocalModelBackend = { ...comfy, enabled: true };
    const { request } = routes({
      '/system_stats': { body: { system: {} } },
      '/queue': { body: { queue_running: [[]], queue_pending: [] } },
    });
    const out = await probeBackend(enabled, { request });
    expect(out.health).toBe('healthy');
    expect(out.busy).toBe(true);
    expect(out.detail).toContain('1 running');
  });

  it('passes the instance TLS + key policy through to the request', async () => {
    const secure: LocalModelBackend = {
      ...ollama,
      baseUrl: 'https://rig.local:11434',
      ignoreTls: true,
      apiKey: 'secret',
    };
    const { request, calls } = routes({
      '/api/tags': { body: { models: [] } },
      '/api/ps': { body: { models: [] } },
    });
    await probeBackend(secure, { request });
    expect(calls[0]!.init.ignoreTls).toBe(true);
    expect(calls[0]!.init.apiKey).toBe('secret');
  });
});

describe('selectRoutableBackend', () => {
  const a = status({ backend: { ...ollama, id: 'a' } });
  const b = status({ backend: { ...ollama, id: 'b' } });
  const busyB = status({ backend: { ...ollama, id: 'b' }, busy: true, loadedModels: ['m'] });
  const down = status({ backend: { ...ollama, id: 'c' }, health: 'unreachable' });

  it('returns null when nothing is healthy', () => {
    expect(selectRoutableBackend([down]).backendId).toBeNull();
    expect(selectRoutableBackend([]).backendId).toBeNull();
  });

  it('first_available prefers the first idle healthy instance', () => {
    expect(selectRoutableBackend([busyB, a]).backendId).toBe('a');
    expect(selectRoutableBackend([a, b]).backendId).toBe('a');
  });

  it('falls back to a busy instance when none are idle', () => {
    expect(selectRoutableBackend([busyB]).backendId).toBe('b');
  });

  it('least_busy picks the instance with the least in-flight work', () => {
    const veryBusy = status({
      backend: { ...ollama, id: 'v' },
      busy: true,
      loadedModels: ['1', '2', '3'],
    });
    const out = selectRoutableBackend([veryBusy, busyB], { policy: 'least_busy' });
    expect(out.backendId).toBe('b');
  });

  it('round_robin rotates across the idle pool and wraps', () => {
    const first = selectRoutableBackend([a, b], { policy: 'round_robin', cursor: 0 });
    expect(first.backendId).toBe('a');
    const second = selectRoutableBackend([a, b], { policy: 'round_robin', cursor: first.nextCursor });
    expect(second.backendId).toBe('b');
    const third = selectRoutableBackend([a, b], { policy: 'round_robin', cursor: second.nextCursor });
    expect(third.backendId).toBe('a');
  });

  it('ignores unhealthy instances in every policy', () => {
    expect(selectRoutableBackend([down, a], { policy: 'first_available' }).backendId).toBe('a');
    expect(selectRoutableBackend([down, a], { policy: 'least_busy' }).backendId).toBe('a');
    expect(selectRoutableBackend([down, a], { policy: 'round_robin' }).backendId).toBe('a');
  });
});

describe('probeLocalModels', () => {
  it('returns a status per instance plus the routed target and policy', async () => {
    const { request } = routes({
      '/api/tags': { body: { models: [] } },
      '/api/ps': { body: { models: [] } },
    });
    const snapshot = await probeLocalModels(DEFAULT_LOCAL_BACKENDS, { request });
    expect(snapshot.backends).toHaveLength(2);
    expect(snapshot.backends[0]!.health).toBe('healthy');
    expect(snapshot.backends[1]!.health).toBe('disabled');
    expect(snapshot.routedBackendId).toBe('ollama-local');
    expect(snapshot.policy).toBe('first_available');
  });

  it('honours an explicit policy', async () => {
    const { request } = routes({
      '/api/tags': { body: { models: [] } },
      '/api/ps': { body: { models: [] } },
    });
    const snapshot = await probeLocalModels(DEFAULT_LOCAL_BACKENDS, {
      request,
      policy: 'round_robin',
    });
    expect(snapshot.policy).toBe('round_robin');
  });
});

describe('normalizeLocalBackend', () => {
  it('fills defaults and coerces types', () => {
    const out = normalizeLocalBackend({ baseUrl: 'http://h:11434' }, 2);
    expect(out).toEqual({
      id: expect.any(String),
      kind: 'ollama',
      label: 'ollama instance',
      baseUrl: 'http://h:11434',
      enabled: true,
      ignoreTls: false,
      apiKey: null,
      customCaPem: null,
    });
  });

  it('keeps an explicit id/kind/label and TLS opt-in', () => {
    const out = normalizeLocalBackend({
      id: 'rig',
      kind: 'comfyui',
      label: 'Rig',
      baseUrl: 'https://rig:8188',
      enabled: false,
      ignoreTls: true,
      apiKey: 'k',
      customCaPem: 'PEM',
    });
    expect(out).toEqual({
      id: 'rig',
      kind: 'comfyui',
      label: 'Rig',
      baseUrl: 'https://rig:8188',
      enabled: false,
      ignoreTls: true,
      apiKey: 'k',
      customCaPem: 'PEM',
    });
  });

  it('rejects entries without a base URL and unknown kinds', () => {
    expect(normalizeLocalBackend(null)).toBeNull();
    expect(normalizeLocalBackend({ baseUrl: '  ' })).toBeNull();
    expect(normalizeLocalBackend({ baseUrl: 'http://h', kind: 'nope' })!.kind).toBe('ollama');
  });
});

describe('normalizeLocalBackends', () => {
  it('drops unusable + duplicate entries', () => {
    const out = normalizeLocalBackends([
      { id: 'a', baseUrl: 'http://a' },
      { id: 'a', baseUrl: 'http://a2' },
      { baseUrl: '' },
      { id: 'b', baseUrl: 'http://b' },
    ]);
    expect(out.map((b) => b.id)).toEqual(['a', 'b']);
    expect(out[0]!.baseUrl).toBe('http://a');
  });

  it('returns [] for junk', () => {
    expect(normalizeLocalBackends(null)).toEqual([]);
    expect(normalizeLocalBackends('nope')).toEqual([]);
  });
});

describe('validateBackendUrl', () => {
  it('accepts http/https and rejects the rest', () => {
    expect(validateBackendUrl('http://127.0.0.1:11434')).toBeNull();
    expect(validateBackendUrl('https://rig.local')).toBeNull();
    expect(validateBackendUrl('ftp://x')).toMatch(/http/);
    expect(validateBackendUrl('not a url')).toMatch(/valid URL/);
    expect(validateBackendUrl('')).toMatch(/Enter/);
  });
});
