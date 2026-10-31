/**
 * Notification inbox service (main process).
 *
 * Thin bridge over the region's `anx.notification.*` surface. Region-node owns
 * the notifications; this module only calls it, normalizes rows through the
 * shared pure helpers, and caches reads for a short TTL so opening the tab and
 * the push-driven refresh do not each hit the region.
 *
 * Writes invalidate the read cache, so a mark-read is reflected immediately.
 */

import {
  countUnread,
  highestPriority,
  normalizeNotificationList,
  normalizeNotificationRow,
  type NotificationListInput,
  type NotificationListResult,
  type NotificationMarkAllResult,
  type NotificationMutationResult,
  type NotificationRow,
  type NotificationUnreadSummary,
  type ZenSchedule,
  type ZenSnoozeStartInput,
  type ZenState,
} from '../shared/notifications.js';

/** Short TTL: the push ping already drives freshness, so this only dedupes bursts. */
const READ_TTL_MS = 5_000;
/** Inbox reads must not sit on the long AI-command timeout. */
const READ_TIMEOUT_MS = 20_000;

/** Minimal sender shape (matches `authManager.createSender`). */
export type InboxSender = {
  send: (
    command: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => Promise<{
    responseCode: number;
    responseObject?: unknown;
    message?: string;
  }>;
};

export type NotificationInboxOptions = {
  /** Region command sender with the active identity's token. */
  getSender: () => Promise<InboxSender>;
  /** Injectable clock for TTL tests. */
  now?: () => number;
};

export type NotificationInbox = ReturnType<typeof createNotificationInbox>;

class InboxError extends Error {
  responseCode: number;
  code?: string;
  constructor(message: string, responseCode: number, code?: string) {
    super(message);
    this.name = 'InboxError';
    this.responseCode = responseCode;
    this.code = code;
  }
}

function errorFrom(res: { responseCode: number; responseObject?: unknown; message?: string }): InboxError {
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const code = typeof body.error === 'string' ? body.error : undefined;
  const message =
    (typeof body.message === 'string' && body.message) ||
    (typeof body.error === 'string' && body.error) ||
    res.message ||
    `notification command failed (${res.responseCode})`;
  return new InboxError(message, res.responseCode, code);
}

export function createNotificationInbox(options: NotificationInboxOptions) {
  const now = options.now ?? (() => Date.now());
  let listCache: { key: string; at: number; value: NotificationListResult } | null = null;
  let zenCache: { at: number; value: ZenState } | null = null;

  const invalidateReads = (): void => {
    listCache = null;
    zenCache = null;
  };

  const listKey = (input: NotificationListInput): string => JSON.stringify(input ?? {});

  async function execute(
    command: string,
    payload: Record<string, unknown>,
    opts?: { read?: boolean },
  ): Promise<Record<string, unknown>> {
    const sender = await options.getSender();
    const res = await sender.send(command, payload, opts?.read ? { timeoutMs: READ_TIMEOUT_MS } : undefined);
    if (res.responseCode < 200 || res.responseCode >= 300) throw errorFrom(res);
    return (res.responseObject ?? {}) as Record<string, unknown>;
  }

  return {
    /** Recent notifications (newest first), with a short read cache. */
    async list(input: NotificationListInput = {}): Promise<NotificationListResult> {
      const key = listKey(input);
      if (listCache && listCache.key === key && now() - listCache.at < READ_TTL_MS) {
        return listCache.value;
      }
      const body = await execute(
        'anx.notification.list',
        {
          unreadOnly: input.unreadOnly || undefined,
          limit: input.limit,
          offset: input.offset,
          tags: input.tags?.length ? input.tags : undefined,
          priority: input.priority,
          virtualEmployeeId: input.virtualEmployeeId,
        },
        { read: true },
      );
      const value = normalizeNotificationList(body.notifications, body.total);
      listCache = { key, at: now(), value };
      return value;
    },

    /** Cheap unread summary for the tab badge (reuses the list cache). */
    async unreadSummary(): Promise<NotificationUnreadSummary> {
      const { notifications, total } = await this.list({ limit: 50 });
      const unread = countUnread(notifications);
      const unreadRows = notifications.filter((n) => !n.readAt);
      return {
        // The server total is an unread-capable count; prefer the local count when
        // it is larger than the page (a full page of unread rows).
        unread: Math.max(unread, 0) || total,
        topPriority: highestPriority(unreadRows),
      };
    },

    async get(notificationId: string): Promise<NotificationMutationResult> {
      const body = await execute('anx.notification.get', { notificationId }, { read: true });
      return { notification: normalizeNotificationRow(body.notification) };
    },

    async markRead(notificationId: string): Promise<NotificationMutationResult> {
      const body = await execute('anx.notification.mark-read', { notificationId });
      invalidateReads();
      return { notification: normalizeNotificationRow(body.notification) };
    },

    async markUnread(notificationId: string): Promise<NotificationMutationResult> {
      try {
        const body = await execute('anx.notification.mark-unread', { notificationId });
        invalidateReads();
        return { notification: normalizeNotificationRow(body.notification) };
      } catch (e) {
        if (e instanceof InboxError) return { notification: null, code: e.code };
        throw e;
      }
    },

    async markAllRead(): Promise<NotificationMarkAllResult> {
      const body = await execute('anx.notification.mark-all-read', {});
      invalidateReads();
      return { marked: Number(body.marked) || 0 };
    },

    /**
     * Run a callback action. Returns the terminal status. A `409`/`failed`
     * outcome is surfaced as a boolean-ish result rather than thrown, so the UI
     * can show "already handled" without an error state.
     */
    async invokeAction(
      notificationId: string,
      actionId: string,
    ): Promise<{ ok: boolean; status: string | null; error: string | null }> {
      const id = notificationId?.trim();
      const action = actionId?.trim();
      if (!id || !action) return { ok: false, status: null, error: 'missing_action' };
      try {
        const body = await execute('anx.notification.action.invoke', { notificationId: id, actionId: action });
        invalidateReads();
        const status = typeof body.status === 'string' ? body.status : 'handled';
        return { ok: status !== 'failed', status, error: null };
      } catch (e) {
        if (e instanceof InboxError) {
          return { ok: false, status: null, error: e.code ?? 'action_failed' };
        }
        throw e;
      }
    },

    async zenStatus(): Promise<ZenState> {
      if (zenCache && now() - zenCache.at < READ_TTL_MS) return zenCache.value;
      const body = await execute('anx.notification.zen.status', {}, { read: true });
      const value = body as unknown as ZenState;
      zenCache = { at: now(), value };
      return value;
    },

    async zenSnoozeStart(input: ZenSnoozeStartInput = {}): Promise<ZenState> {
      await execute('anx.notification.zen.snooze.start', {
        minutes: input.minutes,
        endsAt: input.endsAt,
        reason: input.reason ?? undefined,
      });
      invalidateReads();
      return this.zenStatus();
    },

    async zenSnoozeStop(): Promise<ZenState> {
      await execute('anx.notification.zen.snooze.stop', {});
      invalidateReads();
      return this.zenStatus();
    },

    async zenScheduleList(): Promise<ZenSchedule[]> {
      const body = await execute('anx.notification.zen.schedule.list', {}, { read: true });
      return Array.isArray(body.schedules) ? (body.schedules as ZenSchedule[]) : [];
    },

    async zenScheduleUpsert(schedule: ZenSchedule): Promise<ZenState> {
      await execute('anx.notification.zen.schedule.upsert', { schedule });
      invalidateReads();
      return this.zenStatus();
    },

    async zenScheduleRemove(scheduleId: string): Promise<ZenState> {
      await execute('anx.notification.zen.schedule.remove', { scheduleId });
      invalidateReads();
      return this.zenStatus();
    },

    /**
     * Fetch one row for a push ping that carried only an opaque id. A miss
     * (deleted / not visible) resolves null rather than throwing so the push
     * handler can simply skip the card.
     */
    async fetchForPush(notificationId: string): Promise<NotificationRow | null> {
      const value = await this.get(notificationId);
      return value.notification;
    },

    /** Drop cached reads (e.g. on sign-out or identity switch). */
    invalidate: invalidateReads,
  };
}
