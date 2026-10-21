import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredPeer, MdnsBackend } from '@nexus/asset-agent-discovery';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}));

const { createAssetAgentDiscoveryManager } = await import('./asset-agent-discovery.js');

const dirs: string[] = [];
function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-asset-agent-'));
  dirs.push(dir);
  return join(dir, 'asset-agents.json');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function peer(over: Partial<DiscoveredPeer> & { assetId?: string; region?: string } = {}): DiscoveredPeer {
  return {
    name: over.name ?? 'asset-1._anx._tcp.local.',
    host: over.host ?? '192.168.1.20',
    port: over.port ?? 8443,
    ports: over.ports ?? [8443],
    txt: {
      assetId: over.assetId ?? 'asset-1',
      region: over.region ?? 'west.eu',
      fingerprint: 'aa:bb:cc',
      hostsRooms: over.txt?.hostsRooms ?? false,
      ports: '8443',
    },
  };
}

function backendFor(peers: DiscoveredPeer[]): MdnsBackend {
  return {
    browse: (_type, onService) => {
      for (const p of peers) {
        onService({
          name: p.name,
          host: p.host,
          port: p.port,
          txt: { ...p.txt, hostsRooms: p.txt.hostsRooms ? '1' : '0' },
        });
      }
      return () => undefined;
    },
  };
}

function manager(over: Partial<Parameters<typeof createAssetAgentDiscoveryManager>[0]> = {}) {
  const configPath = tempConfig();
  return createAssetAgentDiscoveryManager({
    configPath,
    scanDurationMs: 20,
    backend: backendFor([peer()]),
    resolveRegion: async () => 'west.eu',
    getContacts: async () => [{ id: 'asset-1:agent', assetId: 'asset-1', agentKey: 'agent' }],
    ...over,
  });
}

describe('asset-agent discovery manager', () => {
  it('defaults to local path disabled and empty', async () => {
    const m = manager();
    const snap = await m.snapshot();
    expect(snap.preferLocalEnabled).toBe(false);
    expect(snap.matches).toEqual([]);
    expect(snap.region).toBe('west.eu');
  });

  it('matches a same-region peer on scan', async () => {
    const m = manager();
    const snap = await m.scan();
    expect(snap.matches).toHaveLength(1);
    expect(snap.matches[0]).toMatchObject({ contactId: 'asset-1:agent', routeKind: 'intranet' });
  });

  it('reports a foreign-region peer as rejected and a stranger as unmatched', async () => {
    const m = manager({
      backend: backendFor([peer({ region: 'east.eu' }), peer({ name: 'x', assetId: 'asset-999' })]),
    });
    const snap = await m.scan();
    expect(snap.matches).toHaveLength(0);
    expect(snap.rejectedForeignRegion).toBe(1);
    expect(snap.unmatched).toBe(1);
  });

  it('persists the prefer-local toggle across manager instances', async () => {
    const configPath = tempConfig();
    const opts = {
      configPath,
      backend: backendFor([peer()]),
      resolveRegion: async () => 'west.eu',
      getContacts: async () => [{ id: 'asset-1:agent', assetId: 'asset-1' }],
    };
    const a = createAssetAgentDiscoveryManager(opts);
    await a.setPreferLocal(true);
    const b = createAssetAgentDiscoveryManager(opts);
    expect((await b.snapshot()).preferLocalEnabled).toBe(true);
  });

  it('reports "no active region" without hitting the backend', async () => {
    const browse = vi.fn(() => () => undefined);
    const m = manager({ resolveRegion: async () => null, backend: { browse } });
    const snap = await m.scan();
    expect(snap.region).toBeNull();
    expect(snap.detail).toMatch(/sign in/i);
    expect(browse).not.toHaveBeenCalled();
  });

  it('hasLocalPeer honours the toggle and match', async () => {
    const m = manager();
    expect(await m.hasLocalPeer('asset-1:agent')).toBe(false);
    await m.setPreferLocal(true);
    expect(await m.hasLocalPeer('asset-1:agent')).toBe(true);
    expect(await m.hasLocalPeer('asset-9:agent')).toBe(false);
  });

  it('degrades gracefully when the mDNS backend is absent', async () => {
    const m = manager({ backend: undefined });
    const snap = await m.scan();
    expect(snap.matches).toEqual([]);
    expect(snap.detail).toMatch(/not wired/i);
  });
});
