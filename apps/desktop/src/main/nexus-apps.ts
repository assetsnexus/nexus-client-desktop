/**
 * Installed Nexus apps for the tray (main process).
 *
 * "Installed apps" are third-party apps the user (or one of their org
 * memberships) connected through *Login with ANX* (OAuth2). The region
 * represents those as OAuth2 **grants** (`{ items, total }` of
 * `OAuth2GrantView`).
 *
 * ## Why one call per identity, and which command
 *
 * Grants are **identity-scoped**, not user-global, so the tray unions the rows
 * from every stored session (personal + each org membership), deduped by
 * `clientId`. Which command to call depends on the session, mirroring the
 * portal's connected-apps panel:
 *
 *  - a **personal** session calls `anx.oauth2.grants.list` (self/individual
 *    grants, no membership binding); and
 *  - a **business (org-member)** session calls `anx.oauth2.org.grants.list`,
 *    because an app the org connected is stored as an *org* grant — the
 *    self-scoped `grants.list` deliberately filters those out and returns
 *    nothing for an org session (verified live).
 *
 * `org.grants.list` needs `oauth2:read`; if a member lacks the org-scoped read
 * (or the region refuses it), that identity falls back to `grants.list` so a
 * single denial cannot blank the section.
 *
 * Every authenticated command is also **device-gated**, so each identity
 * envelope must carry its own stored `deviceId` (omitting it yields a 401
 * `Device validation failed`).
 *
 * A failure for any single identity is tolerated (that identity contributes
 * nothing) so a stale token cannot blank the whole list.
 */

import { sendCommand, type AuthClientOptions } from '@nexus/node-core';
import type { InstalledNexusApp } from '../shared/nexus-apps.js';

/** One stored session the provider may query as (token authority). */
export type NexusAppIdentity = {
  key: string;
  userId: string | null;
  orgId: string | null;
  /** Display name for the org group; falls back to the identity label. */
  orgName: string | null;
  token: string;
  /**
   * Device the session was validated against. Every authenticated region
   * command is device-gated, so this must be forwarded or the call 401s.
   */
  deviceId: string | null;
};

export type NexusAppsProviderOptions = {
  /**
   * Stored sessions to query. One command call is made per entry so the union
   * covers the personal identity and every org membership.
   */
  listIdentities: () => NexusAppIdentity[];
  /** Region client options (rebuilt when the connection config changes). */
  getClientOptions: () => AuthClientOptions;
  /** Injectable for tests; defaults to the node-core `sendCommand`. */
  send?: typeof sendCommand;
  /** Page size per identity (the region caps a single page itself). */
  limit?: number;
};

export type InstalledAppsResult = {
  apps: InstalledNexusApp[];
  /** True when at least one identity was queried successfully. */
  ok: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The grant rows a region list handler returned (array, `.items`, `.grants`). */
function grantRows(raw: unknown): Record<string, unknown>[] {
  const response = asRecord(raw);
  const body = asRecord(response.responseObject ?? raw);
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.grants)
        ? body.grants
        : [];
  return rows.map((row) => asRecord(row));
}

/**
 * Project one `OAuth2GrantView` to a tray entry.
 *
 * URL precedence mirrors the portal taskbar: the explicit launcher wins, then
 * the client homepage. A launcher that is present but `enabled: false` means
 * the app declined a launcher (the portal hides it), so the whole row is
 * dropped rather than resurrecting it from the homepage. An app with no
 * launcher and no homepage cannot be linked, so it is dropped too.
 */
export function projectGrant(
  row: Record<string, unknown>,
  identity: Pick<NexusAppIdentity, 'orgId' | 'orgName' | 'userId'>,
): InstalledNexusApp | null {
  const clientId = str(row.clientId);
  if (!clientId) return null;

  const launcher = row.clientPortalLauncher ? asRecord(row.clientPortalLauncher) : null;
  if (launcher && launcher.enabled === false) return null;
  const url = (launcher ? str(launcher.launchUrl) : null) ?? str(row.clientHomepageUrl);
  if (!url) return null;

  const label =
    (launcher ? str(launcher.label) : null) ?? str(row.clientName) ?? clientId;

  return {
    clientId,
    label,
    url,
    orgId: identity.orgId,
    orgName: identity.orgName,
  };
}

export type NexusAppsProvider = {
  /** Union of installed apps across the stored identities. */
  list(): Promise<InstalledAppsResult>;
};

export function createNexusAppsProvider(options: NexusAppsProviderOptions): NexusAppsProvider {
  const send = options.send ?? sendCommand;
  const limit = options.limit ?? 100;

  /**
   * The region command that returns the caller's grants for this identity.
   *
   * An org-member session must use the org-scoped command: the self-scoped
   * `grants.list` filters out every grant carrying a `membershipId`, so it
   * legitimately returns nothing for an org session even when the org has apps
   * connected. A personal session has no membership and uses `grants.list`.
   */
  function commandFor(identity: NexusAppIdentity): string {
    return identity.orgId ? 'anx.oauth2.org.grants.list' : 'anx.oauth2.grants.list';
  }

  async function query(
    identity: NexusAppIdentity,
    command: string,
  ): Promise<{ apps: InstalledNexusApp[]; ok: boolean }> {
    const response = await send(
      options.getClientOptions(),
      command,
      // `status: 'active'` is explicit: without it an org-scoped call would also
      // return revoked/expired grants.
      { limit, status: 'active' },
      {
        token: identity.token,
        identity: {
          ...(identity.userId ? { userId: identity.userId } : {}),
          ...(identity.orgId ? { orgId: identity.orgId } : {}),
          // Device validation is mandatory for every authenticated command.
          ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
        },
      },
    );
    // `sendCommand` resolves (never throws) on a region error envelope, so a
    // permission denial arrives here as a non-2xx `responseCode`, not a reject.
    const ok = response.responseCode >= 200 && response.responseCode < 300;
    const rows = ok ? grantRows(response) : [];
    const out: InstalledNexusApp[] = [];
    for (const row of rows) {
      const projected = projectGrant(row, {
        orgId: identity.orgId,
        orgName: identity.orgName,
        userId: identity.userId,
      });
      if (projected) out.push(projected);
    }
    return { apps: out, ok };
  }

  async function listForIdentity(
    identity: NexusAppIdentity,
  ): Promise<{ apps: InstalledNexusApp[]; ok: boolean }> {
    const command = commandFor(identity);
    try {
      const primary = await query(identity, command);
      if (primary.ok) return primary;
      // Only the org-scoped command has a narrower (permission) failure surface;
      // fall back to the self-scoped read so a member without org read still
      // contributes their own individual grants.
      if (command !== 'anx.oauth2.grants.list') {
        return query(identity, 'anx.oauth2.grants.list');
      }
      return primary;
    } catch {
      // Transport failure for this identity: contribute nothing (the caller
      // keeps the other identities' results).
      return { apps: [], ok: false };
    }
  }

  return {
    async list(): Promise<InstalledAppsResult> {
      const identities = options.listIdentities().filter((i) => i.token);
      if (identities.length === 0) return { apps: [], ok: false };

      const results = await Promise.all(identities.map((identity) => listForIdentity(identity)));

      const byClient = new Map<string, InstalledNexusApp>();
      for (const result of results) {
        for (const app of result.apps) {
          if (!byClient.has(app.clientId)) byClient.set(app.clientId, app);
        }
      }
      const apps = Array.from(byClient.values());
      return { apps, ok: results.some((r) => r.ok) };
    },
  };
}
