/**
 * Unsent wake-transcript banner.
 *
 * When the user configures the "keep for review" timeout policy, a wake that was
 * captured but never submitted is parked instead of dropped. This banner is how
 * that queue resurfaces the next time chat opens: one row per transcript, each
 * with Send / Dismiss. It is a convenience surface only — nothing is sent without
 * an explicit click.
 *
 * TRUST: sending a queued transcript is an ordinary user message. It carries no
 * authority and can never approve a command.
 */

import type { CSSProperties } from 'react';
import type { QueuedUtterance } from '../../shared/wake.js';

const banner: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  right: 8,
  zIndex: 15,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 12,
  background: 'rgba(23,20,10,0.96)',
  border: '1px solid #6a5520',
  color: '#f4ecd8',
  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
  maxHeight: '40%',
  overflowY: 'auto',
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
};

const smallButton: CSSProperties = {
  padding: '3px 10px',
  borderRadius: 8,
  border: '1px solid #6a5520',
  background: '#2a2313',
  color: '#f4ecd8',
  cursor: 'pointer',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

function when(at: number): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function WakeQueueBanner({
  entries,
  onSend,
  onDismiss,
}: {
  entries: readonly QueuedUtterance[];
  onSend: (entry: QueuedUtterance) => void;
  onDismiss: (id: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div style={banner} data-nexus-surface="wake-queue">
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 12 }}>
          {entries.length === 1 ? '1 unsent voice note' : `${entries.length} unsent voice notes`}
        </strong>
        <span style={{ fontSize: 10, color: '#a9996240' }}>
          Heard while the app was in the background — nothing was sent.
        </span>
      </div>
      {entries.map((entry) => (
        <div key={entry.id} style={row}>
          <span style={{ color: '#c9b063', whiteSpace: 'nowrap' }}>
            {entry.agentName ?? 'Agent'}
            {entry.phrase ? ` · “${entry.phrase}”` : ''}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.text}
          </span>
          <span style={{ color: '#8a7c55', fontSize: 10 }}>{when(entry.at)}</span>
          <button type="button" style={smallButton} onClick={() => onSend(entry)}>
            Send
          </button>
          <button type="button" style={smallButton} onClick={() => onDismiss(entry.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
