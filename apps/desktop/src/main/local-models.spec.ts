import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_BACKENDS,
  ollamaTagsUrl,
  parseOllamaModels,
  probeBackend,
  probeLocalModels,
} from './local-models.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ollama = DEFAULT_LOCAL_BACKENDS[0];
const comfy = DEFAULT_LOCAL_BACKENDS[1];

describe('defaults', () => {
  it('seeds Ollama enabled and ComfyUI disabled', () => {
    expect(ollama.kind).toBe('ollama');
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(ollama.enabled).toBe(true);
    expect(comfy.kind).toBe('comfyui');
    expect(comfy.enabled).toBe(false);
  });
});

describe('ollamaTagsUrl', () => {
  it('builds the tags endpoint and trims trailing slashes', () => {
    expect(ollamaTagsUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/api/tags');
    expect(ollamaTagsUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434/api/tags');
  });
});

describe('parseOllamaModels', () => {
  it('maps names and sizes', () => {
    const rows = parseOllamaModels({
      models: [
        { name: 'llama3:8b', size: 4_700_000_000 },
        { name: 'qwen2.5' },
      ],
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

describe('probeBackend', () => {
  it('reports healthy with models when Ollama answers', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: 'llama3' }] }));
    const status = await probeBackend(ollama, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(status.health).toBe('healthy');
    expect(status.models).toHaveLength(1);
    expect(status.backend.id).toBe('ollama-local');
  });

  it('reports unreachable on transport failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const status = await probeBackend(ollama, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(status.health).toBe('unreachable');
    expect(status.detail).toContain('ECONNREFUSED');
    expect(status.models).toEqual([]);
  });

  it('reports unreachable on a non-ok response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    const status = await probeBackend(ollama, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(status.health).toBe('unreachable');
    expect(status.detail).toBe('HTTP 500');
  });

  it('marks a disabled backend without probing', async () => {
    const fetchFn = vi.fn();
    const status = await probeBackend(comfy, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(status.health).toBe('disabled');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('times out to unreachable rather than hanging', async () => {
    const fetchFn = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const status = await probeBackend(ollama, {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(status.health).toBe('unreachable');
  });
});

describe('probeLocalModels', () => {
  it('returns a status per backend', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [] }));
    const snapshot = await probeLocalModels(DEFAULT_LOCAL_BACKENDS, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(snapshot.backends).toHaveLength(2);
    expect(snapshot.backends[0].health).toBe('healthy');
    expect(snapshot.backends[1].health).toBe('disabled');
  });
});
