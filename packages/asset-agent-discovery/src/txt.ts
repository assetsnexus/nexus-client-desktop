/**
 * `_anx._tcp` mDNS TXT parsing (Phase 10).
 *
 * The asset node advertises itself on the LAN with a compact TXT record
 * (`crates/net/src/mdns.rs`): `assetId`, `region`, `fp`, `hostsRooms`, `ports`.
 * Those are **discovery hints only** — presence on the LAN is never a trust
 * grant, and a peer whose `region` does not match ours must be rejected.
 *
 * Parsing is pure so the whole matcher is testable without a network.
 */

export type AnxMdnsTxt = {
  assetId: string;
  region: string;
  /** Colon-separated SHA-256 fingerprint of the asset's TLS leaf. */
  fingerprint: string;
  hostsRooms: boolean;
  /** Comma-separated listening ports (REST first). */
  ports: string;
};

export type DiscoveredPeer = {
  /** mDNS instance name, e.g. `asset-12._anx._tcp.local.`. */
  name: string;
  host: string;
  port: number;
  txt: AnxMdnsTxt;
  /** All advertised ports, in the order the asset listed them (REST first). */
  ports: number[];
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Parse mDNS TXT properties (case-insensitive keys) into the structured record. */
export function parseAnxMdnsTxt(props: Record<string, string> | Array<[string, string]>): AnxMdnsTxt | null {
  const map = new Map<string, string>();
  const entries = Array.isArray(props) ? props : Object.entries(props);
  for (const [k, v] of entries) {
    if (typeof v === 'string') map.set(normalizeKey(k), v);
  }
  const get = (key: string) => map.get(normalizeKey(key));

  const assetId = get('assetId');
  const region = get('region');
  const fingerprint = get('fp') ?? get('fingerprint');
  if (!assetId || !region || !fingerprint) return null;

  const hostsRoomsRaw = get('hostsRooms');
  const hostsRooms = hostsRoomsRaw === '1' || hostsRoomsRaw === 'true' || hostsRoomsRaw === 'True';
  return { assetId, region, fingerprint, hostsRooms, ports: get('ports') ?? '' };
}

/** Split the comma-separated ports field into valid port numbers (REST first). */
export function parsePorts(ports: string): number[] {
  return ports
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

/**
 * Shape of one mDNS service result, decoupled from any specific mDNS library so
 * the browser adapter is a thin shim over `bonjour-service` / `mdns`.
 */
export type MdnsService = {
  name: string;
  host: string;
  port: number;
  txt: Record<string, string> | Array<[string, string]>;
};

/** Turn one raw mDNS service into a `DiscoveredPeer`, or null when malformed. */
export function toDiscoveredPeer(service: MdnsService): DiscoveredPeer | null {
  const txt = parseAnxMdnsTxt(service.txt ?? {});
  if (!txt) return null;
  const ports = parsePorts(txt.ports);
  // The service `port` is authoritative when the TXT has no port list.
  const resolvedPort = service.port > 0 ? service.port : ports[0];
  if (!resolvedPort) return null;
  return {
    name: service.name,
    host: service.host,
    port: resolvedPort,
    txt,
    ports: ports.length ? ports : [resolvedPort],
  };
}
