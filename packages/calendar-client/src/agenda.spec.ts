import { describe, expect, it } from 'vitest';
import {
  bucketEventsByDay,
  dayKeyInZone,
  eventsOverlap,
  hasJoinTarget,
  meetingDescriptor,
  normalizeMeetingKind,
  sortEvents,
  upcomingEvents,
} from './agenda.js';
import type { CalendarEvent } from './client.js';

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    orgId: 'org',
    uid: 'uid-1',
    title: 'Meeting',
    timeZone: 'Europe/Berlin',
    startsAt: '2026-01-01T09:00:00Z',
    endsAt: '2026-01-01T10:00:00Z',
    status: 'confirmed',
    transparency: 'opaque',
    attendees: [],
    links: [],
    ...over,
  };
}

describe('normalizeMeetingKind', () => {
  it('maps provider aliases and defaults unknown to custom', () => {
    expect(normalizeMeetingKind('Zoom')).toBe('zoom');
    expect(normalizeMeetingKind('MS-Teams')).toBe('teams');
    expect(normalizeMeetingKind('google')).toBe('google_meet');
    expect(normalizeMeetingKind('WEBEX')).toBe('webex');
    expect(normalizeMeetingKind('nexus')).toBe('nexus');
    expect(normalizeMeetingKind('acme-meet')).toBe('custom');
    expect(normalizeMeetingKind(undefined)).toBe('in_person');
  });
});

describe('meetingDescriptor', () => {
  it('prefers an explicit conferenceProvider', () => {
    const d = meetingDescriptor(event({ metadata: { conferenceProvider: 'zoom', joinUrl: 'https://z/x' } }));
    expect(d).toEqual({ kind: 'zoom', joinUrl: 'https://z/x', roomId: null });
  });

  it('detects a nexus room when only roomId is present', () => {
    const d = meetingDescriptor(event({ metadata: { roomId: 'room-9' } }));
    expect(d.kind).toBe('nexus');
    expect(d.roomId).toBe('room-9');
    expect(d.joinUrl).toBeNull();
  });

  it('treats a joinUrl-only event as custom', () => {
    expect(meetingDescriptor(event({ metadata: { joinUrl: 'https://x/y' } })).kind).toBe('custom');
  });

  it('is in_person when nothing indicates a remote meeting', () => {
    expect(meetingDescriptor(event()).kind).toBe('in_person');
    expect(meetingDescriptor(event()).joinUrl).toBeNull();
  });

  it('a nexus room wins over a raw meetingKind but not over a provider', () => {
    const withProvider = meetingDescriptor(
      event({ metadata: { meetingKind: 'nexus', conferenceProvider: 'teams', roomId: 'r' } }),
    );
    expect(withProvider.kind).toBe('teams');
    const roomOnly = meetingDescriptor(event({ metadata: { meetingKind: 'custom', roomId: 'r' } }));
    expect(roomOnly.kind).toBe('nexus');
  });
});

describe('hasJoinTarget', () => {
  it('is true when either a join url or a room is present', () => {
    expect(hasJoinTarget(event({ metadata: { joinUrl: 'https://x' } }))).toBe(true);
    expect(hasJoinTarget(event({ metadata: { roomId: 'r' } }))).toBe(true);
    expect(hasJoinTarget(event())).toBe(false);
  });
});

describe('eventsOverlap', () => {
  it('detects overlapping and touching (end==start) ranges', () => {
    const a = { startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-01T10:00:00Z' };
    expect(eventsOverlap(a, { startsAt: '2026-01-01T09:30:00Z', endsAt: '2026-01-01T10:30:00Z' })).toBe(true);
    // back-to-back is not an overlap (half-open interval)
    expect(eventsOverlap(a, { startsAt: '2026-01-01T10:00:00Z', endsAt: '2026-01-01T11:00:00Z' })).toBe(false);
    expect(eventsOverlap(a, { startsAt: '2026-01-01T08:00:00Z', endsAt: '2026-01-01T09:00:00Z' })).toBe(false);
  });

  it('never overlaps on invalid times', () => {
    expect(eventsOverlap({ startsAt: 'nope', endsAt: 'x' }, { startsAt: 'a', endsAt: 'b' })).toBe(false);
  });
});

describe('sortEvents', () => {
  it('orders by start, then end, then id', () => {
    const a = event({ id: 'b', startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-01T10:00:00Z' });
    const b = event({ id: 'a', startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-01T09:30:00Z' });
    const c = event({ id: 'c', startsAt: '2026-01-01T08:00:00Z', endsAt: '2026-01-01T08:30:00Z' });
    expect(sortEvents([a, b, c]).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('dayKeyInZone', () => {
  it('buckets by local day, honoring the zone offset', () => {
    // 23:30 UTC on Jan 1 is Jan 2 in Berlin (UTC+1).
    expect(dayKeyInZone('2026-01-01T23:30:00Z', 'Europe/Berlin')).toBe('2026-01-02');
    expect(dayKeyInZone('2026-01-01T23:30:00Z', 'UTC')).toBe('2026-01-01');
  });

  it('returns an empty key for invalid input', () => {
    expect(dayKeyInZone('nope', 'UTC')).toBe('');
  });
});

describe('bucketEventsByDay', () => {
  it('groups events by their local start day', () => {
    const a = event({ id: 'a', startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-01T10:00:00Z' });
    const b = event({ id: 'b', startsAt: '2026-01-02T09:00:00Z', endsAt: '2026-01-02T10:00:00Z' });
    const buckets = bucketEventsByDay([b, a], 'UTC');
    expect([...buckets.keys()].sort()).toEqual(['2026-01-01', '2026-01-02']);
    expect(buckets.get('2026-01-01')!.map((e) => e.id)).toEqual(['a']);
  });

  it('drops events with invalid times', () => {
    const buckets = bucketEventsByDay([event({ startsAt: 'nope' })], 'UTC');
    expect(buckets.size).toBe(0);
  });
});

describe('upcomingEvents', () => {
  it('keeps events ending at/after now, sorted and capped', () => {
    const past = event({ id: 'past', startsAt: '2026-01-01T08:00:00Z', endsAt: '2026-01-01T09:00:00Z' });
    const now = event({ id: 'now', startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-01T10:00:00Z' });
    const later = event({ id: 'later', startsAt: '2026-01-01T11:00:00Z', endsAt: '2026-01-01T12:00:00Z' });
    const out = upcomingEvents([later, past, now], { now: '2026-01-01T09:30:00Z', limit: 1 });
    expect(out.map((e) => e.id)).toEqual(['now']);
  });

  it('returns empty for an invalid now', () => {
    expect(upcomingEvents([event()], { now: 'nope' })).toEqual([]);
  });
});
