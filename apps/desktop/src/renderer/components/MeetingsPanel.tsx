import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { MeetingCard } from '@nexus/meetings-react';
import { resolveOpenTarget } from '@nexus/meetings-core';
import { bridge, type CalendarEventRow } from '../bridge.js';
import { toMeetingCard } from '../meetings/card.js';

const wrap: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1419',
};

const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid #2a333d',
  background: '#12171c',
  flexShrink: 0,
};

const btn: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

/**
 * Meetings panel (Phase 11).
 *
 * Lists upcoming meetings from `anx.calendar.*` and renders each with the shared
 * cross-host `MeetingCard`: clicking a nexus room routes into the desktop room
 * view, provider links open externally, and custom/in-person meetings show
 * their description.
 */
export function MeetingsPanel({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const [rows, setRows] = useState<CalendarEventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setRows(await bridge.calendarUpcoming());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load upcoming meetings');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(row: CalendarEventRow) {
    const target = resolveOpenTarget(toMeetingCard(row));
    if (target.kind === 'room') {
      onOpenRoom(target.roomId);
      return;
    }
    if (target.kind === 'external') {
      await bridge.openExternal(target.url);
    }
    // `describe` targets have no external destination; the card shows the text.
  }

  return (
    <div style={wrap}>
      <header style={head}>
        <strong style={{ fontSize: 13 }}>Upcoming meetings</strong>
        <span style={{ flex: 1 }} />
        {busy ? <span style={{ fontSize: 11, color: '#6b7784' }}>Loading…</span> : null}
        <button type="button" style={btn} onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {error ? <p style={{ padding: '8px 14px', color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, display: 'grid', gap: 8 }}>
        {rows.length === 0 && !busy ? (
          <p style={{ color: '#9aa7b5', fontSize: 13 }}>No upcoming meetings.</p>
        ) : null}
        {rows.map((row) => (
          <MeetingCard key={row.id} card={toMeetingCard(row)} onOpen={() => void open(row)} />
        ))}
      </div>
    </div>
  );
}
