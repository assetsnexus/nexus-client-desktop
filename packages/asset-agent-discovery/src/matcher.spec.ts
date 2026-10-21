import { describe, expect, it } from 'vitest';
import {
  defaultClassifyRoute,
  localMatchForContact,
  matchLocalAssetAgents,
  shouldPreferLocal,
} from './matcher.js';
import type { DiscoveredPeer } from './txt.js';

const peer = (over: Partial<DiscoveredPeer> & { assetId?: string; region?: string } = {}): DiscoveredPeer => ({
  name: over.name ?? `peer-${over.txt?.assetId ?? 'x'}`,
  host: over.host ?? '192.168.1.20',
  port: over.port ?? 8443,
  ports: over.ports ?? [8443],
  txt: {
    assetId: over.assetId ?? over.txt?.assetId ?? 'asset-1',
    region: over.region ?? over.txt?.region ?? 'west.eu',
    fingerprint: 'aa:bb:cc',
    hostsRooms: over.txt?.hostsRooms ?? false,
    ports: '8443',
    ...over.txt,
  },
});

const contacts = [{ id: 'asset-1:agent', assetId: 'asset-1', agentKey: 'agent', name: 'Tank robot' }];

describe('defaultClassifyRoute', () => {
  it('treats loopback and RFC1918 as intranet, others as lan_mdns', () => {
    expect(defaultClassifyRoute(peer({ host: '127.0.0.1' }))).toBe('intranet');
    expect(defaultClassifyRoute(peer({ host: '10.0.0.4' }))).toBe('intranet');
    expect(defaultClassifyRoute(peer({ host: '192.168.5.5' }))).toBe('intranet');
    expect(defaultClassifyRoute(peer({ host: '172.20.1.1' }))).toBe('intranet');
    expect(defaultClassifyRoute(peer({ host: '203.0.113.9' }))).toBe('lan_mdns');
  });
});

describe('matchLocalAssetAgents', () => {
  it('matches a same-region peer to a contact and classifies the route', () => {
    const d = matchLocalAssetAgents([peer({ assetId: 'asset-1', region: 'west.eu', host: '10.0.0.5' })], {
      region: 'west.eu',
      contacts,
    });
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]).toMatchObject({ contactId: 'asset-1:agent', routeKind: 'intranet' });
    expect(localMatchForContact(d, 'asset-1:agent')).not.toBeNull();
  });

  it('rejects a foreign-region peer (mDNS is never a trust grant)', () => {
    const d = matchLocalAssetAgents([peer({ assetId: 'asset-1', region: 'east.eu' })], {
      region: 'west.eu',
      contacts,
    });
    expect(d.matches).toHaveLength(0);
    expect(d.rejectedForeignRegion).toHaveLength(1);
  });

  it('surfaces a same-region peer with no matching contact as unmatched', () => {
    const d = matchLocalAssetAgents([peer({ assetId: 'asset-999', region: 'west.eu' })], {
      region: 'west.eu',
      contacts,
    });
    expect(d.matches).toHaveLength(0);
    expect(d.unmatched).toHaveLength(1);
  });

  it('reports a room-hosting peer', () => {
    const d = matchLocalAssetAgents(
      [peer({ assetId: 'asset-1', txt: { hostsRooms: true } as never })],
      { region: 'west.eu', contacts },
    );
    expect(d.matches[0].hostsRooms).toBe(true);
  });
});

describe('shouldPreferLocal', () => {
  it('prefers the local path only when enabled and matched', () => {
    const d = matchLocalAssetAgents([peer({ assetId: 'asset-1' })], { region: 'west.eu', contacts });
    expect(shouldPreferLocal(d, 'asset-1:agent', { enabled: true })).toBe(true);
    expect(shouldPreferLocal(d, 'asset-1:agent', { enabled: false })).toBe(false);
    expect(shouldPreferLocal(d, 'asset-2:agent', { enabled: true })).toBe(false);
  });
});
