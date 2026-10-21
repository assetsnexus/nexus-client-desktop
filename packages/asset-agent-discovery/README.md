# @nexus/asset-agent-discovery

LAN / intranet asset-agent detection for the Nexus desktop (Phase 10).

Asset nodes advertise themselves on the local network over mDNS (`_anx._tcp`) with a
small TXT record:

| TXT field | Meaning |
| --- | --- |
| `assetId` | The asset instance id |
| `region` | Region slug the TLS leaf was issued under |
| `fp` | Colon-separated SHA-256 fingerprint of the TLS leaf |
| `hostsRooms` | Whether the node hosts conversation rooms |
| `ports` | Comma-separated listening ports (REST first) |

Presence on the LAN is a **discovery hint, never a trust grant**:

- a peer whose `region` does not match ours is rejected outright (no cross-region trust);
- a same-region peer that is not one of the caller's asset-agent contacts is surfaced as
  *unmatched*, not usable;
- the region path stays the default/fallback — the desktop only *prefers* the local path
  when the user enables it.

## Surface

- `parseAnxMdnsTxt` / `parsePorts` / `toDiscoveredPeer` — pure TXT parsing.
- `matchLocalAssetAgents` — region-guarded match against contacts, with route
  classification (`lan_mdns` / `intranet`).
- `shouldPreferLocal` / `localMatchForContact` — the prefer-local decision.
- `browseAnxPeers(backend)` — browses `_anx._tcp` for a fixed window over an injectable
  mDNS backend (the Electron main process wires `bonjour-service`; tests inject a fake).

Nothing here dials the region or opens P2P; it only answers "is one of my asset agents
reachable on this LAN, and should the desktop prefer that path?".
