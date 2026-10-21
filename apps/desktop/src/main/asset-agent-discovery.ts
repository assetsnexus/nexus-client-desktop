/**
 * Local asset-agent discovery manager (Phase 10, main process).
 *
 * Browses `_anx._tcp` on the LAN, matches same-region peers against the caller's
 * asset-agent contacts, and exposes a "prefer local path" toggle. The match
 * logic lives in `@nexus/asset-agent-discovery`; this module owns the mDNS
 * backend wiring and the persisted preference.
 *
 * Region matching is defensive: the caller's region comes from the resolved
 * region directory (`anx.region.node.info`), and a peer whose TXT `region`
 * differs is reported as rejected, never trusted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import {
  browseAnxPeers,
  matchLocalAssetAgents,
  type AssetAgentContact,
  type DiscoveredPeer,
  type MdnsBackend,
} from '@nexus/asset-agent-discovery';
import type { AssetAgentDiscoverySnapshot, AssetAgentPeerRow } from '../shared/ipc.js';

/** Bounded (settable) to keep the scan cheap; not user-facing yet. */
const SCAN_DURATION_MS = 2500;

export type AssetAgentDiscoveryOptions = {
  /** mDNS backend. Defaults to a no-op browser (discovery unavailable until wired). */
  backend?: MdnsBackend;
  /**
   * Resolve our region slug (used to reject foreign peers). Wired to the region's
   * `anx.region.node.info` contract; the result is cached per session.
   */
  resolveRegion: () => Promise<string | null>;
  /** The caller's asset-agent contacts. */
  getContacts: () => Promise<AssetAgentContact[]>;
  /** Overridable for tests. */
  configPath?: string;
  /** mDNS collection window. Defaults to `SCAN_DURATION_MS`. */
  scanDurationMs?: number;
};

export type AssetAgentDiscoveryManager = ReturnType<typeof createAssetAgentDiscoveryManager>;

export function createAssetAgentDiscoveryManager(options: AssetAgentDiscoveryOptions) {
  const configPath = options.configPath ?? join(app.getPath('userData'), 'asset-agents.json');
  const scanDurationMs = options.scanDurationMs ?? SCAN_DURATION_MS;
  let lastScan: AssetAgentDiscoverySnapshot | null = null;
  let cachedRegion: string | null = null;

  function readPref(): { preferLocalEnabled: boolean } {
    if (!existsSync(configPath)) return { preferLocalEnabled: false };
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { preferLocalEnabled?: boolean };
      return { preferLocalEnabled: raw.preferLocalEnabled === true };
    } catch {
      return { preferLocalEnabled: false };
    }
  }

  function writePref(value: { preferLocalEnabled: boolean }): void {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(value, null, 2), 'utf8');
  }

  /** Resolve the region slug once per session (region contract may be flaky). */
  async function region(): Promise<string | null> {
    if (cachedRegion) return cachedRegion;
    try {
      cachedRegion = await options.resolveRegion();
    } catch {
      cachedRegion = null;
    }
    return cachedRegion;
  }

  async function snapshot(): Promise<AssetAgentDiscoverySnapshot> {
    const pref = readPref();
    const regionSlug = await region();
    return (
      lastScan ?? {
        preferLocalEnabled: pref.preferLocalEnabled,
        region: regionSlug,
        matches: [],
        rejectedForeignRegion: 0,
        unmatched: 0,
        scannedAt: '',
      }
    );
  }

  async function scan(): Promise<AssetAgentDiscoverySnapshot> {
    const pref = readPref();
    const regionSlug = await region();
    const scannedAt = new Date().toISOString();

    if (!regionSlug) {
      lastScan = {
        preferLocalEnabled: pref.preferLocalEnabled,
        region: null,
        matches: [],
        rejectedForeignRegion: 0,
        unmatched: 0,
        scannedAt,
        detail: 'no active region; sign in first',
      };
      return lastScan;
    }

    let peers: DiscoveredPeer[] = [];
    let detail: string | undefined;
    if (!options.backend) {
      detail = 'mDNS backend not wired';
    } else {
      peers = await browseAnxPeers(options.backend, { durationMs: scanDurationMs });
    }

    const contacts = await options.getContacts();
    const decision = matchLocalAssetAgents(peers, { region: regionSlug, contacts });
    const nameById = new Map(contacts.map((c) => [c.id, c.name ?? null]));

    lastScan = {
      preferLocalEnabled: pref.preferLocalEnabled,
      region: regionSlug,
      matches: decision.matches.map((m) => toRow(m, nameById.get(m.contactId) ?? null)),
      rejectedForeignRegion: decision.rejectedForeignRegion.length,
      unmatched: decision.unmatched.length,
      scannedAt,
      detail,
    };
    return lastScan;
  }

  return {
    snapshot,

    async setPreferLocal(enabled: boolean): Promise<AssetAgentDiscoverySnapshot> {
      writePref({ preferLocalEnabled: enabled });
      if (lastScan) lastScan = { ...lastScan, preferLocalEnabled: enabled };
      return snapshot();
    },

    /** Run a scan now (used by the UI refresh and at session start). */
    scan,

    /** Call before starting a turn: is a same-region local peer present? */
    async hasLocalPeer(contactId: string): Promise<boolean> {
      const pref = readPref();
      if (!pref.preferLocalEnabled) return false;
      const snap = await scan();
      return snap.matches.some((m) => m.contactId === contactId);
    },
  };
}

function toRow(
  match: {
    contactId: string;
    assetId: string;
    peer: DiscoveredPeer;
    routeKind: 'lan_mdns' | 'intranet';
    hostsRooms: boolean;
  },
  name: string | null,
): AssetAgentPeerRow {
  return {
    contactId: match.contactId,
    assetId: match.assetId,
    name,
    host: match.peer.host,
    port: match.peer.port,
    routeKind: match.routeKind,
    hostsRooms: match.hostsRooms,
    fingerprint: match.peer.txt.fingerprint,
    region: match.peer.txt.region,
  };
}
