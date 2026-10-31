import { describe, expect, it } from 'vitest';
import {
  canUnmarkNotification,
  countUnread,
  highestPriority,
  isNotificationUnread,
  normalizeNotificationList,
  normalizeNotificationPriority,
  normalizeNotificationRow,
  type NotificationRow,
} from './notifications.js';

const base = {
  _id: 'n1',
  title: 'Lead assigned',
  body: 'You have a new lead',
  priority: 'high',
  tags: ['crm', 7],
  eventKey: 'crm.lead.assigned',
  categoryKey: 'crm.leads',
  readAt: null,
  createdAt: '2026-10-31T10:00:00.000Z',
};

describe('normalizeNotificationRow', () => {
  it('projects a raw region row into the desktop shape', () => {
    const row = normalizeNotificationRow(base);
    expect(row).toMatchObject({
      id: 'n1',
      title: 'Lead assigned',
      body: 'You have a new lead',
      priority: 'high',
      tags: ['crm'],
      eventKey: 'crm.lead.assigned',
      categoryKey: 'crm.leads',
      readAt: null,
      createdAt: '2026-10-31T10:00:00.000Z',
    });
    expect(row && isNotificationUnread(row)).toBe(true);
  });

  it('accepts `id` as well as Mongo `_id` and returns null without one', () => {
    expect(normalizeNotificationRow({ id: 'x' })?.id).toBe('x');
    expect(normalizeNotificationRow({ title: 'no id' })).toBeNull();
    expect(normalizeNotificationRow(null)).toBeNull();
  });

  it('coerces an unknown priority to `normal`', () => {
    expect(normalizeNotificationPriority('urgent')).toBe('normal');
    expect(normalizeNotificationPriority('highest')).toBe('highest');
    expect(normalizeNotificationRow({ ...base, priority: 'urgent' })?.priority).toBe('normal');
  });

  it('clears readAt/unmarkDeadlineAt on an unread row', () => {
    const row = normalizeNotificationRow({
      ...base,
      readAt: null,
      unmarkDeadlineAt: '2026-10-31T10:05:00.000Z',
    });
    expect(row?.readAt).toBeNull();
    expect(row?.unmarkDeadlineAt).toBeNull();
  });

  it('derives an app source from oauthClientId when `source` is absent', () => {
    const row = normalizeNotificationRow({ ...base, oauthClientId: 'client-1' });
    expect(row?.source).toEqual({ kind: 'app', oauthClientId: 'client-1' });
    expect(row?.sourceKind).toBe('app');
  });

  it('keeps action results and drops malformed entries', () => {
    const row = normalizeNotificationRow({
      ...base,
      actionResults: [
        { actionId: 'ack', userId: 'u1', status: 'handled', at: '2026-10-31T10:01:00.000Z' },
        { actionId: 'bad', status: 'nonsense' },
        { status: 'handled' },
      ],
    });
    expect(row?.actionResults).toEqual([
      { actionId: 'ack', userId: 'u1', status: 'handled', at: '2026-10-31T10:01:00.000Z' },
    ]);
  });
});

describe('unread helpers', () => {
  const row = (patch: Partial<NotificationRow> = {}): NotificationRow =>
    normalizeNotificationRow({ ...base, ...patch })!;

  it('is unread exactly when readAt is absent', () => {
    expect(isNotificationUnread(row())).toBe(true);
    expect(isNotificationUnread(row({ readAt: '2026-10-31T10:00:00.000Z' }))).toBe(false);
  });

  it('counts unread rows', () => {
    const read = normalizeNotificationRow({
      ...base,
      _id: 'x',
      readAt: '2026-10-31T10:00:00.000Z',
    })!;
    expect(countUnread([row(), read])).toBe(1);
  });

  it('allows unmark only within the server window on a read row', () => {
    const now = Date.parse('2026-10-31T10:04:00.000Z');
    expect(canUnmarkNotification(row({ readAt: '2026-10-31T10:00:00.000Z', unmarkDeadlineAt: '2026-10-31T10:10:00.000Z' }), now)).toBe(true);
    expect(canUnmarkNotification(row({ readAt: '2026-10-31T10:00:00.000Z', unmarkDeadlineAt: '2026-10-31T10:02:00.000Z' }), now)).toBe(false);
    // Unread rows have nothing to undo.
    expect(canUnmarkNotification(row(), now)).toBe(false);
    // A read row with no deadline cannot be undone.
    expect(canUnmarkNotification(row({ readAt: '2026-10-31T10:00:00.000Z' }), now)).toBe(false);
  });

  it('finds the highest priority for badge tinting', () => {
    expect(highestPriority([])).toBeNull();
    expect(highestPriority([row({ priority: 'low' }), row({ priority: 'highest' })])).toBe('highest');
    expect(highestPriority([row({ priority: 'lowest' }), row({ priority: 'low' })])).toBe('low');
  });
});

describe('normalizeNotificationList', () => {
  it('projects an array and preserves the server total', () => {
    const result = normalizeNotificationList([base, { _id: 'n2' }], 42);
    expect(result.notifications.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(result.total).toBe(42);
  });

  it('falls back to the page length when the total is missing/invalid', () => {
    expect(normalizeNotificationList([base], undefined).total).toBe(1);
    expect(normalizeNotificationList([base], 'many').total).toBe(1);
    expect(normalizeNotificationList(undefined).notifications).toEqual([]);
  });
});
