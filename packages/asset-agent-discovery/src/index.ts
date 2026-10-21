/**
 * `@nexus/asset-agent-discovery` — Phase 10 LAN/intranet asset-agent detection.
 *
 * Pure TXT parsing + region-guarded matching + route classification, with an
 * injectable mDNS browser. Nothing here dials the region or opens P2P; it only
 * answers "is one of my asset agents reachable on this LAN, and should the
 * desktop prefer that path?" The region path stays the default/fallback.
 */

export {
  parseAnxMdnsTxt,
  parsePorts,
  toDiscoveredPeer,
  type AnxMdnsTxt,
  type DiscoveredPeer,
  type MdnsService,
} from './txt.js';

export {
  defaultClassifyRoute,
  localMatchForContact,
  matchLocalAssetAgents,
  shouldPreferLocal,
  type AssetAgentContact,
  type LocalMatch,
  type MatchDecision,
  type MatchOptions,
} from './matcher.js';

export { ANX_SERVICE_TYPE, browseAnxPeers, type BrowseOptions, type MdnsBackend } from './browser.js';
