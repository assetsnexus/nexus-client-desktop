import { describe, expect, it, vi } from 'vitest';
import { browseAnxPeers, type MdnsBackend } from './browser.js';

function fakeBackend(services: Array<{ name: string; host: string; port: number; txt: Record<string, string> }>) {
  let stopped = false;
  const backend: MdnsBackend = {
    browse: vi.fn((_type, onService) => {
      for (const s of services) onService(s);
      return () => {
        stopped = true;
      };
    }),
  };
  return { backend, wasStopped: () => stopped };
}

describe('browseAnxPeers', () => {
  it('collects and de-duplicates peers by instance name', async () => {
    const { backend, wasStopped } = fakeBackend([
      { name: 'asset-1._anx._tcp.local.', host: '10.0.0.5', port: 8443, txt: { assetId: 'asset-1', region: 'w', fp: 'x' } },
      { name: 'asset-1._anx._tcp.local.', host: '10.0.0.5', port: 8443, txt: { assetId: 'asset-1', region: 'w', fp: 'x' } },
      { name: 'asset-2._anx._tcp.local.', host: '10.0.0.6', port: 8443, txt: { assetId: 'asset-2', region: 'w', fp: 'y' } },
    ]);
    const peers = await browseAnxPeers(backend, { durationMs: 10 });
    expect(peers.map((p) => p.txt.assetId).sort()).toEqual(['asset-1', 'asset-2']);
    expect(wasStopped()).toBe(true);
  });

  it('drops malformed services', async () => {
    const { backend } = fakeBackend([
      { name: 'bad', host: 'h', port: 0, txt: {} },
      { name: 'good', host: 'h', port: 8443, txt: { assetId: 'a', region: 'r', fp: 'x' } },
    ]);
    const peers = await browseAnxPeers(backend, { durationMs: 10 });
    expect(peers).toHaveLength(1);
    expect(peers[0].txt.assetId).toBe('a');
  });

  it('resolves an empty list when the backend throws (mDNS unavailable)', async () => {
    const backend: MdnsBackend = {
      browse: () => {
        throw new Error('no multicast');
      },
    };
    expect(await browseAnxPeers(backend, { durationMs: 10 })).toEqual([]);
  });

  it('defaults to the _anx._tcp service type', async () => {
    const { backend } = fakeBackend([]);
    await browseAnxPeers(backend, { durationMs: 5 });
    expect(backend.browse).toHaveBeenCalledWith('_anx._tcp', expect.any(Function));
  });
});
