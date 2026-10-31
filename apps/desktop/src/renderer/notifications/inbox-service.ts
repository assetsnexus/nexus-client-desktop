/**
 * Renderer notification inbox service.
 *
 * The region owns the notification records and the main process owns the token,
 * so this module wraps the `notify*` IPC surface, holds the list/unread state the
 * Notifications tab renders, and — through the *shared* `@nexus/notifications-core`
 * contract — decides where a tap or an action click should send the user.
 *
 * Routing is deliberately split out as pure functions: the desktop has no
 * in-app router for region pages, so a `portal` target becomes an absolute portal
 * URL opened in the OS browser, and only genuinely desktop-local targets (a chat
 * conversation) stay in the app. Keeping that decision pure means the mapping is
 * unit-tested without Electron or the network.
 */

import {
  actionTarget as coreActionTarget,
  resolveNotificationTarget,
  visibleActions,
  type NotificationRouteInput,
} from '@nexus/notifications-core';
import type {
  NotificationRow,
  NotificationTapTarget,
  NotificationUnreadSummary,
  NotificationVisibleAction,
  ZenState,
} from '../../shared/notifications.js';

/** The subset of the preload bridge this service needs (injectable for tests). */
export type InboxBridge = {
  notifyList(input?: { unreadOnly?: boolean; limit?: number; offset?: number }): Promise<{
    notifications: NotificationRow[];
    total: number;
  }>;
  notifySummary(): Promise<NotificationUnreadSummary>;
  notifyMarkRead(notificationId: string): Promise<{ notification: NotificationRow | null }>;
  notifyMarkUnread(notificationId: string): Promise<{ notification: NotificationRow | null }>;
  notifyMarkAllRead(): Promise<{ marked: number }>;
  notifyActionInvoke(
    notificationId: string,
    actionId: string,
  ): Promise<{ ok: boolean; status: string | null; error: string | null }>;
  notifyZenStatus(): Promise<ZenState>;
  notifyZenSnoozeStop(): Promise<ZenState>;
  onNotifyPush(listener: (ping: { notificationId: string | null }) => void): () => void;
};

export type InboxServiceOptions = {
  bridge: InboxBridge;
  /** Portal origin used to turn an internal path into a browser URL. */
  getPortalUrl: () => string | null;
  /** Active identity's user id, so consumed once-actions are hidden. */
  getUserId?: () => string | null;
  /** How many rows a page holds. */
  pageSize?: number;
};

export type InboxState = {
  rows: NotificationRow[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  /** True when the next page may still hold rows. */
  hasMore: boolean;
  unreadOnly: boolean;
  summary: NotificationUnreadSummary;
  zen: ZenState | null;
  error: string | null;
};

export type InboxService = ReturnType<typeof createInboxService>;

/** Shape `@nexus/notifications-core` accepts; our row is structurally compatible. */
function asRouteInput(row: NotificationRow): NotificationRouteInput {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    ...(row.type ? { type: row.type } : {}),
    tags: row.tags,
    ...(row.eventKey ? { eventKey: row.eventKey } : {}),
    ...(row.categoryKey ? { categoryKey: row.categoryKey } : {}),
    ...(row.presentation
      ? { presentation: row.presentation as NotificationRouteInput['presentation'] }
      : {}),
    // The core expects `at: Date`; the IPC boundary carries ISO strings, which
    // only feed equality/status checks — the field itself is never rendered.
    actionResults: row.actionResults as unknown as NotificationRouteInput['actionResults'],
    ...(row.data ? { data: row.data } : {}),
  };
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Where a row's tap should go on the desktop.
 *
 * The shared resolver answers in portal terms (`path` / `url`). Desktop has no
 * in-app region router, so:
 *  - an `https` `url` opens externally as-is;
 *  - a portal `path` becomes `<portalUrl><path>` and opens in the OS browser;
 *  - a row bound to a chat conversation stays in-app.
 * A `none` result yields no navigation, so an unroutable row is inert rather
 * than sending the user to the portal home.
 */
export function resolveNotificationTap(
  row: NotificationRow,
  opts: { portalUrl: string | null; portalPath?: string },
): NotificationTapTarget {
  const input = asRouteInput(row);
  const resolved = resolveNotificationTarget(input, {
    surface: 'portal',
    currentPath: opts.portalPath ?? '',
  });
  if (resolved.kind === 'url') return { kind: 'external', url: resolved.value };
  if (resolved.kind === 'path') {
    // A conversation deep link is the one target the desktop itself can show.
    if (/^\/(conversations|chat)\b/.test(resolved.value)) {
      return { kind: 'chat', conversationId: conversationIdOf(row) ?? undefined };
    }
    if (!opts.portalUrl) return { kind: 'none' };
    return { kind: 'portal', url: joinUrl(opts.portalUrl, resolved.value) };
  }
  return { kind: 'none' };
}

/**
 * The conversation a row points at, read from the well-known `data` keys the
 * region writes for chat-originated notifications.
 */
export function conversationIdOf(row: NotificationRow): string | null {
  const data = row.data ?? {};
  const candidate = data.conversationId ?? data.conversation_id ?? null;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/** The row's visible action CTAs (once-callbacks already consumed are hidden). */
export function visibleNotificationActions(
  row: NotificationRow,
  userId: string | null,
): NotificationVisibleAction[] {
  const actions = visibleActions(asRouteInput(row), { userId: userId ?? '' });
  return actions.slice(0, 3).map((action) => ({
    id: action.id,
    label: action.label,
    style: action.style,
    kind: action.kind,
    ...(action.confirm ? { confirm: action.confirm } : {}),
  }));
}

/** Resolve an `open` action's destination with the same rules as the row. */
export function resolveNotificationActionTap(
  row: NotificationRow,
  actionId: string,
  opts: { portalUrl: string | null; portalPath?: string },
): NotificationTapTarget {
  const action = (asRouteInput(row).presentation?.actions ?? []).find((a) => a.id === actionId);
  if (!action || action.kind !== 'open') return { kind: 'none' };
  const resolved = coreActionTarget(action, asRouteInput(row), {
    surface: 'portal',
    currentPath: opts.portalPath ?? '',
  });
  if (resolved.kind === 'url') return { kind: 'external', url: resolved.value };
  if (resolved.kind === 'path') {
    if (!opts.portalUrl) return { kind: 'none' };
    return { kind: 'portal', url: joinUrl(opts.portalUrl, resolved.value) };
  }
  return { kind: 'none' };
}

const EMPTY_SUMMARY: NotificationUnreadSummary = { unread: 0, topPriority: null };

/**
 * Hold inbox state for the Notifications tab: page-in, mutate, and re-derive the
 * unread badge. Every mutation refreshes the badge so the tab can never disagree
 * with the list.
 */
export function createInboxService(options: InboxServiceOptions) {
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 30;
  let state: InboxState = {
    rows: [],
    total: 0,
    loading: false,
    loadingMore: false,
    hasMore: true,
    unreadOnly: false,
    summary: EMPTY_SUMMARY,
    zen: null,
    error: null,
  };
  const listeners = new Set<(s: InboxState) => void>();
  /** Guards against an older list response overwriting a newer one. */
  let requestSeq = 0;

  const emit = (patch: Partial<InboxState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };

  async function refreshSummary(): Promise<void> {
    try {
      const summary = await options.bridge.notifySummary();
      emit({ summary });
    } catch {
      /* the badge is best-effort; the list itself reports the real error */
    }
  }

  async function loadFirstPage(): Promise<void> {
    const seq = ++requestSeq;
    emit({ loading: true, error: null });
    try {
      const result = await options.bridge.notifyList({
        unreadOnly: state.unreadOnly || undefined,
        limit: pageSize,
        offset: 0,
      });
      if (seq !== requestSeq) return;
      emit({
        rows: result.notifications,
        total: result.total,
        hasMore: result.notifications.length >= pageSize,
        loading: false,
      });
    } catch (err) {
      if (seq !== requestSeq) return;
      emit({
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load notifications',
      });
    }
  }

  async function loadMore(): Promise<void> {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    const seq = requestSeq;
    emit({ loadingMore: true });
    try {
      const result = await options.bridge.notifyList({
        unreadOnly: state.unreadOnly || undefined,
        limit: pageSize,
        offset: state.rows.length,
      });
      if (seq !== requestSeq) return;
      emit({
        rows: [...state.rows, ...result.notifications],
        total: result.total,
        hasMore: result.notifications.length >= pageSize,
        loadingMore: false,
      });
    } catch {
      if (seq !== requestSeq) return;
      emit({ loadingMore: false, hasMore: false });
    }
  }

  /** Replace one row in place (or drop it when the filter no longer matches). */
  function applyRow(next: NotificationRow | null): void {
    if (!next) return;
    const rows = state.rows.map((row) => (row.id === next.id ? next : row));
    const filtered = state.unreadOnly ? rows.filter((row) => !row.readAt) : rows;
    emit({ rows: filtered });
  }

  /** Whether the undo window allows flipping a read row back to unread. */
  function unmarkAllowed(row: NotificationRow): boolean {
    if (!row.readAt) return false;
    if (!row.unmarkDeadlineAt) return true;
    const deadline = Date.parse(row.unmarkDeadlineAt);
    return Number.isFinite(deadline) ? Date.now() <= deadline : true;
  }

  return {
    getState: () => state,
    subscribe(listener: (s: InboxState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    /** Full refresh: first page + unread badge + zen state. */
    async refresh(): Promise<void> {
      await Promise.all([
        loadFirstPage(),
        refreshSummary(),
        this.zenRefresh().catch(() => undefined),
      ]);
    },

    loadMore,
    unmarkAllowed,
    visibleActions: (row: NotificationRow) =>
      visibleNotificationActions(row, options.getUserId?.() ?? null),
    tapTarget: (row: NotificationRow) =>
      resolveNotificationTap(row, { portalUrl: options.getPortalUrl() }),
    actionTapTarget: (row: NotificationRow, actionId: string) =>
      resolveNotificationActionTap(row, actionId, { portalUrl: options.getPortalUrl() }),

    /** Switch the unread-only filter and reload from the top. */
    async setUnreadOnly(unreadOnly: boolean): Promise<void> {
      if (state.unreadOnly === unreadOnly) return;
      emit({ unreadOnly });
      await loadFirstPage();
    },

    async markRead(notificationId: string): Promise<void> {
      const prev = state.rows.find((row) => row.id === notificationId) ?? null;
      const result = await options.bridge.notifyMarkRead(notificationId);
      const next =
        result.notification ??
        (prev ? { ...prev, readAt: prev.readAt ?? new Date().toISOString() } : null);
      applyRow(next);
      await refreshSummary();
    },

    async markUnread(notificationId: string): Promise<void> {
      const result = await options.bridge.notifyMarkUnread(notificationId);
      const prev = state.rows.find((row) => row.id === notificationId) ?? null;
      const next =
        result.notification ?? (prev ? { ...prev, readAt: null, unmarkDeadlineAt: null } : null);
      applyRow(next);
      await refreshSummary();
    },

    async markAllRead(): Promise<number> {
      const result = await options.bridge.notifyMarkAllRead();
      // Optimistically flip every visible row; the reload below is authoritative.
      const rows = state.unreadOnly
        ? []
        : state.rows.map((row) => ({ ...row, readAt: row.readAt ?? new Date().toISOString() }));
      emit({ rows });
      await refreshSummary();
      if (state.unreadOnly) await loadFirstPage();
      return result.marked;
    },

    async invokeAction(
      notificationId: string,
      actionId: string,
    ): Promise<{ ok: boolean; status: string | null; error: string | null }> {
      const result = await options.bridge.notifyActionInvoke(notificationId, actionId);
      // Re-read the row so a `mark_read` action or a consumed once-callback
      // updates the list without a full refresh.
      try {
        const fresh = await options.bridge.notifyList({
          unreadOnly: state.unreadOnly || undefined,
          limit: pageSize,
          offset: 0,
        });
        const row = fresh.notifications.find((r) => r.id === notificationId);
        if (row) applyRow(row);
      } catch {
        /* the action already succeeded; a failed re-read must not report failure */
      }
      await refreshSummary();
      return result;
    },

    async zenRefresh(): Promise<ZenState> {
      const zen = await options.bridge.notifyZenStatus();
      emit({ zen });
      return zen;
    },

    async zenStop(): Promise<ZenState> {
      const zen = await options.bridge.notifyZenSnoozeStop();
      emit({ zen });
      return zen;
    },

    /** Subscribe to main's push pings, refreshing the list on each. */
    subscribePush(): () => void {
      return options.bridge.onNotifyPush(() => {
        void this.refresh();
      });
    },
  };
}
