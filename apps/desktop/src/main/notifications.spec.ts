import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  buildNotificationContent,
  createNotificationManager,
  isUnattended,
  shouldNotify,
  truncatePreview,
  type NotificationContent,
  type NotificationLike,
  type NotificationPayload,
} from './notifications.js';
import type { NotificationSettings } from '../shared/ipc.js';

const basePayload: NotificationPayload = {
  messageId: 'm1',
  conversationId: 'c1',
  contactId: 'ct1',
  agentId: 'a1',
  senderName: 'Ada',
  preview: 'Hello there',
  title: 'Ada',
};

const settings = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({
  ...DEFAULT_NOTIFICATION_SETTINGS,
  ...patch,
});

const focused = { minimized: false, visible: true, focused: true };
const blurred = { minimized: false, visible: true, focused: false };
const minimized = { minimized: true, visible: true, focused: true };
const hidden = { minimized: false, visible: false, focused: false };

describe('isUnattended', () => {
  it('is false only when visible and focused', () => {
    expect(isUnattended(focused)).toBe(false);
    expect(isUnattended(blurred)).toBe(true);
    expect(isUnattended(minimized)).toBe(true);
    expect(isUnattended(hidden)).toBe(true);
  });
});

describe('truncatePreview', () => {
  it('collapses whitespace and trims', () => {
    expect(truncatePreview('  a\n\n  b  ')).toBe('a b');
  });

  it('ellipsizes beyond the limit without exceeding it', () => {
    const out = truncatePreview('x'.repeat(500), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short text untouched', () => {
    expect(truncatePreview('short', 20)).toBe('short');
  });
});

describe('buildNotificationContent', () => {
  it('shows sender + preview for a full card', () => {
    const c = buildNotificationContent(basePayload, settings());
    expect(c.title).toBe('Ada');
    expect(c.body).toBe('Hello there');
  });

  it('title_only hides the message body', () => {
    const c = buildNotificationContent(basePayload, settings({ cardMode: 'title_only' }));
    expect(c.title).toBe('Ada');
    expect(c.body).toBe('');
  });

  it('showPreview:false never leaks the message text', () => {
    const c = buildNotificationContent(basePayload, settings({ showPreview: false }));
    expect(c.body).not.toContain('Hello there');
    // The title already carries the sender, so the body is a neutral notice.
    expect(c.body).toBe('New message');
  });

  it('showPreview:false still shows the sender when the title differs', () => {
    const c = buildNotificationContent(
      { ...basePayload, title: 'Support' },
      settings({ showPreview: false }),
    );
    expect(c.body).toBe('Ada');
    expect(c.body).not.toContain('Hello there');
  });

  it('showSender:false hides the sender', () => {
    const c = buildNotificationContent(basePayload, settings({ showSender: false }));
    expect(c.body).toBe('Hello there');
    expect(c.body).not.toContain('Ada');
  });

  it('hiding both sender and preview yields a neutral notice', () => {
    const c = buildNotificationContent(
      basePayload,
      settings({ showSender: false, showPreview: false }),
    );
    expect(c.body).toBe('New message');
  });

  it('falls back to a generic title when nothing is known', () => {
    const c = buildNotificationContent(
      { ...basePayload, title: null, senderName: null, preview: null },
      settings(),
    );
    expect(c.title).toBe('New message');
  });

  it('sets silent when sound is off (the default)', () => {
    expect(buildNotificationContent(basePayload, settings()).silent).toBe(true);
    expect(buildNotificationContent(basePayload, settings({ sound: true })).silent).toBe(false);
  });
});

describe('shouldNotify', () => {
  it('requires the window to be unattended', () => {
    expect(
      shouldNotify({ settings: settings(), attention: focused, supported: true }),
    ).toBe(false);
    expect(
      shouldNotify({ settings: settings(), attention: blurred, supported: true }),
    ).toBe(true);
  });

  it('respects the master switch and OS support', () => {
    expect(
      shouldNotify({ settings: settings({ enabled: false }), attention: blurred, supported: true }),
    ).toBe(false);
    expect(
      shouldNotify({ settings: settings(), attention: blurred, supported: false }),
    ).toBe(false);
  });
});

function fakeNotification() {
  const listeners: Record<string, () => void> = {};
  const notification: NotificationLike = {
    show: vi.fn(),
    on: (event, listener) => {
      listeners[event] = listener;
    },
  };
  return { notification, listeners };
}

describe('createNotificationManager', () => {
  it('raises a card only when the window is unattended', () => {
    let attention = focused;
    const create = vi.fn((_c: NotificationContent) => fakeNotification().notification);
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => attention,
      createNotification: create,
      isSupported: () => true,
    });

    expect(manager.notify(basePayload)).toBe(false);
    expect(create).not.toHaveBeenCalled();

    attention = blurred;
    expect(manager.notify(basePayload)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('dedupes by message id', () => {
    const create = vi.fn((_c: NotificationContent) => fakeNotification().notification);
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => blurred,
      createNotification: create,
      isSupported: () => true,
    });

    expect(manager.notify(basePayload)).toBe(true);
    expect(manager.notify(basePayload)).toBe(false);
    expect(manager.notify({ ...basePayload, messageId: 'm2' })).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('focuses the window and routes the payload on click', () => {
    const { notification, listeners } = fakeNotification();
    const focusWindow = vi.fn();
    const onActivate = vi.fn();
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => blurred,
      createNotification: () => notification,
      isSupported: () => true,
      focusWindow,
      onActivate,
    });

    manager.notify(basePayload);
    listeners.click?.();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(basePayload);
  });

  it('reports false when no window exists yet', () => {
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => null,
      createNotification: () => fakeNotification().notification,
      isSupported: () => true,
    });
    expect(manager.notify(basePayload)).toBe(false);
  });

  it('survives a throwing native constructor', () => {
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => blurred,
      createNotification: () => {
        throw new Error('no notification daemon');
      },
      isSupported: () => true,
    });
    expect(manager.notify(basePayload)).toBe(false);
  });

  it('reset() clears dedupe state (sign-out)', () => {
    const create = vi.fn((_c: NotificationContent) => fakeNotification().notification);
    const manager = createNotificationManager({
      getSettings: () => settings(),
      getAttention: () => blurred,
      createNotification: create,
      isSupported: () => true,
    });
    expect(manager.notify(basePayload)).toBe(true);
    manager.reset();
    expect(manager.notify(basePayload)).toBe(true);
  });
});
