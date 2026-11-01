/**
 * Pure helpers behind the storage hub's two list-only sections — data rooms and
 * cloud workspaces.
 *
 * Both surfaces are deliberately READ-ONLY in the desktop: they list what the
 * signed-in caller can see and hand every managing action (create, settings,
 * invites, shares, delete) to the portal. Keeping the shaping here means the
 * command payloads, the defensive row parsing and the "what does the row show"
 * decisions are unit-testable without a DOM or a region.
 *
 * Region commands used (names from the workspace contract's `command-names.ts`):
 *   anx.data-room.list            { filter, limit, offset } -> { items, total }
 *   anx.data-room.analytics.summary { dataRoomId } -> { visits, uniqueViewers, totalDwellMs, avgDwellMs }
 *   anx.workspace.list            { visibility, limit, offset } -> { items, total, hiddenCount }
 */

/** A data-room row as `anx.data-room.list` returns it (a `DataRoomSnapshot`). */
export type DataRoomListRow = {
  id: string;
  name: string;
  slug?: string;
  visibility?: string;
  ownerScope?: string;
  userId?: string;
  orgId?: string;
  engagementEnabled?: boolean;
  frozen?: boolean;
  itemCount?: number;
  activeShareCount?: number;
  campaignIds?: string[];
  updatedAt?: string;
};

/** A cloud-workspace row as `anx.workspace.list` returns it (a snapshot). */
export type WorkspaceListRow = {
  id: string;
  name: string;
  description?: string;
  ownerScope?: string;
  userId?: string;
  orgId?: string;
  accessMode?: string;
  itemCount?: number;
  memberCount?: number;
  humanUserCount?: number;
  sharedItemCount?: number;
  updatedAt?: string;
};

/** Engagement summary as `anx.data-room.analytics.summary` returns it. */
export type DataRoomAnalyticsSummary = {
  visits?: number;
  uniqueViewers?: number;
  totalDwellMs?: number;
  avgDwellMs?: number;
  feedbackCount?: number;
};

/** Filters the region accepts on `anx.data-room.list`. */
export type DataRoomListFilter = 'mine' | 'shared_with_me';

/** Visibility the region accepts on `anx.workspace.list`. */
export type WorkspaceListVisibility = 'shared' | 'all';

/**
 * The command client shape these loaders need. Declared structurally so the
 * module neither imports the desktop bridge nor `@nexus/chat-core`: the section
 * hands in whatever command client it built (see `desktopCommandClient`).
 */
export type CollectionCommandClient = {
  send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
};

/** A command reply as the desktop command client normalizes it. */
export type CommandReply = {
  ok: boolean;
  data?: unknown;
  responseCode?: number;
  message?: string;
};

/**
 * Normalize a command client's reply into `{ ok, data }`.
 *
 * The desktop client returns a `SendResult`-shaped object; a transport-level
 * client may return the payload directly. Both are accepted so a caller does not
 * have to know which client it holds. A region error envelope (`responseCode`
 * outside 2xx, or an `error` field) is reported as not-ok rather than parsed as a
 * row list — otherwise a 403 would render as "no rooms", which reads as "you have
 * none" instead of "you may not see them".
 */
export function readReply(reply: unknown): CommandReply {
  if (!reply || typeof reply !== 'object') return { ok: false };
  const record = reply as Record<string, unknown>;
  const rawCode = Number(record.responseCode ?? record.status ?? 0);
  const hasCode = Number.isFinite(rawCode) && rawCode > 0;
  const ok = hasCode ? rawCode >= 200 && rawCode < 300 : record.ok !== false;
  const data = record.responseObject ?? record.data ?? (hasCode ? undefined : record);
  const message = typeof record.message === 'string' ? record.message : undefined;
  if (!ok && !message && data && typeof data === 'object') {
    const errorText = (data as Record<string, unknown>).error;
    if (typeof errorText === 'string') return { ok: false, data, responseCode: rawCode, message: errorText };
  }
  return { ok, data, responseCode: hasCode ? rawCode : undefined, message };
}

/** Pull an `items` array out of a list reply, tolerating `{ items }` or a bare array. */
function readItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const items = (data as Record<string, unknown>).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

function readTotal(data: unknown, fallback: number): number {
  if (data && typeof data === 'object') {
    const total = Number((data as Record<string, unknown>).total);
    if (Number.isFinite(total) && total >= 0) return total;
  }
  return fallback;
}

/** Request payload for the data-room list. `limit` is clamped to the region's max. */
export function dataRoomListPayload(filter: DataRoomListFilter, limit = 25): Record<string, unknown> {
  return { filter, limit: Math.max(1, Math.min(Math.trunc(limit) || 25, 100)), offset: 0 };
}

/** Request payload for the cloud-workspace list. */
export function workspaceListPayload(
  visibility: WorkspaceListVisibility,
  limit = 25,
): Record<string, unknown> {
  return { visibility, limit: Math.max(1, Math.min(Math.trunc(limit) || 25, 100)), offset: 0 };
}

/** A parsed list page: rows plus the total the region reported. */
export type CollectionPage<T> = {
  items: T[];
  total: number;
  /** Extra fields the caller may want (e.g. `hiddenCount` for workspaces). */
  hiddenCount?: number;
};

/**
 * Parse `anx.data-room.list`. Rows without a string id are dropped: the portal
 * deep-link and the analytics call both key on the id, so an id-less row cannot
 * be rendered as anything actionable.
 */
export function parseDataRoomList(data: unknown): CollectionPage<DataRoomListRow> {
  const items = readItems<DataRoomListRow>(data).filter(
    (row) => row && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0,
  );
  return { items, total: readTotal(data, items.length) };
}

/** Parse `anx.workspace.list`, keeping only rows with a usable id. */
export function parseWorkspaceList(data: unknown): CollectionPage<WorkspaceListRow> {
  const items = readItems<WorkspaceListRow>(data).filter(
    (row) => row && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0,
  );
  const hiddenCount = Number(
    data && typeof data === 'object' ? (data as Record<string, unknown>).hiddenCount : 0,
  );
  return {
    items,
    total: readTotal(data, items.length),
    hiddenCount: Number.isFinite(hiddenCount) && hiddenCount > 0 ? hiddenCount : 0,
  };
}

/**
 * Fetch a page of data rooms. A region error surfaces as a rejected promise with
 * the region's message, so the section can show the reason instead of an empty
 * list that looks like "you have no data rooms".
 */
export async function loadDataRooms(
  client: CollectionCommandClient,
  filter: DataRoomListFilter,
  limit?: number,
): Promise<CollectionPage<DataRoomListRow>> {
  const reply = readReply(await client.send('anx.data-room.list', dataRoomListPayload(filter, limit)));
  if (!reply.ok) throw new Error(reply.message || 'Could not load data rooms.');
  return parseDataRoomList(reply.data);
}

/** Fetch a page of cloud workspaces. Same error contract as `loadDataRooms`. */
export async function loadCloudWorkspaces(
  client: CollectionCommandClient,
  visibility: WorkspaceListVisibility,
  limit?: number,
): Promise<CollectionPage<WorkspaceListRow>> {
  const reply = readReply(
    await client.send('anx.workspace.list', workspaceListPayload(visibility, limit)),
  );
  if (!reply.ok) throw new Error(reply.message || 'Could not load workspaces.');
  return parseWorkspaceList(reply.data);
}

/** The stats the desktop shows per data-room row (mirrors the portal's list columns). */
export type DataRoomRowStats = {
  itemCount: number;
  activeShareCount: number;
  /** Views/visits in the analytics window; `null` until the summary is loaded. */
  visits: number | null;
  uniqueViewers: number | null;
};

/** Normalize the counts a row carries, so `undefined` renders as `0` not `NaN`. */
export function dataRoomRowStats(row: DataRoomListRow): DataRoomRowStats {
  const count = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  };
  return {
    itemCount: count(row.itemCount),
    activeShareCount: count(row.activeShareCount),
    visits: null,
    uniqueViewers: null,
  };
}

/** Merge a loaded engagement summary into a row's stats. */
export function withAnalytics(
  stats: DataRoomRowStats,
  summary: DataRoomAnalyticsSummary | null | undefined,
): DataRoomRowStats {
  if (!summary) return stats;
  const count = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
  };
  return {
    ...stats,
    visits: count(summary.visits) ?? count(summary.uniqueViewers) ?? 0,
    uniqueViewers: count(summary.uniqueViewers) ?? count(summary.visits) ?? 0,
  };
}

/** The counts a cloud-workspace row shows. */
export type WorkspaceRowStats = {
  itemCount: number;
  memberCount: number;
  humanUserCount: number;
  sharedItemCount: number;
};

/** Normalize a workspace row's counts for display. */
export function workspaceRowStats(row: WorkspaceListRow): WorkspaceRowStats {
  const count = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  };
  return {
    itemCount: count(row.itemCount),
    memberCount: count(row.memberCount),
    humanUserCount: count(row.humanUserCount),
    sharedItemCount: count(row.sharedItemCount),
  };
}

/**
 * Human label for a row's ownership: an org row reads as the org's, a personal
 * row as the caller's. Kept here (not in JSX) so the same wording is used in the
 * list, the empty state and the spec.
 */
export function rowScopeLabel(row: { orgId?: string | null; ownerScope?: string }): 'org' | 'personal' {
  if (row.ownerScope === 'org' || row.ownerScope === 'personal') return row.ownerScope;
  return row.orgId ? 'org' : 'personal';
}
