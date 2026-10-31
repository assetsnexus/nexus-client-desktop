/**
 * Notifications inbox tab.
 *
 * The desktop mirror of the portal's notification inbox: a list of recent
 * notifications with unread highlighting, an unread-only filter, priority
 * badges, inline action CTAs, mark read/unread/all, and click-through routing.
 *
 * The region owns every record and the main process owns the token, so this
 * component only drives `InboxService` (which wraps the `notify*` IPC surface)
 * and renders its state. Routing lives in the service too, so a tap either opens
 * the portal in the OS browser or switches the shell to the chat tab.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { bridge } from '../bridge.js';
import { callBridge, hasBridgeMethod } from '../bridge-compat.js';
import { useI18n } from '../i18n/index.js';
import type {
  NotificationRow as NotificationRowData,
  NotificationVisibleAction,
} from '../../shared/notifications.js';
import { createInboxService, type InboxState } from '../notifications/inbox-service.js';
import { NotificationRow } from './NotificationRow.js';
import { Modal } from './Modal.js';

const wrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflowY: 'auto',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const toolbar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const button: CSSProperties = {
  padding: '7px 12px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 13,
};

const zenBanner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 10,
  background: '#2a2436',
  border: '1px solid #4a3a63',
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: 40,
  textAlign: 'center',
  color: '#6b7784',
  fontSize: 13,
};

/**
 * Resolve the portal origin (for turning an internal notification path into a
 * browser URL). The portal is the canonical reference surface for notifications
 * the desktop has no screen for, so a click hands off to it rather than dead-ends.
 */
async function portalOrigin(): Promise<string | null> {
  try {
    const config = await bridge.getConnectionConfig();
    return config.portalUrl?.trim() || null;
  } catch {
    return null;
  }
}

export function NotificationsPanel({
  /** Switch the shell to the chat tab for a conversation-targeted tap. */
  onOpenConversation,
  /** Report the unread count so the shell tab badge can track it. */
  onUnreadChange,
}: {
  onOpenConversation?: (conversationId?: string) => void;
  onUnreadChange?: (unread: number) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<InboxState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body?: string;
    run: () => void;
  } | null>(null);

  const service = useMemo(
    () =>
      createInboxService({
        bridge,
        getPortalUrl: () => portalUrl,
        getUserId: () => null,
      }),
    [portalUrl],
  );

  useEffect(() => {
    const off = service.subscribe(setState);
    void portalOrigin().then((origin) => {
      setPortalUrl(origin);
      void service.refresh();
    });
    return () => {
      off();
    };
  }, [service]);

  // Keep the shell tab badge in sync with what the panel shows (mark-read and
  // mark-all-read change the unread count without a new push ping).
  useEffect(() => {
    onUnreadChange?.(state?.summary.unread ?? 0);
  }, [state?.summary.unread, onUnreadChange]);

  // A push ping (or the tab regaining focus) refreshes the list, so an inbox left
  // open while a message arrives updates without a manual reload.
  useEffect(() => {
    if (!hasBridgeMethod(bridge, 'onNotifyPush')) return;
    return service.subscribePush();
  }, [service]);

  const openExternal = useCallback((url: string) => {
    void callBridge(bridge, 'openExternal', undefined, url);
  }, []);

  /** Route a resolved tap: chat stays in-app, everything else opens in a browser. */
  const followTap = useCallback(
    (target: ReturnType<typeof service.tapTarget>) => {
      if (target.kind === 'chat') {
        onOpenConversation?.(target.conversationId);
        return;
      }
      if (target.kind === 'portal' || target.kind === 'external') openExternal(target.url);
    },
    [onOpenConversation, openExternal],
  );

  const onRowOpen = useCallback(
    (row: NotificationRowData) => {
      followTap(service.tapTarget(row));
      // Opening a row is an acknowledgement: mark it read (best-effort).
      if (!row.readAt) void service.markRead(row.id).catch(() => undefined);
    },
    [followTap, service],
  );

  const onToggleRead = useCallback(
    (row: NotificationRowData) => {
      setBusyId(row.id);
      const run = row.readAt ? service.markUnread(row.id) : service.markRead(row.id);
      void run.finally(() => setBusyId(null));
    },
    [service],
  );

  const onAction = useCallback(
    (row: NotificationRowData, action: NotificationVisibleAction) => {
      // A callback action is server-side (claim/handle); an open action navigates.
      if (action.kind === 'open') {
        followTap(service.actionTapTarget(row, action.id));
        return;
      }
      const invoke = () => {
        setBusyId(row.id);
        void service.invokeAction(row.id, action.id).finally(() => setBusyId(null));
      };
      // A destructive/confirmed callback asks first, exactly like the portal.
      if (action.confirm) {
        setConfirm({ title: action.confirm.title, body: action.confirm.body, run: invoke });
        return;
      }
      invoke();
    },
    [followTap, service],
  );

  const onMarkAllRead = useCallback(() => {
    void service.markAllRead().catch(() => undefined);
  }, [service]);

  const noBridge = !hasBridgeMethod(bridge, 'notifyList');
  const rows = state?.rows ?? [];
  const unread = state?.summary.unread ?? 0;
  const zenActive = state?.zen?.active === true;

  return (
    <div style={wrap}>
      <div style={toolbar}>
        <h2 style={{ margin: 0, fontSize: 16 }}>
          {t('notifications.title')}
          {unread > 0 ? (
            <span
              style={{
                marginLeft: 8,
                padding: '1px 8px',
                borderRadius: 999,
                background: '#4c8bf5',
                color: '#0b0f14',
                fontSize: 12,
              }}
            >
              {unread}
            </span>
          ) : null}
        </h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...button, background: state?.unreadOnly ? '#243244' : '#1c2430' }}
          onClick={() => void service.setUnreadOnly(!state?.unreadOnly)}
        >
          {t('notifications.unreadOnly')}
        </button>
        <button type="button" style={button} disabled={unread === 0} onClick={onMarkAllRead}>
          {t('notifications.markAllRead')}
        </button>
        <button type="button" style={button} onClick={() => void service.refresh()}>
          {t('notifications.refresh')}
        </button>
      </div>

      {zenActive ? (
        <div style={zenBanner}>
          <span aria-hidden>🌙</span>
          <span style={{ flex: 1 }}>{t('notifications.zen.active')}</span>
          <button type="button" style={button} onClick={() => void service.zenStop()}>
            {t('notifications.zen.stop')}
          </button>
        </div>
      ) : null}

      {state?.error ? (
        <p style={{ margin: 0, color: '#e0736b', fontSize: 13 }}>{state.error}</p>
      ) : null}

      {noBridge ? (
        <p style={emptyStyle}>{t('notifications.unavailable')}</p>
      ) : state?.loading && rows.length === 0 ? (
        <p style={emptyStyle}>{t('notifications.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={emptyStyle}>
          {state?.unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((row) => (
            <NotificationRow
              key={row.id}
              row={row}
              actions={service.visibleActions(row)}
              canUnmark={service.unmarkAllowed(row)}
              busy={busyId === row.id}
              onOpen={() => onRowOpen(row)}
              onToggleRead={() => onToggleRead(row)}
              onAction={(action) => onAction(row, action)}
            />
          ))}
        </div>
      )}

      {state?.hasMore && rows.length > 0 ? (
        <button
          type="button"
          style={{ ...button, alignSelf: 'center' }}
          disabled={state.loadingMore}
          onClick={() => void service.loadMore()}
        >
          {t('notifications.loadMore')}
        </button>
      ) : null}

      {confirm ? (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p style={{ margin: 0, color: '#9aa7b5', fontSize: 13 }}>
            {confirm.body ?? t('notifications.confirm.body')}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" style={button} onClick={() => setConfirm(null)}>
              {t('notifications.confirm.cancel')}
            </button>
            <button
              type="button"
              style={{ ...button, borderColor: '#b4553f' }}
              onClick={() => {
                confirm.run();
                setConfirm(null);
              }}
            >
              {t('notifications.confirm.ok')}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
