/**
 * Portal deep-links for the storage hub's list-only sections.
 *
 * The desktop deliberately does NOT duplicate the portal's data-room and cloud-
 * workspace CRUD surfaces (create, edit settings, invites, shares, billing…).
 * Instead the hub lists what the caller can see and deep-links to the portal for
 * anything that manages it. These builders are the single place that knows the
 * portal's routes, so a route move changes one file rather than every caller.
 *
 * Portal routes (canonical, from the portal's own menu configs):
 *   user console  /user/data-rooms   /user/data-rooms/:id   /user/workspaces   /user/workspaces/:id
 *   org console   /b2b/data-rooms    /b2b/data-rooms/:id    /b2b/workspaces    /b2b/workspaces/:id
 *
 * The `user` vs `org` split mirrors the portal's own console-surface switch, so a
 * signed-in org member lands on the org console and a personal user on theirs.
 */

/** Which portal console a deep-link targets. */
export type PortalConsoleSurface = 'user' | 'org';

/** Anything that carries an `orgId` belongs to the org console. */
export function portalSurfaceFor(orgId: string | null | undefined): PortalConsoleSurface {
  return orgId ? 'org' : 'user';
}

function prefixFor(surface: PortalConsoleSurface): string {
  return surface === 'org' ? '/b2b' : '/user';
}

/** Portal list page for data rooms. */
export function dataRoomsListPath(surface: PortalConsoleSurface): string {
  return `${prefixFor(surface)}/data-rooms`;
}

/** Portal detail page for one data room. */
export function dataRoomDetailPath(dataRoomId: string, surface: PortalConsoleSurface): string {
  return `${prefixFor(surface)}/data-rooms/${encodeURIComponent(dataRoomId)}`;
}

/** Portal list page for cloud workspaces. */
export function workspacesListPath(surface: PortalConsoleSurface): string {
  return `${prefixFor(surface)}/workspaces`;
}

/** Portal detail page for one cloud workspace. */
export function workspaceDetailPath(workspaceId: string, surface: PortalConsoleSurface): string {
  return `${prefixFor(surface)}/workspaces/${encodeURIComponent(workspaceId)}`;
}

/**
 * Join a portal origin and an app-relative path. Trailing slashes are trimmed
 * from the origin and a missing leading slash is added to the path, so callers
 * can pass either form without producing `//` or a relative URL.
 */
export function absolutePortalUrl(
  origin: string | null | undefined,
  path: string,
): string | null {
  const base = origin?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return `${base}${rel}`;
}
