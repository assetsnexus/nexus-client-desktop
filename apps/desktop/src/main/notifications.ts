/**
 * Desktop OS notifications for new chat messages.
 *
 * The renderer owns the chat stream, so it *reports* inbound messages here over
 * IPC; the main process decides whether the window is unattended and, if so,
 * raises a native notification. Keeping the decision in main means the rules
 * (window focused? sound on?) are enforced in one place and the renderer cannot
 * accidentally bypass them.
 *
 * Pure helpers (`windowAttention`, `buildNotificationContent`, `shouldNotify`)
 * are exported separately so the policy is unit-testable without Electron.
 */

import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../shared/ipc.js';

export { DEFAULT_NOTIFICATION_SETTINGS };

/** What the renderer reports about an inbound message. Never contains secrets. */
export type NotificationPayload = {
  /** Stable id used to suppress duplicate notifications for one message. */
  messageId: string;
  /** Conversation the message belongs to, for click-through routing. */
  conversationId: string | null;
  contactId: string | null;
  agentId: string | null;
  /** Display name of the sender (agent or person), when known. */
  senderName: string | null;
  /** Message text; only used when the user allows a preview. */
  preview: string | null;
  /** Conversation/agent title, used as the notification title. */
  title: string | null;
};

/** The three window states that decide whether the user is "away". */
export type WindowAttention = {
  minimized: boolean;
  visible: boolean;
  focused: boolean;
};

/**
 * True when the window does not have the user's attention, i.e. a notification
 * is worth raising. Minimized, hidden (tray), or merely unfocused all count.
 */
export function isUnattended(state: WindowAttention): boolean {
  return state.minimized || !state.visible || !state.focused;
}

/** Truncate a preview so a long message cannot produce an enormous card. */
export function truncatePreview(text: string, max = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type NotificationContent = {
  title: string;
  body: string;
  /** Electron `silent`: true when the user asked for no sound. */
  silent: boolean;
};

/**
 * Build the title/body for a card, honouring the user's privacy settings.
 *
 * - `title_only` shows just the sender line and no message text.
 * - `showSender: false` hides who sent it.
 * - `showPreview: false` shows a neutral placeholder instead of the message.
 * - `locked: true` (with `suppressWhenLocked`) replaces the whole card with a
 *   neutral notice, so a locked machine never shows sender or content.
 *
 * When both sender and preview are hidden the body is a generic notice, so a
 * notification never leaks message content the user chose to hide.
 */
export function buildNotificationContent(
  payload: NotificationPayload,
  settings: NotificationSettings,
  opts: { locked?: boolean } = {},
): NotificationContent {
  // The lock gate wins over everything: a locked app shows no content at all.
  // The *title* must be neutral too — it is the conversation/agent title, which
  // for a direct message is the sender's own name, so keeping it would leak
  // exactly who is writing while the machine is locked.
  if (opts.locked && settings.suppressWhenLocked) {
    return {
      title: 'Nexus',
      body: 'New message (hidden while the app is locked)',
      silent: !settings.sound,
    };
  }

  const title = payload.title?.trim() || payload.senderName?.trim() || 'New message';
  const sender = payload.senderName?.trim() || null;

  const parts: string[] = [];
  if (settings.showSender && sender && sender !== title) parts.push(sender);

  if (settings.cardMode === 'full' && settings.showPreview && payload.preview?.trim()) {
    parts.push(truncatePreview(payload.preview));
  }

  const body =
    parts.length > 0
      ? parts.join('\n')
      : settings.cardMode === 'title_only'
        ? ''
        : 'New message';

  return { title, body, silent: !settings.sound };
}

/**
 * The full gate: enabled, window unattended, and there is something to show.
 * A `title_only` card with no sender still fires, because the title alone
 * ("New message") is the intended minimum signal.
 */
export function shouldNotify(input: {
  settings: NotificationSettings;
  attention: WindowAttention;
  supported: boolean;
}): boolean {
  if (!input.supported) return false;
  if (!input.settings.enabled) return false;
  return isUnattended(input.attention);
}

/** Minimal shape of an Electron `Notification` we depend on (for test doubles). */
export type NotificationLike = {
  show(): void;
  on(event: 'click', listener: () => void): void;
  on(event: 'close', listener: () => void): void;
};

export type NotificationManagerDeps = {
  getSettings: () => NotificationSettings;
  /** Current window attention; `null` when no window exists yet. */
  getAttention: () => WindowAttention | null;
  /**
   * Whether the app UI is currently locked behind the PIN gate. When locked and
   * `suppressWhenLocked` is on, the card carries no sender/content.
   */
  isLocked?: () => boolean;
  /** Whether the OS can raise native notifications at all. */
  isSupported?: () => boolean;
  /** Construct a native notification (injectable for tests). */
  createNotification?: (content: NotificationContent) => NotificationLike;
  /** Bring the app to the foreground (main window show + focus). */
  focusWindow?: () => void;
  /** Called when the user clicks a notification, to route the renderer. */
  onActivate?: (payload: NotificationPayload) => void;
};

export type NotificationManager = {
  /**
   * Report an inbound message. Returns true when a card was raised.
   * `force` bypasses the "window unattended" gate, for an explicit test.
   */
  notify(payload: NotificationPayload, opts?: { force?: boolean }): boolean;
  /** Settings changed: apply anything that needs to react (no-op today). */
  applySettings(): void;
  /** Forget dedupe state (e.g. on sign-out). */
  reset(): void;
};

export function createNotificationManager(deps: NotificationManagerDeps): NotificationManager {
  const isSupported = deps.isSupported ?? (() => true);
  // Bounded dedupe: the renderer re-reports on state replay, so remember the
  // most recent ids and never raise the same message twice.
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const remember = (id: string): void => {
    if (seenSet.has(id)) return;
    seenSet.add(id);
    seen.push(id);
    if (seen.length > 200) {
      const dropped = seen.shift();
      if (dropped) seenSet.delete(dropped);
    }
  };

  return {
    notify(payload, opts) {
      const settings = deps.getSettings();
      const attention = deps.getAttention();
      if (!attention) return false;
      if (!opts?.force) {
        if (!shouldNotify({ settings, attention, supported: isSupported() })) return false;
      } else if (!isSupported()) {
        return false;
      }
      if (!payload.messageId || seenSet.has(payload.messageId)) return false;
      remember(payload.messageId);

      const content = buildNotificationContent(payload, settings, {
        locked: deps.isLocked?.() === true,
      });
      const create = deps.createNotification;
      if (!create) return false;

      try {
        const notification = create(content);
        notification.on('click', () => {
          deps.focusWindow?.();
          deps.onActivate?.(payload);
        });
        notification.show();
        return true;
      } catch {
        // A failing notification must never break message handling.
        return false;
      }
    },
    applySettings() {
      /* Nothing cached today; the settings are read per notification. */
    },
    reset() {
      seen.length = 0;
      seenSet.clear();
    },
  };
}
