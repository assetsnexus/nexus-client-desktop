/**
 * mDNS browser adapter (Phase 10).
 *
 * Wraps an injected mDNS backend (the Electron main process wires this to
 * `bonjour-service`; tests inject a fake) and exposes a small, cancellable
 * "browse `_anx._tcp` for N ms" API over the pure parser in `./txt.ts`.
 *
 * Keeping the backend injectable means the discovery logic is testable without a
 * real multicast socket, and the app never hard-depends on one mDNS library.
 */

import { toDiscoveredPeer, type DiscoveredPeer, type MdnsService } from './txt.js';

export const ANX_SERVICE_TYPE = '_anx._tcp';

export type MdnsBackend = {
  /** Begin browsing; `onService` is called for each `_anx._tcp` result. */
  browse(serviceType: string, onService: (service: MdnsService) => void): () => void;
};

export type BrowseOptions = {
  /** How long to collect results before resolving. Default 2500ms. */
  durationMs?: number;
  serviceType?: string;
};

/**
 * Browse `_anx._tcp` for a fixed window and resolve the parsed peers.
 *
 * De-duplicates by instance name so a re-announce does not produce two peers.
 */
export function browseAnxPeers(
  backend: MdnsBackend,
  options: BrowseOptions = {},
): Promise<DiscoveredPeer[]> {
  const durationMs = options.durationMs ?? 2500;
  const serviceType = options.serviceType ?? ANX_SERVICE_TYPE;

  return new Promise((resolve) => {
    const byName = new Map<string, DiscoveredPeer>();
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      stop?.();
      resolve([...byName.values()]);
    };

    try {
      stop = backend.browse(serviceType, (service) => {
        const peer = toDiscoveredPeer(service);
        if (peer) byName.set(peer.name, peer);
      });
    } catch {
      // A missing/failed mDNS backend is not fatal: no peers discovered.
      resolve([]);
      return;
    }

    timer = setTimeout(finish, durationMs);
  });
}
