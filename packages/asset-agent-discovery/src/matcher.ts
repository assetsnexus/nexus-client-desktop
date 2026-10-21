/**
 * Local asset-agent matching + P2P route decision (Phase 10).
 *
 * The desktop may only prefer a LAN peer when it (a) is an asset agent the
 * caller actually has a contact for, (b) advertises **our** region, and (c) has
 * a usable route. Cross-region trust is never implicit, and mDNS presence is a
 * hint — never a grant — so a mismatched region is rejected outright.
 *
 * The whole decision is pure over already-discovered peers, so it is testable
 * without a socket.
 */

import type { DiscoveredPeer } from './txt.js';

export type AssetAgentContact = {
  /** Contact id, `<assetId>:<assetAgentKey>` (per the region's contact model). */
  id: string;
  assetId: string;
  agentKey?: string | null;
  name?: string | null;
};

export type LocalMatch = {
  contactId: string;
  assetId: string;
  peer: DiscoveredPeer;
  /** Route kind this peer resolves to, from the caller's region match. */
  routeKind: 'lan_mdns' | 'intranet';
  /** True when the asset advertises room hosting (a meeting/room peer). */
  hostsRooms: boolean;
};

export type MatchDecision = {
  matches: LocalMatch[];
  /** Peers dropped because their `region` is not ours (never trusted implicitly). */
  rejectedForeignRegion: DiscoveredPeer[];
  /** Peers that are ours but have no matching contact (visible, not usable). */
  unmatched: DiscoveredPeer[];
};

export type MatchOptions = {
  /** Our region slug; a peer must match it exactly. */
  region: string;
  /** The caller's asset-agent contacts. */
  contacts: AssetAgentContact[];
  /** Optional host classifier; defaults to loopback-only = intranet. */
  classifyRoute?: (peer: DiscoveredPeer) => 'lan_mdns' | 'intranet';
};

/** Default route kind: loopback/RFC1918 stays `intranet`, otherwise LAN mDNS. */
export function defaultClassifyRoute(peer: DiscoveredPeer): 'lan_mdns' | 'intranet' {
  const host = peer.host.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isLoopback || isPrivate ? 'intranet' : 'lan_mdns';
}

/**
 * Match discovered peers against the caller's asset-agent contacts, rejecting
 * foreign-region peers. Contacts are keyed by `assetId`.
 */
export function matchLocalAssetAgents(
  peers: DiscoveredPeer[],
  options: MatchOptions,
): MatchDecision {
  const classify = options.classifyRoute ?? defaultClassifyRoute;
  const byAsset = new Map<string, AssetAgentContact>();
  for (const c of options.contacts) {
    if (c.assetId) byAsset.set(c.assetId, c);
  }

  const matches: LocalMatch[] = [];
  const rejectedForeignRegion: DiscoveredPeer[] = [];
  const unmatched: DiscoveredPeer[] = [];

  for (const peer of peers) {
    if (peer.txt.region !== options.region) {
      rejectedForeignRegion.push(peer);
      continue;
    }
    const contact = byAsset.get(peer.txt.assetId);
    if (!contact) {
      unmatched.push(peer);
      continue;
    }
    matches.push({
      contactId: contact.id,
      assetId: peer.txt.assetId,
      peer,
      routeKind: classify(peer),
      hostsRooms: peer.txt.hostsRooms,
    });
  }

  return { matches, rejectedForeignRegion, unmatched };
}

/** Look up the local match for a specific contact id, if any. */
export function localMatchForContact(decision: MatchDecision, contactId: string): LocalMatch | null {
  return decision.matches.find((m) => m.contactId === contactId) ?? null;
}

/**
 * Should the desktop prefer the local path for this contact?
 *
 * The policy is deliberately conservative: only when the user enabled it, the
 * contact has a matching same-region peer, and that peer hosts rooms or is a
 * plain intranet peer (i.e. the asset node is reachable without the region hop).
 */
export function shouldPreferLocal(
  decision: MatchDecision,
  contactId: string,
  options: { enabled: boolean },
): boolean {
  if (!options.enabled) return false;
  const match = localMatchForContact(decision, contactId);
  return match != null;
}
