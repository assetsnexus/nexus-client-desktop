/**
 * A region command client for the storage hub's list-only sections.
 *
 * The desktop renderer has no host bridge inside the main window, so a section
 * that needs to call a region command builds a plain `fetch`-based client from
 * the connection config + the signed-in session — the same pattern the settings
 * sections use (`components/settings/desktopCommandClient.ts`). This hook wraps
 * that lookup so both collection sections share one implementation and one
 * failure mode: when the user is signed out (or the config cannot be read) the
 * client stays `null` and the section renders its signed-out hint instead of
 * firing an unauthenticated request.
 */

import { useEffect, useState } from 'react';
import { bridge } from '../../bridge.js';
import {
  createDesktopCommandClient,
  type DesktopIdentity,
} from '../settings/desktopCommandClient.js';
import type { CollectionCommandClient } from '../../storage/portal-collections.js';

export type RegionClientState = {
  /**
   * Ready-to-use command client, or `null` while loading / when signed out.
   * `null` with `ready: true` means "no session" — a terminal state, not a wait.
   */
  client: CollectionCommandClient | null;
  /** Portal origin from the connection config, used to build deep-links. */
  portalUrl: string | null;
  /**
   * The signed-in user's active org, if any. The portal routes an org member to
   * its `/b2b` console, so a section's "manage"/"new" deep-link needs this even
   * when the list is empty and there is no row to read an `orgId` from.
   */
  orgId: string | null;
  /** True once the lookup finished (successfully or not). */
  ready: boolean;
};

export function useRegionClient(): RegionClientState {
  const [state, setState] = useState<RegionClientState>({
    client: null,
    portalUrl: null,
    orgId: null,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [connection, auth] = await Promise.all([
          bridge.getConnectionConfig(),
          bridge.getAuthState(),
        ]);
        if (cancelled) return;
        const portalUrl = connection.portalUrl?.trim() || null;
        if (auth.status !== 'signed_in') {
          setState({ client: null, portalUrl, orgId: null, ready: true });
          return;
        }
        const identity: DesktopIdentity = {
          token: auth.token,
          userId: auth.identity.userId ?? null,
          orgId: auth.identity.orgId ?? null,
          role: auth.identity.role ?? null,
          deviceId: auth.identity.deviceId ?? null,
        };
        setState({
          client: createDesktopCommandClient({ apiBaseUrl: connection.regionUrl, identity }),
          portalUrl,
          orgId: identity.orgId ?? null,
          ready: true,
        });
      } catch {
        // No usable connection/session: the section renders its signed-out hint.
        if (!cancelled) setState({ client: null, portalUrl: null, orgId: null, ready: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
