/**
 * Desktop calendar manager (Phase 7b, main process).
 *
 * Bridges the region's `anx.calendar.*` surface to the renderer. Region-node
 * owns the calendar; this module only calls it and projects events into a flat,
 * renderer-friendly row (resolving the meeting provider from event metadata).
 *
 * Creating a meeting with `roomId` links the event to a conversation room via
 * `metadata.roomId` — the meeting→room link the plan calls for. Opening a join
 * target prefers the nexus room (returns `roomId` for the caller to route) and
 * falls back to the provider URL.
 */

import {
  createCalendarClient,
  meetingDescriptor,
  type CalendarAttendeeStatus as RegionAttendeeStatus,
  type CalendarEvent,
} from '@nexus/calendar-client';
import type {
  CalendarAttendeeStatus,
  CalendarCreateInput,
  CalendarEventRow,
  CalendarListInput,
} from '../shared/ipc.js';

export type CalendarManagerOptions = {
  /** Region command sender with the active identity's token. */
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
  /** Overridable for tests; defaults to the system zone. */
  resolveTimeZone?: () => string;
};

export type CalendarManager = ReturnType<typeof createCalendarManager>;

export function createCalendarManager(options: CalendarManagerOptions) {
  const resolveTimeZone = options.resolveTimeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function client() {
    const sender = await options.getSender();
    return createCalendarClient(sender.send);
  }

  function toRow(event: CalendarEvent, viewerUserId: string | null): CalendarEventRow {
    const descriptor = meetingDescriptor(event);
    const mine = viewerUserId
      ? event.attendees?.find((a) => a.userId === viewerUserId) ?? null
      : null;
    return {
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone,
      allDay: Boolean(event.allDay),
      status: event.status,
      location: event.location ?? null,
      description: event.description ?? null,
      meetingKind: descriptor.kind,
      joinUrl: descriptor.joinUrl,
      roomId: descriptor.roomId,
      myStatus: mine ? mine.status : null,
    };
  }

  async function list(input: CalendarListInput, viewerUserId: string | null): Promise<CalendarEventRow[]> {
    const cal = await client();
    const out = await cal.listEvents({
      from: input.from,
      to: input.to,
      limit: input.limit,
      includeCancelled: input.includeCancelled,
    });
    return out.items.map((e) => toRow(e, viewerUserId));
  }

  return {
    /** Events in a window (renderer supplies the visible range). */
    async listEvents(input: CalendarListInput, viewerUserId: string | null) {
      return list(input, viewerUserId);
    },

    /** Next N events from now, for the agenda strip. */
    async upcoming(viewerUserId: string | null, limit = 8) {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
      const rows = await list({ from, to, limit: 50 }, viewerUserId);
      return rows
        .filter((r) => Date.parse(r.endsAt) >= Date.now())
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
        .slice(0, limit);
    },

    /**
     * Create an event. A `roomId` (or a nexus-kind meeting) writes
     * `metadata.roomId` so the event links to a conversation room; other kinds
     * write `metadata.{meetingKind, conferenceProvider, joinUrl}`.
     */
    async createEvent(input: CalendarCreateInput, viewerUserId: string | null): Promise<CalendarEventRow> {
      const cal = await client();
      const metadata: Record<string, unknown> = {};
      if (input.meetingKind) metadata.meetingKind = input.meetingKind;
      if (input.joinUrl) {
        metadata.joinUrl = input.joinUrl;
        metadata.conferenceProvider = input.meetingKind ?? 'custom';
      }
      if (input.roomId) metadata.roomId = input.roomId;

      const attendees = (input.attendees ?? []).map((a) => ({
        ...(a.userId ? { userId: a.userId } : {}),
        ...(a.externalEmail ? { externalEmail: a.externalEmail } : {}),
        ...(a.displayName ? { displayName: a.displayName } : {}),
        role: 'required' as const,
        status: 'needs_action' as const,
      }));

      const event = await cal.createEvent({
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timeZone: input.timeZone || resolveTimeZone(),
        description: input.description,
        location: input.location,
        attendees,
        metadata: Object.keys(metadata).length ? metadata : undefined,
        idempotencyKey: `${input.title}:${input.startsAt}`,
      });
      return toRow(event, viewerUserId);
    },

    async cancelEvent(eventId: string): Promise<void> {
      const cal = await client();
      await cal.cancelEvent(eventId, { notifyAttendees: true });
    },

    async respond(eventId: string, status: CalendarAttendeeStatus, viewerUserId: string | null) {
      const cal = await client();
      const event = await cal.respond(eventId, status as RegionAttendeeStatus);
      return toRow(event, viewerUserId);
    },

    /**
     * Resolve where "Join" should go. A nexus room is reported as a `roomId` so
     * the renderer routes to the in-app room; otherwise the external URL is
     * returned for `shell.openExternal`.
     */
    async joinTarget(eventId: string): Promise<{ url: string | null; roomId: string | null }> {
      const cal = await client();
      const event = await cal.getEvent(eventId);
      if (!event) return { url: null, roomId: null };
      const descriptor = meetingDescriptor(event);
      if (descriptor.roomId) return { url: descriptor.joinUrl, roomId: descriptor.roomId };
      return { url: descriptor.joinUrl, roomId: null };
    },
  };
}
