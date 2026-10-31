/**
 * One notification row in the inbox list.
 *
 * Split out from the panel so the row's presentation (unread dot, priority
 * badge, action CTAs, media caption) is a self-contained unit and neither file
 * grows large. All copy comes from `t()`; timestamps are rendered relative to the
 * user's locale.
 */

import { useCallback, useState, type CSSProperties } from 'react';
import type {
  NotificationRow as NotificationRowData,
  NotificationVisibleAction,
} from '../../shared/notifications.js';
import { useI18n } from '../i18n/index.js';

const rowStyle = (unread: boolean): CSSProperties => ({
  display: 'flex',
  gap: 12,
  padding: 14,
  borderRadius: 10,
  border: '1px solid #2a333d',
  // An unread row is tinted + gets a dot so it stands out without shouting.
  background: unread ? '#1a2530' : '#151b22',
  borderColor: unread ? '#33506b' : '#2a333d',
});

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#4c8bf5',
  flexShrink: 0,
  marginTop: 6,
};

const avatarStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  flexShrink: 0,
  objectFit: 'cover',
  background: '#0f1419',
  border: '1px solid #2a333d',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: '#e8eef4',
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: '#9aa7b5',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const metaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: '#6b7784',
  flexWrap: 'wrap',
};

const priorityStyle = (color: string): CSSProperties => ({
  padding: '1px 6px',
  borderRadius: 999,
  border: `1px solid ${color}`,
  color,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
});

const actionStyle: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const actionTint: Record<NotificationVisibleAction['style'], string> = {
  primary: '#4c8bf5',
  secondary: '#3a4654',
  danger: '#b4553f',
  link: '#2a333d',
};

const PRIORITY_COLOR: Record<string, string> = {
  highest: '#e0736b',
  high: '#e0a95f',
  normal: '#6b7784',
  low: '#6b7784',
  lowest: '#6b7784',
};

/** Relative time in the active locale, falling back to a short date. */
export function formatRelativeTime(iso: string | null, locale: string, now = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const deltaSec = Math.round((time - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(deltaSec);
  if (abs < 60) return rtf.format(deltaSec, 'second');
  if (abs < 3600) return rtf.format(Math.round(deltaSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(deltaSec / 3600), 'hour');
  if (abs < 604_800) return rtf.format(Math.round(deltaSec / 86_400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(time);
}

export function NotificationRow({
  row,
  actions,
  canUnmark,
  busy,
  onOpen,
  onToggleRead,
  onAction,
}: {
  row: NotificationRowData;
  actions: NotificationVisibleAction[];
  /** Whether the undo window still allows flipping a read row to unread. */
  canUnmark: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggleRead: () => void;
  onAction: (action: NotificationVisibleAction) => void;
}) {
  const { t, locale } = useI18n();
  const unread = !row.readAt;
  const [expanded, setExpanded] = useState(false);
  // Only the urgent buckets carry a badge; `normal`/low are the quiet default.
  const badgeKey =
    row.priority === 'highest'
      ? 'notifications.priority.highest'
      : row.priority === 'high'
        ? 'notifications.priority.high'
        : null;

  const open = useCallback(() => {
    if (row.body && row.body.length > 220) setExpanded((v) => !v);
    onOpen();
  }, [row.body, onOpen]);

  return (
    <article style={rowStyle(unread)} aria-label={row.title}>
      {unread ? <span style={dotStyle} aria-hidden /> : <span style={{ width: 8, flexShrink: 0 }} />}
      {row.avatarUrl ? <img src={row.avatarUrl} alt="" style={avatarStyle} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={open}
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={titleStyle}>{row.title}</strong>
            {badgeKey ? (
              <span style={priorityStyle(PRIORITY_COLOR[row.priority] ?? '#6b7784')}>{t(badgeKey)}</span>
            ) : null}
          </span>
          {row.body && expanded ? <span style={bodyStyle}>{row.body}</span> : null}
          {row.body && !expanded ? (
            <span
              style={{
                ...bodyStyle,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.body}
            </span>
          ) : null}
        </button>

        <span style={metaStyle}>
          {row.sourceLabel ? <span>{row.sourceLabel}</span> : null}
          <span>{formatRelativeTime(row.createdAt, locale)}</span>
          {row.tags.slice(0, 3).map((tag) => (
            <span key={tag} style={{ color: '#4c6480' }}>
              #{tag}
            </span>
          ))}
        </span>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={busy}
              style={{ ...actionStyle, borderColor: actionTint[action.style] }}
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy || (!unread && !canUnmark)}
            style={{ ...actionStyle, borderColor: '#2a333d' }}
            onClick={onToggleRead}
          >
            {unread ? t('notifications.markRead') : t('notifications.markUnread')}
          </button>
        </div>
      </div>
    </article>
  );
}

