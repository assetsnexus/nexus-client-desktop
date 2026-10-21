import { describe, expect, it, vi } from 'vitest';
import { createCalendarManager } from './calendar-manager.js';
import type { CalendarEvent } from '@nexus/calendar-client';

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    orgId: 'org',
    uid: 'uid',
    title: 'Standup',
    timeZone: 'Europe/Berlin',
    startsAt: '2026-06-01T09:00:00Z',
    endsAt: '2026-06-01T09:30:00Z',
    status: 'confirmed',
    transparency: 'opaque',
    attendees: [],
    links: [],
    ...over,
  };
}

function manager(handlers: Record<string, (payload: Record<string, unknown>) => unknown>) {
  const send = vi.fn(async (command: string, payload?: Record<string, unknown>) =>
    handlers[command] ? handlers[command](payload ?? {}) : {},
  );
  return { send, m: createCalendarManager({ getSender: async () => ({ send }) }) };
}

describe('calendar manager', () => {
  it('projects list rows with the resolved meeting kind', async () => {
    const { m } = manager({
      'anx.calendar.event.list': () => ({
        data: { items: [event({ metadata: { conferenceProvider: 'zoom', joinUrl: 'https://z/x' } })], total: 1 },
      }),
    });
    const rows = await m.listEvents({}, null);
    expect(rows[0]).toMatchObject({ meetingKind: 'zoom', joinUrl: 'https://z/x', title: 'Standup' });
  });

  it("reports the viewer's own attendee status", async () => {
    const { m } = manager({
      'anx.calendar.event.list': () => ({
        data: {
          items: [event({ attendees: [{ userId: 'me', role: 'required', status: 'accepted' }] })],
        },
      }),
    });
    const rows = await m.listEvents({}, 'me');
    expect(rows[0].myStatus).toBe('accepted');
  });

  it('writes room metadata for a nexus meeting', async () => {
    let sent: Record<string, unknown> = {};
    const { m } = manager({
      'anx.calendar.event.create': (payload) => {
        sent = payload;
        return { data: { event: event({ metadata: { roomId: 'room-1' } }) } };
      },
    });
    const row = await m.createEvent(
      { title: 'Sync', startsAt: 'a', endsAt: 'b', timeZone: 'UTC', meetingKind: 'nexus', roomId: 'room-1' },
      null,
    );
    expect((sent.metadata as Record<string, unknown>).roomId).toBe('room-1');
    expect(row.roomId).toBe('room-1');
    expect(row.meetingKind).toBe('nexus');
  });

  it('writes provider + joinUrl metadata for an external provider', async () => {
    let sent: Record<string, unknown> = {};
    const { m } = manager({
      'anx.calendar.event.create': (payload) => {
        sent = payload;
        return { data: { event: event() } };
      },
    });
    await m.createEvent(
      { title: 'Sync', startsAt: 'a', endsAt: 'b', timeZone: 'UTC', meetingKind: 'teams', joinUrl: 'https://t/x' },
      null,
    );
    const meta = sent.metadata as Record<string, unknown>;
    expect(meta.conferenceProvider).toBe('teams');
    expect(meta.joinUrl).toBe('https://t/x');
  });

  it('maps attendees to the region role/status shape', async () => {
    let sent: Record<string, unknown> = {};
    const { m } = manager({
      'anx.calendar.event.create': (payload) => {
        sent = payload;
        return { data: { event: event() } };
      },
    });
    await m.createEvent(
      {
        title: 'Sync',
        startsAt: 'a',
        endsAt: 'b',
        timeZone: 'UTC',
        attendees: [{ userId: 'u1', displayName: 'Ada' }, { externalEmail: 'x@y.z' }],
      },
      null,
    );
    const attendees = sent.attendees as Array<Record<string, unknown>>;
    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toMatchObject({ userId: 'u1', displayName: 'Ada', role: 'required', status: 'needs_action' });
    expect(attendees[1]).toMatchObject({ externalEmail: 'x@y.z' });
  });

  it('defaults the timezone to the system zone', async () => {
    let sent: Record<string, unknown> = {};
    const send = vi.fn(async (_c: string, payload?: Record<string, unknown>) => {
      sent = payload ?? {};
      return { data: { event: event() } };
    });
    const m = createCalendarManager({
      getSender: async () => ({ send }),
      resolveTimeZone: () => 'America/New_York',
    });
    await m.createEvent({ title: 'X', startsAt: 'a', endsAt: 'b', timeZone: '' }, null);
    expect(sent.timeZone).toBe('America/New_York');
  });

  it('upcoming filters out ended events and sorts by start', async () => {
    const past = event({ id: 'past', startsAt: '2000-01-01T09:00:00Z', endsAt: '2000-01-01T10:00:00Z' });
    const soon = event({ id: 'soon', startsAt: '2999-01-01T09:00:00Z', endsAt: '2999-01-01T10:00:00Z' });
    const later = event({ id: 'later', startsAt: '2999-02-01T09:00:00Z', endsAt: '2999-02-01T10:00:00Z' });
    const { m } = manager({
      'anx.calendar.event.list': () => ({ data: { items: [later, past, soon] } }),
    });
    const rows = await m.upcoming(null);
    expect(rows.map((r) => r.id)).toEqual(['soon', 'later']);
  });

  it('joinTarget prefers the nexus room over the external url', async () => {
    const { m } = manager({
      'anx.calendar.event.get': () => ({
        data: { event: event({ metadata: { roomId: 'room-1', joinUrl: 'https://z/x' } }) },
      }),
    });
    expect(await m.joinTarget('e1')).toEqual({ url: 'https://z/x', roomId: 'room-1' });
  });

  it('joinTarget falls back to the external url', async () => {
    const { m } = manager({
      'anx.calendar.event.get': () => ({
        data: { event: event({ metadata: { conferenceProvider: 'webex', joinUrl: 'https://w/x' } }) },
      }),
    });
    expect(await m.joinTarget('e1')).toEqual({ url: 'https://w/x', roomId: null });
  });

  it('joinTarget returns empty when the event is missing', async () => {
    const { m } = manager({ 'anx.calendar.event.get': () => ({ data: {} }) });
    expect(await m.joinTarget('missing')).toEqual({ url: null, roomId: null });
  });
});
