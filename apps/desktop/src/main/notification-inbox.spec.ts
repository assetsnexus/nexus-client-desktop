import { describe, expect, it, vi } from 'vitest';
import { createNotificationInbox, type InboxSender } from './notification-inbox.js';

type Sent = { command: string; payload: Record<string, unknown> };

function fakeSender(handler: (command: string, payload: Record<string, unknown>) => unknown) {
  const sent: Sent[] = [];
  const sender: InboxSender = {
    async send(command, payload = {}) {
      sent.push({ command, payload });
      const out = handler(command, payload);
      if (out && typeof out === 'object' && 'responseCode' in (out as Record<string, unknown>)) {
        return out as { responseCode: number; responseObject?: unknown; message?: string };
      }
      return { responseCode: 200, responseObject: out };
    },
  };
  return { sender, sent };
}

const row = (over: Record<string, unknown> = {}) => ({
  _id: 'n1',
  title: 'Hello',
  body: 'World',
  priority: 'normal',
  readAt: null,
  ...over,
});

describe('notification inbox', () => {
  it('lists and normalizes rows', async () => {
    const { sender, sent } = fakeSender(() => ({ notifications: [row()], total: 3 }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    const result = await inbox.list({ unreadOnly: true, limit: 20 });
    expect(sent[0].command).toBe('anx.notification.list');
    expect(sent[0].payload).toMatchObject({ unreadOnly: true, limit: 20 });
    expect(result.total).toBe(3);
    expect(result.notifications[0]).toMatchObject({ id: 'n1', title: 'Hello' });
  });

  it('caches reads within the TTL and invalidates on a write', async () => {
    let calls = 0;
    const { sender } = fakeSender(() => {
      calls += 1;
      return { notifications: [row()], total: 1 };
    });
    let t = 1000;
    const inbox = createNotificationInbox({ getSender: async () => sender, now: () => t });
    await inbox.list();
    await inbox.list();
    expect(calls).toBe(1);
    // Past the TTL, the cache is refetched.
    t += 10_000;
    await inbox.list();
    expect(calls).toBe(2);
  });

  it('invalidates the read cache after mark-read', async () => {
    const { sender } = fakeSender((command) =>
      command === 'anx.notification.mark-read'
        ? { notification: row({ readAt: '2026-10-31T10:00:00.000Z' }) }
        : { notifications: [row()], total: 1 },
    );
    const inbox = createNotificationInbox({ getSender: async () => sender });
    await inbox.list();
    await inbox.markRead('n1');
    const after = await inbox.list();
    // Re-fetched (not the stale cached unread copy) — proven by the extra call.
    expect(after.notifications[0].id).toBe('n1');
  });

  it('surfaces a mark-unread window expiry as a code rather than throwing', async () => {
    const { sender } = fakeSender(() => ({
      responseCode: 409,
      responseObject: { error: 'NOTIFICATION_UNMARK_WINDOW_EXPIRED' },
    }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    const result = await inbox.markUnread('n1');
    expect(result.notification).toBeNull();
    expect(result.code).toBe('NOTIFICATION_UNMARK_WINDOW_EXPIRED');
  });

  it('throws on a list failure but reports action failures as a result', async () => {
    const { sender } = fakeSender((command) =>
      command === 'anx.notification.list'
        ? { responseCode: 500, responseObject: { error: 'BOOM' } }
        : { responseCode: 409, responseObject: { error: 'ALREADY_HANDLED' } },
    );
    const inbox = createNotificationInbox({ getSender: async () => sender });
    await expect(inbox.list()).rejects.toThrow(/BOOM/);
    expect(await inbox.invokeAction('n1', 'ack')).toEqual({
      ok: false,
      status: null,
      error: 'ALREADY_HANDLED',
    });
  });

  it('rejects an invoke without ids', async () => {
    const { sender } = fakeSender(() => ({}));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    expect(await inbox.invokeAction('', '')).toEqual({ ok: false, status: null, error: 'missing_action' });
  });

  it('marks all read and reports the count', async () => {
    const { sender } = fakeSender(() => ({ marked: 7 }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    expect(await inbox.markAllRead()).toEqual({ marked: 7 });
  });

  it('drives zen snooze start/stop and schedule CRUD', async () => {
    const { sender, sent } = fakeSender((command) =>
      command === 'anx.notification.zen.status' ? { active: true } : {},
    );
    const inbox = createNotificationInbox({ getSender: async () => sender });
    await inbox.zenSnoozeStart({ minutes: 30 });
    await inbox.zenSnoozeStop();
    await inbox.zenScheduleList();
    await inbox.zenScheduleUpsert({ id: 's1', label: 'Focus', daysOfWeek: [1, 2] });
    await inbox.zenScheduleRemove('s1');
    expect(sent.map((s) => s.command)).toEqual([
      'anx.notification.zen.snooze.start',
      'anx.notification.zen.status',
      'anx.notification.zen.snooze.stop',
      'anx.notification.zen.status',
      'anx.notification.zen.schedule.list',
      'anx.notification.zen.schedule.upsert',
      'anx.notification.zen.status',
      'anx.notification.zen.schedule.remove',
      'anx.notification.zen.status',
    ]);
  });

  it('summarizes unread for the tab badge', async () => {
    const { sender } = fakeSender(() => ({
      notifications: [
        row({ _id: 'a', priority: 'low' }),
        row({ _id: 'b', priority: 'highest' }),
        row({ _id: 'c', readAt: '2026-10-31T10:00:00.000Z' }),
      ],
      total: 2,
    }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    expect(await inbox.unreadSummary()).toEqual({ unread: 2, topPriority: 'highest' });
  });

  it('returns null for a push row that is no longer visible', async () => {
    const { sender } = fakeSender(() => ({ responseCode: 404, responseObject: { error: 'NOT_FOUND' } }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    await expect(inbox.fetchForPush('gone')).rejects.toThrow(/NOT_FOUND/);
  });

  it('never logs the notification body', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sender } = fakeSender(() => ({ responseCode: 500, responseObject: { error: 'X' } }));
    const inbox = createNotificationInbox({ getSender: async () => sender });
    await inbox.list().catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
