/**
 * Pure agenda helpers (Phase 7b).
 *
 * No region calls, no DOM — just the date math and shaping the desktop calendar
 * UI needs so it is fully unit-testable. All comparisons are done on absolute
 * UTC instants; the caller's timezone only affects how a day is *bucketed*.
 */

import type { CalendarEvent, MeetingKind } from './client.js';

export type MeetingDescriptor = {
  kind: MeetingKind;
  /** Provider-specific URL to open (zoom/teams/webex/google or a nexus room). */
  joinUrl: string | null;
  /** Nexus conversation room id, when the meeting was provisioned as a room. */
  roomId: string | null;
};

/** Known non-nexus provider tokens, matched leniently from event metadata. */
const PROVIDER_ALIASES: Record<string, MeetingKind> = {
  zoom: 'zoom',
  teams: 'teams',
  msteams: 'teams',
  'ms-teams': 'teams',
  google: 'google_meet',
  'google-meet': 'google_meet',
  google_meet: 'google_meet',
  meet: 'google_meet',
  webex: 'webex',
  nexus: 'nexus',
  anx: 'nexus',
  custom: 'custom',
  in_person: 'in_person',
  'in-person': 'in_person',
  physical: 'in_person',
};

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Normalize a raw provider token to a `MeetingKind`, defaulting to custom. */
export function normalizeMeetingKind(raw: unknown): MeetingKind {
  if (typeof raw !== 'string') return 'in_person';
  const key = raw.trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? 'custom';
}

/**
 * Extract the meeting descriptor from an event's `metadata`.
 *
 * The convention (region follow-up `2026_09_08_taskbar_clock_calendar_connectors`)
 * is `metadata.{ meetingKind, conferenceProvider, joinUrl, roomId }`. Either a
 * provider or a join URL may be present; absence of both means an in-person /
 * plain event with no join target.
 */
export function meetingDescriptor(event: Pick<CalendarEvent, 'metadata'>): MeetingDescriptor {
  const meta = event.metadata ?? {};
  const joinUrl = firstString(meta.joinUrl, meta.conferenceUrl, meta.url);
  const roomId = firstString(meta.roomId, meta.room_id, meta.conversationRoomId);
  const provider = firstString(meta.conferenceProvider, meta.provider);
  const rawKind = firstString(meta.meetingKind, meta.meetingType, meta.kind);

  let kind: MeetingKind;
  if (provider) kind = normalizeMeetingKind(provider);
  else if (roomId && !joinUrl) kind = 'nexus';
  else if (rawKind) kind = normalizeMeetingKind(rawKind);
  else kind = joinUrl ? 'custom' : 'in_person';

  // A nexus room wins as `nexus` when no external provider was declared.
  if (!provider && roomId) kind = 'nexus';

  return { kind, joinUrl, roomId };
}

/** Does this event have something a client can click to join? */
export function hasJoinTarget(event: Pick<CalendarEvent, 'metadata'>): boolean {
  const d = meetingDescriptor(event);
  return Boolean(d.joinUrl || d.roomId);
}

function toTime(value: unknown): number {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Do two events' `[startsAt, endsAt)` windows overlap? Invalid times never overlap. */
export function eventsOverlap(
  a: Pick<CalendarEvent, 'startsAt' | 'endsAt'>,
  b: Pick<CalendarEvent, 'startsAt' | 'endsAt'>,
): boolean {
  const aStart = toTime(a.startsAt);
  const aEnd = toTime(a.endsAt);
  const bStart = toTime(b.startsAt);
  const bEnd = toTime(b.endsAt);
  if ([aStart, aEnd, bStart, bEnd].some((n) => Number.isNaN(n))) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Sort by start time, then end time, then id — a stable display order. */
export function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    const as = toTime(a.startsAt) || 0;
    const bs = toTime(b.startsAt) || 0;
    if (as !== bs) return as - bs;
    const ae = toTime(a.endsAt) || 0;
    const be = toTime(b.endsAt) || 0;
    if (ae !== be) return ae - be;
    return a.id.localeCompare(b.id);
  });
}

/** Local calendar-day key (`YYYY-MM-DD`) for a UTC instant in a given IANA zone. */
export function dayKeyInZone(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  // `en-CA` yields ISO-like YYYY-MM-DD; `formatToParts` avoids locale surprises.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Bucket events into local calendar days (keyed `YYYY-MM-DD`).
 *
 * An event is assigned to the day of its start, in the given zone. Events with
 * unparseable times are dropped.
 */
export function bucketEventsByDay(
  events: CalendarEvent[],
  timeZone: string,
): Map<string, CalendarEvent[]> {
  const buckets = new Map<string, CalendarEvent[]>();
  for (const event of sortEvents(events)) {
    const key = dayKeyInZone(event.startsAt, timeZone);
    if (!key) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(event);
    buckets.set(key, bucket);
  }
  return buckets;
}

/** The upcoming events for a series of day keys, capped per day. */
export function upcomingEvents(
  events: CalendarEvent[],
  opts: { now: string; limit?: number },
): CalendarEvent[] {
  const now = toTime(opts.now);
  const limit = opts.limit ?? 5;
  if (Number.isNaN(now)) return [];
  return sortEvents(
    events.filter((e) => {
      const end = toTime(e.endsAt);
      return Number.isFinite(end) && end >= now;
    }),
  ).slice(0, limit);
}
