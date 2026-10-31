/**
 * Notification inbox contract (shared between main, preload, and renderer).
 *
 * Mirrors the portal's `anx.notification.*` usage: a normalized row (never the
 * raw encrypted DTO), the region command inputs, and the zen state. Pure and
 * Electron-free so both sides validate the same shape and the row normalizer is
 * unit-tested in isolation.
 */

/** Coarse priority bucket, matching the portal's `NOTIFICATION_PRIORITIES`. */
export type NotificationPriority = 'lowest' | 'low' | 'normal' | 'high' | 'highest';

export const NOTIFICATION_PRIORITIES: readonly NotificationPriority[] = [
  'lowest',
  'low',
  'normal',
  'high',
  'highest',
];

/**
 * A notification row as the renderer needs it. Region-node owns the persisted
 * record; this is the projection the desktop UI renders (avatar/source labels
 * are resolved separately and merged in).
 */
export type NotificationRow = {
  id: string;
  title: string;
  body: string;
  type: string | null;
  priority: NotificationPriority;
  tags: string[];
  /** Semantic key for routing (`crm.lead.assigned`). */
  eventKey: string | null;
  /** Category key; always present on a real row (server falls back to `system.general`). */
  categoryKey: string | null;
  /** Validated presentation (link / icon / actions), or null when absent. */
  presentation: NotificationPresentation | null;
  /** Per-user action outcomes, used to hide consumed once-callbacks. */
  actionResults: NotificationActionOutcome[];
  /** Free-form id bag. Carried for routing; never rendered wholesale. */
  data: Record<string, unknown> | null;
  /** `app` sender, when the notification came from an OAuth app. */
  source: { kind?: string; oauthClientId?: string } | null;
  oauthClientId: string | null;
  recipientOrgId: string | null;
  /** ISO timestamp the row was read, or null while unread. */
  readAt: string | null;
  /** Deadline for undoing a read (server-configured window), or null. */
  unmarkDeadlineAt: string | null;
  createdAt: string | null;
  avatarUrl: string;
  sourceLabel: string;
  sourceKind: string;
};

/** Outcome of one action for one user (server-written). */
export type NotificationActionOutcome = {
  actionId: string;
  userId?: string;
  at?: string;
  status: 'claimed' | 'delivered' | 'handled' | 'failed';
};

/**
 * Presentation sub-shape. Loosely typed on purpose: the renderer routes it
 * through `@nexus/notifications-core`, which validates every field, so the IPC
 * boundary does not restate the full contract (and cannot drift from it).
 */
export type NotificationPresentation = {
  link?: { kind: 'route'; resource: string; id?: string; section?: string } | { kind: 'path'; path: string } | { kind: 'url'; url: string };
  icon?: { kind: 'symbol'; name: string } | { kind: 'app_logo' };
  actions?: Array<{
    id: string;
    label: string;
    style: 'primary' | 'secondary' | 'danger' | 'link';
    kind: 'open' | 'callback' | 'ask_ai' | 'mark_read';
    link?: NotificationPresentation['link'];
    handlerKey?: string;
    confirm?: { title: string; body?: string };
    once?: boolean;
  }>;
};

/** Input for `anx.notification.list`. */
export type NotificationListInput = {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  tags?: string[];
  priority?: NotificationPriority;
  /** Agent-scoped inbox filter (`data.virtualEmployeeId`); recipient stays server-derived. */
  virtualEmployeeId?: string;
};

/** Result of a list call. `total` is the server's unread-capable count. */
export type NotificationListResult = {
  notifications: NotificationRow[];
  total: number;
};

/** A single row returned by get / mark-read / mark-unread. */
export type NotificationMutationResult = {
  notification: NotificationRow | null;
  /** Server-provided error code, e.g. `NOTIFICATION_UNMARK_WINDOW_EXPIRED`. */
  code?: string;
};

/** Result of `anx.notification.mark-all-read`. */
export type NotificationMarkAllResult = { marked: number };

/** Zen (do-not-disturb) state. */
export type ZenState = {
  active: boolean;
  activeSnooze?: { startsAt?: string; endsAt?: string; reason?: string | null } | null;
  activeSchedule?: { id?: string; label?: string | null } | null;
  schedules?: ZenSchedule[];
};

export type ZenSchedule = {
  id?: string;
  label?: string | null;
  daysOfWeek?: number[];
  startMinute?: number;
  endMinute?: number;
  timezone?: string | null;
  enabled?: boolean;
};

/** Input for starting a zen snooze (all fields are server-validated). */
export type ZenSnoozeStartInput = {
  /** Duration in minutes (mutually exclusive with an explicit `endsAt`). */
  minutes?: number;
  endsAt?: string;
  reason?: string | null;
};

/**
 * One action that the UI may show, after `@nexus/notifications-core` filtered
 * consumed once-callbacks. `linkKind`/`label` are resolved; the raw action is
 * carried so the invoker can pass its exact id back.
 */
export type NotificationVisibleAction = {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger' | 'link';
  kind: 'open' | 'callback' | 'ask_ai' | 'mark_read';
  confirm?: { title: string; body?: string };
};

/** Which tab badge the shell should show (cheap count for the tab). */
export type NotificationUnreadSummary = {
  unread: number;
  /** Highest priority among unread rows, for badge tinting. */
  topPriority: NotificationPriority | null;
};

/** Where a notification tap should send the user (resolved in the renderer). */
export type NotificationTapTarget =
  | { kind: 'chat'; conversationId?: string; agentId?: string }
  | { kind: 'portal'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'none' };

// ---------------------------------------------------------------------------
// Normalization (pure)
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Coerce an unknown priority to a valid bucket (defaults to `normal`). */
export function normalizeNotificationPriority(value: unknown): NotificationPriority {
  return typeof value === 'string' && (NOTIFICATION_PRIORITIES as readonly string[]).includes(value)
    ? (value as NotificationPriority)
    : 'normal';
}

/** Rank of a priority bucket (higher = more urgent); `lowest` is 0. */
export function priorityRank(priority: NotificationPriority): number {
  return NOTIFICATION_PRIORITIES.indexOf(priority);
}

/**
 * Highest priority in a list, or `null` for an empty list. Used for the tab
 * badge tint so a `highest` row is visibly different from a `normal` one.
 */
export function highestPriority(rows: readonly NotificationRow[]): NotificationPriority | null {
  let best: NotificationPriority | null = null;
  for (const row of rows) {
    if (best === null || priorityRank(row.priority) > priorityRank(best)) best = row.priority;
  }
  return best;
}

/**
 * True while a row is unread. A row is unread exactly when it carries no
 * `readAt` (the same rule `isNotificationUnread` uses in portal/app).
 */
export function isNotificationUnread(row: Pick<NotificationRow, 'readAt'>): boolean {
  return !row.readAt;
}

/**
 * Whether the read can still be undone now. Mirrors `canUnmarkNotification`:
 * unread rows cannot be unmarked, read rows only within the server window.
 */
export function canUnmarkNotification(
  row: Pick<NotificationRow, 'readAt' | 'unmarkDeadlineAt'>,
  now: number = Date.now(),
): boolean {
  if (isNotificationUnread(row)) return false;
  const deadline = row.unmarkDeadlineAt ? Date.parse(row.unmarkDeadlineAt) : Number.NaN;
  if (!Number.isFinite(deadline)) return false;
  return now <= deadline;
}

/** Unread count over a set of rows. */
export function countUnread(rows: readonly NotificationRow[]): number {
  return rows.reduce((n, row) => n + (isNotificationUnread(row) ? 1 : 0), 0);
}

function normalizeActionResults(raw: unknown): NotificationActionOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationActionOutcome[] = [];
  for (const entry of raw) {
    const rec = record(entry);
    const actionId = str(rec?.actionId);
    const status = str(rec?.status);
    if (!actionId) continue;
    if (
      status !== 'claimed' &&
      status !== 'delivered' &&
      status !== 'handled' &&
      status !== 'failed'
    ) {
      continue;
    }
    out.push({
      actionId,
      userId: str(rec?.userId) ?? undefined,
      at: str(rec?.at) ?? undefined,
      status,
    });
  }
  return out;
}

function normalizeSource(raw: unknown, oauthClientId: string | null): NotificationRow['source'] {
  const rec = record(raw);
  if (rec) {
    const kind = str(rec.kind) ?? undefined;
    const client = str(rec.oauthClientId) ?? undefined;
    return { ...(kind ? { kind } : {}), ...(client ? { oauthClientId: client } : {}) };
  }
  if (oauthClientId) return { kind: 'app', oauthClientId };
  return null;
}

/**
 * Project a raw region notification (or an already-normalized row) into the
 * desktop row shape. Unknown/malformed fields degrade to nulls rather than
 * throwing, so one bad row cannot break the whole inbox.
 */
export function normalizeNotificationRow(raw: unknown): NotificationRow | null {
  const rec = record(raw);
  if (!rec) return null;
  const id = str(rec._id) ?? str(rec.id);
  if (!id) return null;

  const readAtRaw = str(rec.readAt);
  const unread = !readAtRaw;
  const unmarkDeadlineAt = str(rec.unmarkDeadlineAt);
  const oauthClientId = str(rec.oauthClientId);

  return {
    id,
    title: str(rec.title) ?? 'Notification',
    body: str(rec.body) ?? '',
    type: str(rec.type),
    priority: normalizeNotificationPriority(rec.priority),
    tags: Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === 'string') : [],
    eventKey: str(rec.eventKey),
    categoryKey: str(rec.categoryKey),
    presentation: (record(rec.presentation) as NotificationPresentation | null) ?? null,
    actionResults: normalizeActionResults(rec.actionResults),
    data: record(rec.data),
    source: normalizeSource(rec.source, oauthClientId),
    oauthClientId,
    recipientOrgId: str(rec.recipientOrgId),
    // A row that is unread has no effective read time even if a stale field is set.
    readAt: unread ? null : readAtRaw,
    unmarkDeadlineAt: unread ? null : unmarkDeadlineAt,
    createdAt: str(rec.createdAt),
    avatarUrl: str(rec.avatarUrl) ?? '',
    sourceLabel: str(rec.sourceLabel) ?? '',
    sourceKind: str(rec.sourceKind) ?? str(normalizeSource(rec.source, oauthClientId)?.kind) ?? '',
  };
}

/** Normalize a list response into rows, dropping malformed entries. */
export function normalizeNotificationList(
  raw: unknown,
  total?: unknown,
): { notifications: NotificationRow[]; total: number } {
  const listRaw = Array.isArray(raw) ? raw : [];
  const notifications = listRaw
    .map(normalizeNotificationRow)
    .filter((row): row is NotificationRow => row !== null);
  const totalNum = typeof total === 'number' ? total : Number(total);
  return {
    notifications,
    // Fall back to the page length when the server did not report a total.
    total: Number.isFinite(totalNum) && totalNum >= 0 ? totalNum : notifications.length,
  };
}
