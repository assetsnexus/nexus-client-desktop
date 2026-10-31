import { describe, expect, it, vi } from 'vitest';
import {
  conversationIdOf,
  createInboxService,
  resolveNotificationActionTap,
  resolveNotificationTap,
  visibleNotificationActions,
  type InboxBridge,
} from './inbox-service.js';
import type { NotificationPresentation, NotificationRow } from '../../shared/notifications.js';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n1',
    title: 'Lead assigned',
    body: 'A lead was assigned to you',
    type: 'crm.lead.assigned',
    priority: 'normal',
    tags: [],
    eventKey: 'crm.lead.assigned',
    categoryKey: 'crm.lead',
    presentation: null,
    actionResults: [],
    data: null,
    source: null,
    oauthClientId: null,
    recipientOrgId: null,
    readAt: null,
    unmarkDeadlineAt: null,
    createdAt: '2026-10-31T10:00:00.000Z',
    avatarUrl: '',
    sourceLabel: '',
    sourceKind: '',
    ...overrides,
  };
}

describe('resolveNotificationTap', () => {
  it('maps an https presentation url to an external target', () => {
    const presentation: NotificationPresentation = {
      link: { kind: 'url', url: 'https://example.com/x' },
    };
    expect(
      resolveNotificationTap(row({ presentation }), { portalUrl: 'https://portal.test' }),
    ).toEqual({ kind: 'external', url: 'https://example.com/x' });
  });

  it('prefixes an internal path with the portal origin', () => {
    const presentation: NotificationPresentation = {
      link: { kind: 'path', path: '/b2b/crm/leads/42' },
    };
    expect(
      resolveNotificationTap(row({ presentation }), { portalUrl: 'https://portal.test/' }),
    ).toEqual({ kind: 'portal', url: 'https://portal.test/b2b/crm/leads/42' });
  });

  it('routes a conversation deep link back into the app', () => {
    const presentation: NotificationPresentation = {
      link: { kind: 'path', path: '/conversations/abc' },
    };
    expect(
      resolveNotificationTap(
        row({ presentation, data: { conversationId: 'conv-1' } }),
        { portalUrl: 'https://portal.test' },
      ),
    ).toEqual({ kind: 'chat', conversationId: 'conv-1' });
  });

  it('yields no target when there is no portal origin for a path', () => {
    const presentation: NotificationPresentation = {
      link: { kind: 'path', path: '/b2b/crm/leads/42' },
    };
    expect(resolveNotificationTap(row({ presentation }), { portalUrl: null })).toEqual({
      kind: 'none',
    });
  });

  it('yields no target for an unroutable row', () => {
    expect(resolveNotificationTap(row({ eventKey: null, categoryKey: null }), { portalUrl: 'https://p' })).toEqual(
      { kind: 'none' },
    );
  });
});

describe('conversationIdOf', () => {
  it('reads the conversation id from the data bag', () => {
    expect(conversationIdOf(row({ data: { conversationId: ' c1 ' } }))).toBe('c1');
  });

  it('is null when absent', () => {
    expect(conversationIdOf(row({ data: null }))).toBeNull();
  });
});

describe('visibleNotificationActions', () => {
  const presentation: NotificationPresentation = {
    actions: [
      { id: 'a1', label: 'Open', style: 'primary', kind: 'open' },
      { id: 'a2', label: 'Accept', style: 'secondary', kind: 'callback' },
    ],
  };

  it('returns actions with consumed once-callbacks hidden', () => {
    const actionResults = [{ actionId: 'a2', userId: 'u1', status: 'handled' as const }];
    const actions = visibleNotificationActions(row({ presentation, actionResults }), 'u1');
    expect(actions.map((a) => a.id)).toEqual(['a1']);
  });

  it('keeps a failed once-callback so the user can retry', () => {
    const actionResults = [{ actionId: 'a2', userId: 'u1', status: 'failed' as const }];
    const actions = visibleNotificationActions(row({ presentation, actionResults }), 'u1');
    expect(actions.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('caps the list at three actions', () => {
    const many: NotificationPresentation = {
      actions: Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        label: `A${i}`,
        style: 'link' as const,
        kind: 'open' as const,
      })),
    };
    expect(visibleNotificationActions(row({ presentation: many }), 'u1')).toHaveLength(3);
  });
});

describe('resolveNotificationActionTap', () => {
  it('resolves an open action through its own link', () => {
    const presentation: NotificationPresentation = {
      actions: [
        {
          id: 'a1',
          label: 'Open lead',
          style: 'primary',
          kind: 'open',
          link: { kind: 'path', path: '/b2b/crm/leads/7' },
        },
      ],
    };
    expect(
      resolveNotificationActionTap(row({ presentation }), 'a1', { portalUrl: 'https://p.test' }),
    ).toEqual({ kind: 'portal', url: 'https://p.test/b2b/crm/leads/7' });
  });

  it('yields none for a callback action', () => {
    const presentation: NotificationPresentation = {
      actions: [{ id: 'a1', label: 'Accept', style: 'secondary', kind: 'callback' }],
    };
    expect(resolveNotificationActionTap(row({ presentation }), 'a1', { portalUrl: 'https://p' })).toEqual(
      { kind: 'none' },
    );
  });
});

function bridgeOf(overrides: Partial<InboxBridge> = {}): InboxBridge {
  return {
    notifyList: vi.fn(async () => ({ notifications: [], total: 0 })),
    notifySummary: vi.fn(async () => ({ unread: 0, topPriority: null })),
    notifyMarkRead: vi.fn(async () => ({ notification: null })),
    notifyMarkUnread: vi.fn(async () => ({ notification: null })),
    notifyMarkAllRead: vi.fn(async () => ({ marked: 0 })),
    notifyActionInvoke: vi.fn(async () => ({ ok: true, status: 'handled', error: null })),
    notifyZenStatus: vi.fn(async () => ({ active: false })),
    notifyZenSnoozeStop: vi.fn(async () => ({ active: false })),
    onNotifyPush: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe('createInboxService', () => {
  it('loads the first page and the unread badge', async () => {
    const bridge = bridgeOf({
      notifyList: vi.fn(async () => ({ notifications: [row()], total: 1 })),
      notifySummary: vi.fn(async () => ({ unread: 1, topPriority: 'high' as const })),
    });
    const service = createInboxService({ bridge, getPortalUrl: () => 'https://p' });
    await service.refresh();
    expect(service.getState().rows).toHaveLength(1);
    expect(service.getState().summary.unread).toBe(1);
    expect(service.getState().loading).toBe(false);
  });

  it('reports a load failure instead of dropping the list silently', async () => {
    const bridge = bridgeOf({
      notifyList: vi.fn(async () => {
        throw new Error('region down');
      }),
    });
    const service = createInboxService({ bridge, getPortalUrl: () => 'https://p' });
    await service.refresh();
    expect(service.getState().error).toBe('region down');
    expect(service.getState().loading).toBe(false);
  });

  it('drops a read row when the unread-only filter is on', async () => {
    const read = row({ id: 'n2', readAt: '2026-10-31T11:00:00.000Z' });
    const bridge = bridgeOf({
      notifyList: vi.fn(async () => ({ notifications: [row(), read], total: 2 })),
      notifyMarkRead: vi.fn(async () => ({ notification: { ...row(), readAt: '2026-10-31T12:00:00.000Z' } })),
    });
    const service = createInboxService({ bridge, getPortalUrl: () => 'https://p' });
    await service.refresh();
    await service.setUnreadOnly(true);
    await service.markRead('n1');
    expect(service.getState().rows.some((r) => r.id === 'n1')).toBe(false);
  });

  it('passes the unread-only filter to the region on reload', async () => {
    const notifyList = vi.fn(async () => ({ notifications: [], total: 0 }));
    const service = createInboxService({
      bridge: bridgeOf({ notifyList }),
      getPortalUrl: () => 'https://p',
    });
    await service.setUnreadOnly(true);
    expect(notifyList).toHaveBeenLastCalledWith({ unreadOnly: true, limit: 30, offset: 0 });
  });

  it('marks all read and refreshes the badge', async () => {
    const notifySummary = vi.fn(async () => ({ unread: 0, topPriority: null }));
    const service = createInboxService({
      bridge: bridgeOf({
        notifyList: vi.fn(async () => ({ notifications: [row()], total: 1 })),
        notifySummary,
        notifyMarkAllRead: vi.fn(async () => ({ marked: 1 })),
      }),
      getPortalUrl: () => 'https://p',
    });
    await service.refresh();
    const marked = await service.markAllRead();
    expect(marked).toBe(1);
    expect(service.getState().rows[0].readAt).toBeTruthy();
    expect(notifySummary).toHaveBeenCalled();
  });

  it('refreshes on a push ping', async () => {
    let push: ((ping: { notificationId: string | null }) => void) | null = null;
    const notifyList = vi.fn(async () => ({ notifications: [], total: 0 }));
    const service = createInboxService({
      bridge: bridgeOf({
        notifyList,
        onNotifyPush: vi.fn((listener: (ping: { notificationId: string | null }) => void) => {
          push = listener;
          return () => undefined;
        }),
      }),
      getPortalUrl: () => 'https://p',
    });
    const off = service.subscribePush();
    notifyList.mockClear();
    (push as ((ping: { notificationId: string | null }) => void) | null)?.({ notificationId: 'n9' });
    await Promise.resolve();
    expect(notifyList).toHaveBeenCalled();
    off();
  });
});
