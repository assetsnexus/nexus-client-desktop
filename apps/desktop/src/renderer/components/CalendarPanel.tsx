import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  bridge,
  type CalendarCreateInput,
  type CalendarEventRow,
  type CalendarMeetingKind,
} from '../bridge.js';

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

const primaryBtn: CSSProperties = { ...btn, border: '1px solid #3f6cb0', background: '#2f5c9e', color: '#fff', fontWeight: 600 };

const input: CSSProperties = {
  padding: '7px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

const kindColors: Record<CalendarMeetingKind, string> = {
  nexus: '#7aa2f7',
  zoom: '#4a9eff',
  teams: '#8b8bf5',
  google_meet: '#4ade80',
  webex: '#38bdf8',
  custom: '#a78bfa',
  in_person: '#94a3b8',
};

const kindLabels: Record<CalendarMeetingKind, string> = {
  nexus: 'Nexus room',
  zoom: 'Zoom',
  teams: 'Teams',
  google_meet: 'Google Meet',
  webex: 'Webex',
  custom: 'Custom',
  in_person: 'In person',
};

const KINDS: CalendarMeetingKind[] = ['nexus', 'zoom', 'teams', 'google_meet', 'webex', 'custom', 'in_person'];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO without the `Z` (local wall-clock), for a datetime-local input value. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Desktop calendar (Phase 7b).
 *
 * Week strip + agenda over `anx.calendar.*`. Region-node owns the calendar; the
 * panel only reads/writes through the IPC bridge. "Join" opens external
 * providers in the browser and routes nexus-room meetings back into the app.
 */
export function CalendarPanel() {
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const [duration, setDuration] = useState(30);
  const [kind, setKind] = useState<CalendarMeetingKind>('nexus');
  const [joinUrl, setJoinUrl] = useState('');
  const [roomId, setRoomId] = useState('');

  const weekStart = useMemo(() => anchor, [anchor]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const from = addDays(weekStart, -1);
      const to = addDays(weekStart, 8);
      const rows = await bridge.calendarListEvents({ from: from.toISOString(), to: to.toISOString(), limit: 200 });
      setEvents(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load the calendar');
    } finally {
      setBusy(false);
    }
  }, [weekStart]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
    for (const e of events) {
      const key = dayKey(new Date(e.startsAt));
      const bucket = map.get(key) ?? [];
      bucket.push(e);
      map.set(key, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    }
    return map;
  }, [events]);

  async function createEvent() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const startDate = new Date(start);
      const input: CalendarCreateInput = {
        title: title.trim(),
        startsAt: startDate.toISOString(),
        endsAt: new Date(startDate.getTime() + duration * 60_000).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        meetingKind: kind,
        joinUrl: joinUrl.trim() || undefined,
        roomId: roomId.trim() || undefined,
      };
      await bridge.calendarCreateEvent(input);
      setComposing(false);
      setTitle('');
      setJoinUrl('');
      setRoomId('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create the meeting');
    } finally {
      setBusy(false);
    }
  }

  async function join(row: CalendarEventRow) {
    setNotice(null);
    try {
      const res = await bridge.calendarOpenJoin(row.id);
      if (!res.opened && res.roomId) {
        setNotice(`This meeting runs in a Nexus room (${res.roomId}). Open it from Rooms.`);
      } else if (!res.opened && !res.url) {
        setNotice('This meeting has no join link yet.');
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'could not open the meeting');
    }
  }

  async function cancel(row: CalendarEventRow) {
    setBusy(true);
    try {
      await bridge.calendarCancelEvent(row.id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function respond(row: CalendarEventRow, status: 'accepted' | 'declined' | 'tentative') {
    setBusy(true);
    try {
      await bridge.calendarRespond(row.id, status);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  return (
    <div style={wrap}>
      <div style={head}>
        <button type="button" style={btn} onClick={() => setAnchor(addDays(weekStart, -7))}>
          ‹
        </button>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        <button type="button" style={btn} onClick={() => setAnchor(addDays(weekStart, 7))}>
          ›
        </button>
        <button type="button" style={btn} onClick={() => setAnchor(startOfDay(new Date()))}>
          Today
        </button>
        <span style={{ flex: 1 }} />
        {busy ? <span style={{ fontSize: 11, color: '#6b7784' }}>Loading…</span> : null}
        <button type="button" style={primaryBtn} onClick={() => setComposing((v) => !v)}>
          {composing ? 'Close' : 'New meeting'}
        </button>
      </div>

      {composing ? (
        <div style={{ padding: 12, borderBottom: '1px solid #2a333d', display: 'grid', gap: 8 }}>
          <input style={input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ ...input, flex: 2 }}
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <select style={input} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[15, 30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <select style={input} value={kind} onChange={(e) => setKind(e.target.value as CalendarMeetingKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabels[k]}
                </option>
              ))}
            </select>
          </div>
          {kind === 'nexus' ? (
            <input
              style={input}
              placeholder="Nexus room id (optional — links the meeting to a room)"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
          ) : kind !== 'in_person' ? (
            <input
              style={input}
              placeholder="Join URL (https://…)"
              value={joinUrl}
              onChange={(e) => setJoinUrl(e.target.value)}
            />
          ) : null}
          <button type="button" style={primaryBtn} onClick={() => void createEvent()} disabled={busy || !title.trim()}>
            Create
          </button>
        </div>
      ) : null}

      {error ? <p style={{ padding: '8px 14px', color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}
      {notice ? <p style={{ padding: '8px 14px', color: '#fbbf24', fontSize: 12 }}>{notice}</p> : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', overflow: 'hidden' }}>
          {weekDays.map((day) => {
            const key = dayKey(day);
            const dayEvents = byDay.get(key) ?? [];
            const isToday = key === dayKey(new Date());
            return (
              <div
                key={key}
                style={{
                  borderRight: '1px solid #1e2731',
                  padding: 6,
                  overflowY: 'auto',
                  background: isToday ? '#131b24' : 'transparent',
                }}
              >
                <div style={{ fontSize: 11, color: '#6b7784', marginBottom: 6 }}>
                  {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                </div>
                {dayEvents.map((row) => (
                  <EventCard key={row.id} row={row} onJoin={join} onCancel={cancel} onRespond={respond} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EventCard({
  row,
  onJoin,
  onCancel,
  onRespond,
}: {
  row: CalendarEventRow;
  onJoin: (row: CalendarEventRow) => void;
  onCancel: (row: CalendarEventRow) => void;
  onRespond: (row: CalendarEventRow, status: 'accepted' | 'declined' | 'tentative') => void;
}) {
  const time = new Date(row.startsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const cancelled = row.status === 'cancelled';
  return (
    <div
      style={{
        borderLeft: `3px solid ${kindColors[row.meetingKind]}`,
        background: '#151b22',
        borderRadius: 6,
        padding: '6px 8px',
        marginBottom: 6,
        opacity: cancelled ? 0.5 : 1,
        textDecoration: cancelled ? 'line-through' : 'none',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600 }}>{row.title}</div>
      <div style={{ fontSize: 11, color: '#6b7784' }}>
        {row.allDay ? 'All day' : time} · {kindLabels[row.meetingKind]}
      </div>
      {row.myStatus === 'needs_action' ? (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <button type="button" style={{ ...btn, padding: '2px 6px' }} onClick={() => onRespond(row, 'accepted')}>
            Accept
          </button>
          <button type="button" style={{ ...btn, padding: '2px 6px' }} onClick={() => onRespond(row, 'declined')}>
            Decline
          </button>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
        {row.joinUrl || row.roomId ? (
          <button type="button" style={{ ...btn, padding: '2px 6px' }} onClick={() => onJoin(row)}>
            Join
          </button>
        ) : null}
        {!cancelled ? (
          <button type="button" style={{ ...btn, padding: '2px 6px' }} onClick={() => onCancel(row)}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
