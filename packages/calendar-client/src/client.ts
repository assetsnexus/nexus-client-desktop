/**
 * Region calendar client (Phase 7b).
 *
 * Thin, typed wrapper over the region's `anx.calendar.*` commands. Region-node
 * owns the calendar (portal/app never write events directly); this library is
 * the desktop's read/write path, plus pure agenda helpers the UI needs
 * (day bucketing, overlap, meeting-link detection).
 *
 * The client takes an injected `send` so it works identically from the Electron
 * main process and the CLI, and stays unit-testable with a fake.
 */

export type CalendarSend = (
  command: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

/** Region command envelope is `{ data, responseObject }`; accept both shapes. */
function unwrap(result: unknown): Record<string, unknown> {
  if (result == null || typeof result !== 'object') return {};
  const r = result as Record<string, unknown>;
  const data = r.data;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return r;
}

export type CalendarEventStatus = 'tentative' | 'confirmed' | 'cancelled';
export type CalendarAttendeeStatus = 'needs_action' | 'accepted' | 'declined' | 'tentative';

export type CalendarAttendee = {
  userId?: string;
  aiEmployeeId?: string;
  externalEmail?: string;
  displayName?: string;
  role: 'required' | 'optional' | 'chair' | 'resource';
  status: CalendarAttendeeStatus;
};

export type CalendarLink = { entityType: string; entityId: string; role?: string };

export type CalendarEvent = {
  id: string;
  orgId: string;
  uid: string;
  title: string;
  description?: string;
  location?: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  status: CalendarEventStatus;
  transparency: 'opaque' | 'transparent';
  ownerUserId?: string;
  ownerAiEmployeeId?: string;
  attendees: CalendarAttendee[];
  links: CalendarLink[];
  color?: string;
  metadata?: Record<string, unknown>;
  cancelReason?: string;
};

export type CalendarEventList = { items: CalendarEvent[]; total: number; nextCursor?: string };

/** Meeting-provider metadata carried on an event (Phase 11 catalogs these). */
export type MeetingKind = 'nexus' | 'zoom' | 'teams' | 'google_meet' | 'webex' | 'custom' | 'in_person';

export type CreateEventInput = {
  title: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  status?: CalendarEventStatus;
  transparency?: 'opaque' | 'transparent';
  attendees?: CalendarAttendee[];
  links?: CalendarLink[];
  color?: string;
  /** Meeting metadata: `{ meetingKind, conferenceProvider, joinUrl, roomId }`. */
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  sendEmailInvites?: boolean;
  notifyAnxUsers?: boolean;
};

export type ListEventsInput = {
  from?: string;
  to?: string;
  ownerUserId?: string;
  ownerAiEmployeeId?: string;
  involvingUserId?: string;
  involvingAiEmployeeId?: string;
  linkEntityType?: string;
  linkEntityId?: string;
  status?: CalendarEventStatus;
  includeCancelled?: boolean;
  limit?: number;
  cursor?: string;
};

/** Strip undefined keys so we never send `{from: undefined}` to the region. */
function clean(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export type CalendarClient = ReturnType<typeof createCalendarClient>;

export function createCalendarClient(send: CalendarSend) {
  return {
    async listEvents(input: ListEventsInput = {}): Promise<CalendarEventList> {
      const data = unwrap(await send('anx.calendar.event.list', clean(input)));
      const items = Array.isArray(data.items) ? (data.items as CalendarEvent[]) : [];
      return {
        items,
        total: typeof data.total === 'number' ? data.total : items.length,
        nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : undefined,
      };
    },

    async getEvent(eventId: string): Promise<CalendarEvent | null> {
      const data = unwrap(await send('anx.calendar.event.get', { eventId }));
      const event = (data.event ?? data) as CalendarEvent | undefined;
      return event && typeof event === 'object' && 'id' in event ? event : null;
    },

    async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
      const data = unwrap(await send('anx.calendar.event.create', clean(input)));
      return (data.event ?? data) as CalendarEvent;
    },

    async updateEvent(eventId: string, patch: Partial<CreateEventInput>): Promise<CalendarEvent> {
      const data = unwrap(await send('anx.calendar.event.update', clean({ eventId, ...patch })));
      return (data.event ?? data) as CalendarEvent;
    },

    async cancelEvent(eventId: string, opts: { reason?: string; notifyAttendees?: boolean } = {}) {
      const data = unwrap(
        await send('anx.calendar.event.cancel', clean({ eventId, ...opts })),
      );
      return (data.event ?? data) as CalendarEvent;
    },

    async respond(eventId: string, status: CalendarAttendeeStatus, note?: string): Promise<CalendarEvent> {
      const data = unwrap(await send('anx.calendar.event.respond', clean({ eventId, status, note })));
      return (data.event ?? data) as CalendarEvent;
    },

    /** Identity-wide agenda across personal + org calendars. */
    async agenda(input: { from?: string; to?: string; limitPerOrg?: number } = {}) {
      return unwrap(await send('anx.calendar.identity-agenda.list', clean(input)));
    },

    async freeBusy(input: {
      from: string;
      to: string;
      userIds?: string[];
      aiEmployeeIds?: string[];
      resourceIds?: string[];
    }) {
      const data = unwrap(await send('anx.calendar.free-busy', clean(input)));
      return Array.isArray(data.blocks)
        ? (data.blocks as Array<{ start: string; end: string; status: 'busy' | 'tentative' }>)
        : [];
    },
  };
}
