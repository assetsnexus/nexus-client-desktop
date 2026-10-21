import { describe, expect, it, vi } from 'vitest';
import { createCalendarClient, type CalendarEvent } from './client.js';

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    orgId: 'org',
    uid: 'uid-1',
    title: 'Standup',
    timeZone: 'Europe/Berlin',
    startsAt: '2026-01-01T09:00:00Z',
    endsAt: '2026-01-01T09:30:00Z',
    status: 'confirmed',
    transparency: 'opaque',
    attendees: [],
    links: [],
    ...over,
  };
}

describe('createCalendarClient', () => {
  it('lists events and normalizes the envelope', async () => {
    const send = vi.fn(async () => ({ data: { items: [event()], total: 1, nextCursor: 'c2' } }));
    const client = createCalendarClient(send);
    const out = await client.listEvents({ limit: 10 });
    expect(send).toHaveBeenCalledWith('anx.calendar.event.list', { limit: 10 });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBe('c2');
  });

  it('accepts a direct responseObject (no data wrapper) for lists', async () => {
    const send = vi.fn(async () => ({ items: [event(), event({ id: 'e2' })] }));
    const client = createCalendarClient(send);
    const out = await client.listEvents();
    expect(out.total).toBe(2);
  });

  it('never sends undefined keys on create', async () => {
    const send = vi.fn(async () => ({ data: { event: event() } }));
    const client = createCalendarClient(send);
    await client.createEvent({ title: 'X', timeZone: 'UTC', startsAt: 'a', endsAt: 'b' });
    const [, payload] = send.mock.calls[0];
    expect(Object.keys(payload as object).sort()).toEqual(['endsAt', 'startsAt', 'timeZone', 'title']);
  });

  it('unwraps the event on create/update/cancel/respond', async () => {
    const send = vi.fn(async () => ({ data: { event: event({ title: 'Updated' }) } }));
    const client = createCalendarClient(send);
    expect((await client.createEvent({ title: 'X', timeZone: 'UTC', startsAt: 'a', endsAt: 'b' })).title).toBe('Updated');
    expect((await client.updateEvent('e1', { title: 'Updated' })).title).toBe('Updated');
    expect((await client.cancelEvent('e1', { reason: 'x' })).title).toBe('Updated');
    expect((await client.respond('e1', 'accepted')).title).toBe('Updated');
  });

  it('returns null when getEvent has no event', async () => {
    const send = vi.fn(async () => ({ data: {} }));
    const client = createCalendarClient(send);
    expect(await client.getEvent('missing')).toBeNull();
  });

  it('returns free/busy blocks as an array, defaulting to empty', async () => {
    const send = vi.fn(async () => ({ data: { blocks: [{ start: 'a', end: 'b', status: 'busy' }] } }));
    const client = createCalendarClient(send);
    expect(await client.freeBusy({ from: 'a', to: 'b' })).toHaveLength(1);

    const empty = createCalendarClient(async () => ({ data: {} }));
    expect(await empty.freeBusy({ from: 'a', to: 'b' })).toEqual([]);
  });
});
