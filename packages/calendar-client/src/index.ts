/**
 * `@nexus/calendar-client` — Phase 7b desktop calendar.
 *
 * Typed `anx.calendar.*` calls plus pure agenda helpers (day bucketing, overlap,
 * meeting-provider detection). Region-node owns the calendar; this is the
 * desktop's read/write path and never talks to any other backend.
 */

export {
  createCalendarClient,
  type CalendarClient,
  type CalendarSend,
  type CalendarEvent,
  type CalendarEventList,
  type CalendarEventStatus,
  type CalendarAttendee,
  type CalendarAttendeeStatus,
  type CalendarLink,
  type CreateEventInput,
  type ListEventsInput,
  type MeetingKind,
} from './client.js';

export {
  bucketEventsByDay,
  dayKeyInZone,
  eventsOverlap,
  hasJoinTarget,
  meetingDescriptor,
  normalizeMeetingKind,
  sortEvents,
  upcomingEvents,
  type MeetingDescriptor,
} from './agenda.js';
