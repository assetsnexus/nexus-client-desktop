import { describe, expect, it } from 'vitest';
import { parseAnxMdnsTxt, parsePorts, toDiscoveredPeer } from './txt.js';

describe('parseAnxMdnsTxt', () => {
  it('parses the asset contract TXT fields (case-insensitive keys)', () => {
    const txt = parseAnxMdnsTxt({
      assetid: 'asset-1',
      REGION: 'west.eu',
      fp: 'aa:bb:cc',
      hostsRooms: '1',
      ports: '8443,9000',
    });
    expect(txt).toEqual({
      assetId: 'asset-1',
      region: 'west.eu',
      fingerprint: 'aa:bb:cc',
      hostsRooms: true,
      ports: '8443,9000',
    });
  });

  it('accepts `fingerprint` as an alias and parses tuple-array props', () => {
    const txt = parseAnxMdnsTxt([
      ['assetId', 'a'],
      ['region', 'r'],
      ['fingerprint', 'fp'],
      ['hostsRooms', 'true'],
    ]);
    expect(txt?.fingerprint).toBe('fp');
    expect(txt?.hostsRooms).toBe(true);
  });

  it('rejects a record missing any trust field (mirrors the Rust parser)', () => {
    expect(parseAnxMdnsTxt({ assetId: 'a', region: 'r' })).toBeNull();
    expect(parseAnxMdnsTxt({ assetId: 'a', fp: 'x' })).toBeNull();
    expect(parseAnxMdnsTxt({})).toBeNull();
  });
});

describe('parsePorts', () => {
  it('keeps valid ports in order and drops junk', () => {
    expect(parsePorts('8443,9000')).toEqual([8443, 9000]);
    expect(parsePorts(' 8443 , , 70000, abc ')).toEqual([8443]);
    expect(parsePorts('')).toEqual([]);
  });
});

describe('toDiscoveredPeer', () => {
  it('builds a peer with the REST port first', () => {
    const peer = toDiscoveredPeer({
      name: 'asset-1._anx._tcp.local.',
      host: '192.168.1.20',
      port: 8443,
      txt: { assetId: 'asset-1', region: 'west.eu', fp: 'aa:bb', hostsRooms: '0', ports: '8443,9000' },
    });
    expect(peer).toMatchObject({ host: '192.168.1.20', port: 8443, ports: [8443, 9000] });
  });

  it('falls back to the service port when the TXT has no ports', () => {
    const peer = toDiscoveredPeer({
      name: 'p',
      host: '10.0.0.5',
      port: 8443,
      txt: { assetId: 'a', region: 'r', fp: 'x' },
    });
    expect(peer?.ports).toEqual([8443]);
  });

  it('returns null on a malformed record or no usable port', () => {
    expect(toDiscoveredPeer({ name: 'p', host: 'h', port: 0, txt: {} })).toBeNull();
    expect(
      toDiscoveredPeer({ name: 'p', host: 'h', port: 0, txt: { assetId: 'a', region: 'r', fp: 'x' } }),
    ).toBeNull();
  });
});
