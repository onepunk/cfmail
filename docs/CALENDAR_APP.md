# cfmail Calendar

cfmail Calendar is the scheduling application inside cfmail. Its interaction
model follows the useful, familiar parts of Outlook Calendar while retaining an
independent Cloudflare Workers and D1 implementation.

## Capabilities

- Open Calendar from the cfmail app launcher and return to Mail without another
  sign-in.
- Navigate with a mini month, Today, previous/next controls, and Day, Work week,
  Week, and Month views.
- Create, edit, and delete timed or all-day events in an accessible modal editor.
- Store titles, dates, timezone, location, notes, calendar, busy/free status,
  reminders, and recurrence details.
- Repeat events daily, weekly, monthly, or yearly with a configurable interval
  and optional end date. Recurrences are expanded only for the visible range.
- Keep multiple colour-coded calendars, independently show or hide them, rename
  them, and safely delete non-default calendars with explicit confirmation.
- Search the currently loaded schedule by title, location, or notes.
- See overlapping timed events in separate columns, all-day events in a dedicated
  row, a live current-time marker, and a collapsible agenda.
- Export the loaded source events as an interoperable `.ics` file and print the
  active view.
- Use keyboard shortcuts: `N` creates an event, `T` returns to today, `/` focuses
  search, `1`–`4` switch views, and Alt+Left/Right changes date ranges.
- Use a responsive layout with a slide-out mini calendar and full-screen editing
  experience on small screens.

## Storage and API behaviour

Calendars and events are scoped to the authenticated Cloudflare Access email on
every query. D1 range reads use prepared statements and indexed start/end and
recurrence columns. A request can cover at most 370 days and returns at most
5,000 source events; the client expands recurring instances with a separate
safety cap. Calendar and event deletions are soft deletes and all mutations are
written to the existing audit log.

The `reminderMinutes` value is stored with the event, but cfmail does not deliver
background push or email reminders.

## Compatibility boundary

Calendar export supports the event fields and recurrence patterns implemented by
cfmail. Imported `.ics` files, attendees, meeting responses, shared-calendar
permissions, recurrence exceptions, room availability, cross-tenant free/busy,
dragging, and resizing are not implemented. Editing a recurring occurrence edits
its whole series. Recurrence expansion also uses the event's stored local date
and time rather than recalculating it for a different viewing timezone.
