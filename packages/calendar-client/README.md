# @nexus/calendar-client

Headless region calendar client (Phase 7b) for the Nexus desktop and CLI.

Region-node **owns** the calendar (portal/app never write events directly); this
library is the client's typed path over the `anx.calendar.*` command surface,
plus pure agenda helpers so the desktop UI stays testable.

## Client

`createCalendarClient(send)` wraps a narrow `send(command, payload)`:

| Method | Command |
| --- | --- |
| `listEvents` | `anx.calendar.event.list` |
| `getEvent` | `anx.calendar.event.get` |
| `createEvent` | `anx.calendar.event.create` |
| `updateEvent` | `anx.calendar.event.update` |
| `cancelEvent` | `anx.calendar.event.cancel` |
| `respond` | `anx.calendar.event.respond` |
| `agenda` | `anx.calendar.identity-agenda.list` |
| `freeBusy` | `anx.calendar.free-busy` |

It normalizes both response shapes (`{ data }` wrapper and a bare
`responseObject`) and never sends `undefined` keys.

## Agenda helpers (pure)

- `meetingDescriptor` / `normalizeMeetingKind` — resolve the meeting provider
  (`nexus` / `zoom` / `teams` / `google_meet` / `webex` / `custom` / `in_person`)
  and join target from `event.metadata.{ meetingKind, conferenceProvider, joinUrl, roomId }`.
- `hasJoinTarget`, `eventsOverlap`, `sortEvents`, `dayKeyInZone`,
  `bucketEventsByDay`, `upcomingEvents`.

All comparisons use absolute UTC instants; the timezone only affects day
bucketing. The meeting provider catalog is consumed by the Phase 11 meetings SDK
so the same event drives the portal, app, and desktop meeting cards.
