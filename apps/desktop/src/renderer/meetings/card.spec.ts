import { describe, expect, it } from 'vitest';
import { resolveOpenTarget } from '@nexus/meetings-core';
import { toMeetingCard } from './card.js';
import type { CalendarEventRow } from '../../shared/ipc.js';

function row(over: Partial<CalendarEventRow>): CalendarEventRow {
  return {
    id: 'e1',
    title: 'Sync',
    startsAt: '2026-05-01T09:00:00.000Z',
    endsAt: '2026-05-01T09:30:00.000Z',
    timeZone: 'UTC',
    allDay: false,
    status: 'confirmed',
    location: null,
    description: null,
    meetingKind: 'nexus',
    joinUrl: null,
    roomId: null,
    myStatus: null,
    ...over,
  };
}

describe('toMeetingCard', () => {
  it('maps a region calendar row onto the shared card model', () => {
    const card = toMeetingCard(row({ location: 'HQ', description: 'Weekly' }));
    expect(card.id).toBe('e1');
    expect(card.title).toBe('Sync');
    expect(card.provider).toBe('nexus');
    expect(card.location).toBe('HQ');
    expect(card.description).toBe('Weekly');
  });

  it('routes a nexus room meeting back into the app', () => {
    const card = toMeetingCard(row({ meetingKind: 'nexus', roomId: 'room-7' }));
    expect(resolveOpenTarget(card)).toEqual({ kind: 'room', roomId: 'room-7' });
  });

  it('routes an external provider meeting to the provider URL', () => {
    const card = toMeetingCard(
      row({ meetingKind: 'zoom', joinUrl: 'https://zoom.us/j/42', roomId: null }),
    );
    expect(resolveOpenTarget(card)).toEqual({ kind: 'external', url: 'https://zoom.us/j/42' });
  });

  it('shows the description when a custom meeting has no URL', () => {
    const card = toMeetingCard(
      row({ meetingKind: 'custom', joinUrl: null, description: 'Meet at the office' }),
    );
    const target = resolveOpenTarget(card);
    expect(target.kind).toBe('describe');
  });
});
