/**
 * Desktop calendar row → shared meeting card (Phase 11).
 *
 * Pure projection so the desktop renders the same card model as the portal and
 * external apps. Kept out of the component so it is unit-testable without the
 * Electron bridge.
 */

import { buildMeetingCard, type MeetingCardModel } from '@nexus/meetings-core';
import type { CalendarEventRow } from '../bridge.js';

export function toMeetingCard(row: CalendarEventRow): MeetingCardModel {
  return buildMeetingCard({
    id: row.id,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    provider: row.meetingKind,
    joinUrl: row.joinUrl,
    roomId: row.roomId,
    location: row.location,
    description: row.description,
    allDay: row.allDay,
    status: row.status,
    myStatus: row.myStatus,
  });
}
