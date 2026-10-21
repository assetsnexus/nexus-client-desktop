import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore, defaultConfigPath } from './config.js';
import { createFileSecureStore } from './store.js';

describe('defaultConfigPath', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/xdg/nexus/config.json',
    );
  });
});

describe('createConfigStore', () => {
  it('returns sandbox defaults when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-cfg-'));
    const store = createConfigStore(join(dir, 'config.json'));
    const config = store.get();
    expect(config.regionUrl).toContain('region.sandbox.assetsnexus.org');
    expect(config.gatewayUrl).toBe(config.regionUrl);
    expect(config.appId).toBe('nexus-desktop');
  });

  it('persists and re-reads an override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-cfg-'));
    const path = join(dir, 'config.json');
    const store = createConfigStore(path);
    store.set({ regionUrl: 'http://localhost:3000' });
    expect(createConfigStore(path).get().regionUrl).toBe('http://localhost:3000');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      regionUrl: 'http://localhost:3000',
    });
  });
});

describe('createFileSecureStore', () => {
  it('round-trips a value and deletes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sec-'));
    const store = createFileSecureStore(join(dir, 'secrets.json'));
    await store.set('auth.token', 'secret-value');
    expect(await store.get('auth.token')).toBe('secret-value');
    await store.delete('auth.token');
    expect(await store.get('auth.token')).toBeNull();
  });

  it('creates the secrets file with 0600 permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sec-'));
    const path = join(dir, 'secrets.json');
    const store = createFileSecureStore(path);
    await store.set('k', 'v');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('returns null for a missing key and tolerates corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sec-'));
    const path = join(dir, 'secrets.json');
    const store = createFileSecureStore(path);
    expect(await store.get('missing')).toBeNull();
    await store.set('a', 'b');
    await store.set('c', 'd');
    expect(await store.get('a')).toBe('b');
  });
});
