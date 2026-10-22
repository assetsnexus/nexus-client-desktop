import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalModelsStore } from './local-models-store.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'local-models-'));
  const path = join(dir, 'local-models.json');
  return { store: createLocalModelsStore(path), path };
}

describe('createLocalModelsStore', () => {
  it('seeds the loopback defaults when no file exists', () => {
    const { store } = makeStore();
    const config = store.get();
    expect(config.instances.map((i) => i.id)).toEqual(['ollama-local', 'comfyui-local']);
    expect(config.policy).toBe('first_available');
  });

  it('adds a new instance and persists it', () => {
    const { store, path } = makeStore();
    const next = store.upsert({
      id: 'rig',
      kind: 'ollama',
      label: 'GPU box',
      baseUrl: 'https://rig.local:11434',
      ignoreTls: true,
    });
    expect(next.instances.map((i) => i.id)).toEqual(['ollama-local', 'comfyui-local', 'rig']);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { instances: unknown[] };
    expect(onDisk.instances).toHaveLength(3);
    expect(store.get().instances[2]!.ignoreTls).toBe(true);
  });

  it('replaces an existing instance by id rather than duplicating it', () => {
    const { store } = makeStore();
    store.upsert({ id: 'rig', baseUrl: 'http://a:1' });
    const out = store.upsert({ id: 'rig', baseUrl: 'http://b:2', enabled: false });
    expect(out.instances.filter((i) => i.id === 'rig')).toHaveLength(1);
    expect(out.instances.find((i) => i.id === 'rig')!.baseUrl).toBe('http://b:2');
    expect(out.instances.find((i) => i.id === 'rig')!.enabled).toBe(false);
  });

  it('rejects an instance without a base URL', () => {
    const { store } = makeStore();
    expect(() => store.upsert({ id: 'x', baseUrl: '  ' })).toThrow(/base URL/);
    expect(store.get().instances).toHaveLength(2);
  });

  it('removes an instance and can remove every instance', () => {
    const { store } = makeStore();
    expect(store.remove('comfyui-local').instances.map((i) => i.id)).toEqual(['ollama-local']);
    expect(store.remove('ollama-local').instances).toEqual([]);
    // An explicitly emptied list is respected, not re-seeded.
    expect(store.get().instances).toEqual([]);
  });

  it('persists the routing policy and coerces an unknown one', () => {
    const { store } = makeStore();
    expect(store.setPolicy('least_busy').policy).toBe('least_busy');
    expect(store.setPolicy('nonsense').policy).toBe('least_busy');
    expect(store.get().policy).toBe('least_busy');
  });

  it('recovers from a corrupt file without throwing', () => {
    const { store, path } = makeStore();
    store.get();
    writeFileSync(path, '{ not json');
    expect(store.get().instances).toHaveLength(2);
  });
});
