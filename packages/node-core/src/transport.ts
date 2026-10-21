/**
 * Region transport for headless clients.
 *
 * `@nexus/commands-client` already solves region routing, failover, 307 peer
 * adoption and SCA awareness, so this module re-exports the region-route parser
 * and adapts the result into the small `CommandSender` shape the chat core
 * expects. Both the desktop app and the CLI share this one implementation.
 *
 * The renderer uses the browser-side client from `@nexus/chat-react`
 * (`createRegionCommandClient`); this Node path is for the main process and CLI.
 */

import { parseRegionRoutes } from '@nexus/commands-client';

export { parseRegionRoutes };
export type { RegionRoute, RegionRoutes, RegionRouteKind } from '@nexus/commands-client';

export type CommandResult = {
  ok: boolean;
  data: unknown;
  responseCode: number;
  responseObject: unknown;
  message?: string;
  authorizationRequired?: boolean;
  authRequestId?: string;
};

/** Narrow command sender: mirrors `@nexus/chat-core`'s `CommandClient.send`. */
export type CommandSender = {
  send(command: string, payload?: Record<string, unknown>): Promise<CommandResult>;
};

export type ActiveRegion = {
  /** Region slug from the parsed `anx_region` document, when known. */
  slug: string | null;
  /** The base URL currently serving commands. */
  baseUrl: string;
};

export type RegionTransportState = {
  active: ActiveRegion;
  /** Known peer routes in preference order. */
  peers: string[];
  /** Adopt a new active base URL (e.g. after a 307 REGION_REDIRECT). */
  adopt(baseUrl: string): void;
};

export type CreateRegionTransportOptions = {
  baseUrl: string;
  /** Pre-parsed region document from login or the OAuth token body. */
  regionDocument?: unknown;
  allowHttp?: boolean;
};

function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Minimal region transport state machine: tracks the active base URL plus the
 * parsed peer routes. `adopt` follows a `307 REGION_REDIRECT` peer.
 */
export function createRegionTransport(
  options: CreateRegionTransportOptions,
): RegionTransportState {
  const parsed = parseRegionRoutes(
    { anx_region: options.regionDocument },
    { allowHttp: options.allowHttp === true },
  );
  const peers = parsed?.routes.map((r) => r.url) ?? [];
  let activeBaseUrl =
    trimTrailingSlash(options.baseUrl || '') || peers[0] || '';

  return {
    get active(): ActiveRegion {
      return { slug: parsed?.slug ?? null, baseUrl: activeBaseUrl };
    },
    get peers(): string[] {
      return peers;
    },
    adopt(baseUrl: string): void {
      const next = trimTrailingSlash(baseUrl || '');
      if (next) activeBaseUrl = next;
    },
  };
}
