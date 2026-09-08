import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Grid3X3,
  List,
  LogOut,
  Mail,
  MapPin,
  Menu,
  MoreHorizontal,
  PanelRight,
  Plus,
  Printer,
  Repeat2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalendarAvailability,
  CalendarEventInput,
  CalendarEventRecord,
  CalendarRecord,
  CalendarRecurrenceFrequency,
} from "../shared/types";
import { mailApi } from "./api";
import {
  addDays,
  dateKey,
  expandCalendarEvents,
  isSameDay,
  layoutTimedOccurrences,
  occurrencesForDay,
  shiftAnchor,
  startOfDay,
  type CalendarOccurrence,
  type CalendarView,
  visibleDays,
  visibleRange,
} from "./calendarModel";
import "./calendar.css";

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CALENDAR_COLORS = ["#0f6cbd", "#8764b8", "#d83b01", "#107c10", "#c239b3", "#008272", "#ca5010", "#5c2d91"];

interface CalendarAppProps {
  userEmail: string;
  onExit: () => void;
  onLogout: () => void;
}

interface EventDraft {
  title: string;
  calendarId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  timezone: string;
  location: string;
  description: string;
  availability: CalendarAvailability;
  recurrenceFrequency: CalendarRecurrenceFrequency;
  recurrenceInterval: number;
  recurrenceUntil: string;
  reminderMinutes: string;
}

export function CalendarApp(props: CalendarAppProps) {
  const [calendars, setCalendars] = useState<CalendarRecord[]>([]);
  const [events, setEvents] = useState<CalendarEventRecord[]>([]);
  const [visibleCalendarIds, setVisibleCalendarIds] = useState<string[]>([]);
  const [view, setView] = useState<CalendarView>("workweek");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [editor, setEditor] = useState<{ event: CalendarEventRecord | null; start: Date; allDay: boolean } | null>(null);
  const [calendarEditor, setCalendarEditor] = useState<CalendarRecord | null | "new">(null);
  const eventRequest = useRef(0);
  const calendarBootstrapStarted = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const range = useMemo(() => visibleRange(anchor, view), [anchor, view]);

  const loadCalendars = useCallback(async () => {
    try {
      let next = (await mailApi.calendars()).calendars;
      if (!next.length) next = [(await mailApi.createCalendar({ name: "Calendar", color: CALENDAR_COLORS[0] })).calendar];
      setCalendars(next);
      setVisibleCalendarIds((current) => {
        const available = new Set(next.map((calendar) => calendar.id));
        const preserved = current.filter((id) => available.has(id));
        return preserved.length ? preserved : next.map((calendar) => calendar.id);
      });
    } catch {
      setStatus("Your calendars could not be loaded.");
    }
  }, []);

  const loadEvents = useCallback(async () => {
    const requestId = ++eventRequest.current;
    setLoading(true);
    try {
      const result = await mailApi.calendarEvents(range.start.toISOString(), range.end.toISOString());
      if (eventRequest.current === requestId) setEvents(result.events);
    } catch {
      if (eventRequest.current === requestId) setStatus("Events could not be loaded for this date range.");
    } finally {
      if (eventRequest.current === requestId) setLoading(false);
    }
  }, [range.end.valueOf(), range.start.valueOf()]);

  useEffect(() => {
    if (calendarBootstrapStarted.current) return;
    calendarBootstrapStarted.current = true;
    void loadCalendars();
  }, [loadCalendars]);
  useEffect(() => void loadEvents(), [loadEvents]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable || editor || calendarEditor) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        setEditor({ event: null, start: nextWholeHour(selectedDate), allDay: false });
      } else if (key === "t") {
        event.preventDefault();
        const today = new Date();
        setAnchor(today);
        setSelectedDate(today);
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        setView(({ "1": "day", "2": "workweek", "3": "week", "4": "month" } as const)[event.key as "1"]);
      } else if (event.key === "ArrowLeft" && event.altKey) setAnchor((current) => shiftAnchor(current, view, -1));
      else if (event.key === "ArrowRight" && event.altKey) setAnchor((current) => shiftAnchor(current, view, 1));
    }
    document.addEventListener("keydown", shortcuts);
    return () => document.removeEventListener("keydown", shortcuts);
  }, [calendarEditor, editor, selectedDate, view]);

  const occurrences = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return expandCalendarEvents(
      events.filter((event) => visibleCalendarIds.includes(event.calendarId)),
      range.start,
      range.end,
    ).filter((event) => !normalizedQuery || [event.title, event.location, event.description].some((value) => value.toLowerCase().includes(normalizedQuery)));
  }, [events, query, range.end.valueOf(), range.start.valueOf(), visibleCalendarIds]);

  const openNewEvent = useCallback((date: Date, allDay = false) => {
    setSelectedDate(date);
    setEditor({ event: null, start: allDay ? startOfDay(date) : date, allDay });
  }, []);

  const openEvent = useCallback((occurrence: CalendarOccurrence) => {
    const event = events.find((candidate) => candidate.id === occurrence.id);
    if (event) setEditor({ event, start: new Date(event.startAt), allDay: event.allDay });
  }, [events]);

  async function saveEvent(id: string | null, input: CalendarEventInput) {
    try {
      const result = id ? await mailApi.updateCalendarEvent(id, input) : await mailApi.createCalendarEvent(input);
      setEvents((current) => id ? current.map((event) => event.id === id ? result.event : event) : [...current, result.event]);
      setEditor(null);
      setStatus(id ? "Event updated." : "Event added to your calendar.");
      void loadEvents();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The event could not be saved.");
      throw error;
    }
  }

  async function deleteEvent(id: string) {
    try {
      await mailApi.deleteCalendarEvent(id);
      setEvents((current) => current.filter((event) => event.id !== id));
      setEditor(null);
      setStatus("Event deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The event could not be deleted.");
      throw error;
    }
  }

  async function saveCalendar(id: string | null, input: { name: string; color: string }) {
    try {
      const result = id ? await mailApi.updateCalendar(id, input) : await mailApi.createCalendar(input);
      setCalendars((current) => id ? current.map((calendar) => calendar.id === id ? result.calendar : calendar) : [...current, result.calendar]);
      setVisibleCalendarIds((current) => current.includes(result.calendar.id) ? current : [...current, result.calendar.id]);
      setCalendarEditor(null);
      setStatus(id ? "Calendar updated." : "Calendar added.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The calendar could not be saved.");
      throw error;
    }
  }

  async function deleteCalendar(id: string) {
    try {
      await mailApi.deleteCalendar(id);
      setCalendars((current) => current.filter((calendar) => calendar.id !== id));
      setVisibleCalendarIds((current) => current.filter((calendarId) => calendarId !== id));
      setEvents((current) => current.filter((event) => event.calendarId !== id));
      setCalendarEditor(null);
      setStatus("Calendar and its events deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The calendar could not be deleted.");
      throw error;
    }
  }

  const title = formatRangeTitle(anchor, view);
  const calendarColors = useMemo(() => Object.fromEntries(calendars.map((calendar) => [calendar.id, calendar.color])), [calendars]);

  return (
    <div className="calendar-app">
      <header className="calendar-topbar">
        <button className="calendar-icon-button calendar-mobile-menu" onClick={() => setMobileSidebar(true)} aria-label="Open calendar navigation"><Menu /></button>
        <button className="calendar-launcher" onClick={props.onExit} title="Back to Mail" aria-label="Back to Mail"><Grid3X3 /></button>
        <span className="calendar-product-icon"><CalendarDays /></span>
        <strong className="calendar-product-name">Calendar</strong>
        <label className="calendar-search"><Search /><span className="sr-only">Search calendar</span><input ref={searchRef} type="search" placeholder="Search calendar" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></label>
        <button className="calendar-account" onClick={props.onLogout} title="Sign out"><span>{props.userEmail}</span><b>{props.userEmail.slice(0, 1).toUpperCase()}</b><LogOut /></button>
      </header>

      <section className="calendar-ribbon" aria-label="Calendar commands">
        <div className="calendar-ribbon-tabs"><button className="active">Home</button><button onClick={() => setAgendaOpen((current) => !current)}>View</button><button onClick={() => setStatus("Tip: N creates an event, T returns to today, and 1–4 switch views.")}>Help</button></div>
        <div className="calendar-ribbon-actions">
          <button className="calendar-new-event" onClick={() => openNewEvent(nextWholeHour(selectedDate))}><Plus /> <span>New event</span><ChevronDown /></button>
          <div className="calendar-view-buttons" aria-label="Calendar view">
            {(["day", "workweek", "week", "month"] as CalendarView[]).map((option, index) => <button key={option} className={view === option ? "active" : ""} onClick={() => setView(option)}>{viewLabel(option)}<kbd>{index + 1}</kbd></button>)}
          </div>
          <button onClick={() => setAgendaOpen((current) => !current)} className={agendaOpen ? "active" : ""}><PanelRight /> <span>Agenda</span></button>
          <button onClick={() => exportIcs(events.filter((event) => visibleCalendarIds.includes(event.calendarId)))}><Download /> <span>Export view</span></button>
          <button onClick={() => window.print()}><Printer /> <span>Print</span></button>
        </div>
      </section>

      <div className="calendar-shell">
        {mobileSidebar ? <button className="calendar-sidebar-scrim" onClick={() => setMobileSidebar(false)} aria-label="Close calendar navigation" /> : null}
        <CalendarSidebar
          open={mobileSidebar}
          anchor={anchor}
          selectedDate={selectedDate}
          calendars={calendars}
          visibleIds={visibleCalendarIds}
          onClose={() => setMobileSidebar(false)}
          onExit={props.onExit}
          onSelectDate={(date) => { setSelectedDate(date); setAnchor(date); setMobileSidebar(false); }}
          onToggleCalendar={(id) => setVisibleCalendarIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
          onAddCalendar={() => setCalendarEditor("new")}
          onEditCalendar={(calendar) => setCalendarEditor(calendar)}
        />

        <main className="calendar-main" id="main-content">
          <div className="calendar-navigation-bar">
            <button className="calendar-today" onClick={() => { const today = new Date(); setAnchor(today); setSelectedDate(today); }}>Today</button>
            <button className="calendar-nav-arrow" onClick={() => setAnchor((current) => shiftAnchor(current, view, -1))} aria-label="Previous date range"><ChevronLeft /></button>
            <button className="calendar-nav-arrow" onClick={() => setAnchor((current) => shiftAnchor(current, view, 1))} aria-label="Next date range"><ChevronRight /></button>
            <h1>{title}</h1>
            {loading ? <span className="calendar-loading"><span /> Updating</span> : null}
            {query ? <button className="calendar-clear-search" onClick={() => setQuery("")}><X /> Clear search</button> : null}
          </div>

          <div className={`calendar-content ${agendaOpen ? "with-agenda" : ""}`}>
            {view === "month" ? (
              <MonthView anchor={anchor} occurrences={occurrences} calendarColors={calendarColors} onSelectDate={(date) => { setSelectedDate(date); setAnchor(date); }} onNewEvent={openNewEvent} onOpenEvent={openEvent} />
            ) : (
              <TimeGrid anchor={anchor} view={view} occurrences={occurrences} calendarColors={calendarColors} onSelectDate={setSelectedDate} onNewEvent={openNewEvent} onOpenEvent={openEvent} />
            )}
            {agendaOpen ? <AgendaPanel occurrences={occurrences} calendars={calendars} onClose={() => setAgendaOpen(false)} onOpenEvent={openEvent} /> : null}
          </div>
        </main>
      </div>

      <div className="calendar-live-status" aria-live="polite">{status}</div>
      {editor ? <EventEditor event={editor.event} start={editor.start} allDay={editor.allDay} calendars={calendars} onClose={() => setEditor(null)} onSave={saveEvent} onDelete={deleteEvent} /> : null}
      {calendarEditor ? <CalendarEditor calendar={calendarEditor === "new" ? null : calendarEditor} onClose={() => setCalendarEditor(null)} onSave={saveCalendar} onDelete={deleteCalendar} /> : null}
    </div>
  );
}

function CalendarSidebar(props: {
  open: boolean;
  anchor: Date;
  selectedDate: Date;
  calendars: CalendarRecord[];
  visibleIds: string[];
  onClose: () => void;
  onExit: () => void;
  onSelectDate: (date: Date) => void;
  onToggleCalendar: (id: string) => void;
  onAddCalendar: () => void;
  onEditCalendar: (calendar: CalendarRecord) => void;
}) {
  const [miniAnchor, setMiniAnchor] = useState(() => new Date(props.anchor));
  useEffect(() => setMiniAnchor(new Date(props.anchor)), [props.anchor.valueOf()]);
  const days = useMemo(() => visibleDays(miniAnchor, "month"), [miniAnchor]);
  return <aside className={`calendar-sidebar ${props.open ? "open" : ""}`} aria-label="Calendar navigation">
    <div className="mini-calendar">
      <header><strong>{miniAnchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong><span><button onClick={() => setMiniAnchor((current) => shiftAnchor(current, "month", -1))} aria-label="Previous month"><ChevronLeft /></button><button onClick={() => setMiniAnchor((current) => shiftAnchor(current, "month", 1))} aria-label="Next month"><ChevronRight /></button></span></header>
      <div className="mini-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day.slice(0, 1)}</span>)}</div>
      <div className="mini-days">{days.map((day) => <button key={dateKey(day)} className={`${day.getMonth() !== miniAnchor.getMonth() ? "outside" : ""} ${isSameDay(day, new Date()) ? "today" : ""} ${isSameDay(day, props.selectedDate) ? "selected" : ""}`} onClick={() => props.onSelectDate(day)}>{day.getDate()}</button>)}</div>
    </div>
    <button className="calendar-add-calendar" onClick={props.onAddCalendar}><Plus /> Add calendar</button>
    <section className="calendar-list">
      <h2>My calendars</h2>
      {props.calendars.map((calendar) => <div className="calendar-list-row" key={calendar.id}>
        <button className={`calendar-check ${props.visibleIds.includes(calendar.id) ? "checked" : ""}`} style={{ "--calendar-color": calendar.color } as CSSProperties} onClick={() => props.onToggleCalendar(calendar.id)} aria-label={`${props.visibleIds.includes(calendar.id) ? "Hide" : "Show"} ${calendar.name}`}>{props.visibleIds.includes(calendar.id) ? <Check /> : null}</button>
        <span>{calendar.name}</span>
        <button className="calendar-more" onClick={() => props.onEditCalendar(calendar)} aria-label={`Edit ${calendar.name}`}><MoreHorizontal /></button>
      </div>)}
    </section>
    <button className="calendar-mail-link" onClick={props.onExit}><Mail /> Back to Mail</button>
  </aside>;
}

function MonthView(props: {
  anchor: Date;
  occurrences: CalendarOccurrence[];
  calendarColors: Record<string, string>;
  onSelectDate: (date: Date) => void;
  onNewEvent: (date: Date, allDay?: boolean) => void;
  onOpenEvent: (event: CalendarOccurrence) => void;
}) {
  const days = visibleDays(props.anchor, "month");
  return <section className="calendar-month-view" aria-label="Month view">
    <div className="calendar-month-weekdays">{WEEKDAYS.map((day) => <div key={day}>{day}</div>)}</div>
    <div className="calendar-month-grid">{days.map((day) => {
      const dayEvents = occurrencesForDay(props.occurrences, day);
      return <div key={dateKey(day)} className={`calendar-month-day ${day.getMonth() !== props.anchor.getMonth() ? "outside" : ""} ${isSameDay(day, new Date()) ? "today" : ""}`} onClick={() => props.onSelectDate(day)} onDoubleClick={() => props.onNewEvent(day, true)}>
        <button className="calendar-day-number" onClick={(event) => { event.stopPropagation(); props.onSelectDate(day); }} aria-label={day.toLocaleDateString()}>{day.getDate()}</button>
        <div className="calendar-month-events">{dayEvents.slice(0, 3).map((event) => <EventPill key={event.occurrenceId} event={event} color={props.calendarColors[event.calendarId]} compact onOpen={() => props.onOpenEvent(event)} />)}{dayEvents.length > 3 ? <button className="calendar-more-events" onClick={(event) => { event.stopPropagation(); props.onSelectDate(day); }}>+{dayEvents.length - 3} more</button> : null}</div>
      </div>;
    })}</div>
  </section>;
}

function TimeGrid(props: {
  anchor: Date;
  view: CalendarView;
  occurrences: CalendarOccurrence[];
  calendarColors: Record<string, string>;
  onSelectDate: (date: Date) => void;
  onNewEvent: (date: Date, allDay?: boolean) => void;
  onOpenEvent: (event: CalendarOccurrence) => void;
}) {
  const days = visibleDays(props.anchor, props.view);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 7 * 48; }, [props.view]);
  return <section className="calendar-time-view" style={{ "--calendar-days": days.length } as CSSProperties} aria-label={`${viewLabel(props.view)} view`}>
    <div className="calendar-time-header">
      <div className="calendar-time-corner" />
      {days.map((day) => <button key={dateKey(day)} className={isSameDay(day, new Date()) ? "today" : ""} onClick={() => props.onSelectDate(day)}><span>{day.toLocaleDateString(undefined, { weekday: "short" })}</span><strong>{day.getDate()}</strong></button>)}
    </div>
    <div className="calendar-all-day-row">
      <span>all-day</span>
      {days.map((day) => {
        const events = occurrencesForDay(props.occurrences, day).filter((event) => event.allDay);
        return <div key={dateKey(day)} onDoubleClick={() => props.onNewEvent(day, true)}>{events.slice(0, 2).map((event) => <EventPill key={event.occurrenceId} event={event} color={props.calendarColors[event.calendarId]} compact onOpen={() => props.onOpenEvent(event)} />)}</div>;
      })}
    </div>
    <div className="calendar-time-scroll" ref={scrollRef}>
      <div className="calendar-hour-labels">{HOURS.map((hour) => <time key={hour}>{formatHour(hour)}</time>)}</div>
      <div className="calendar-day-columns">{days.map((day) => {
        const dayStart = startOfDay(day);
        const dayEnd = addDays(dayStart, 1);
        const timed = occurrencesForDay(props.occurrences, day).filter((event) => !event.allDay);
        const positioned = layoutTimedOccurrences(timed);
        return <div className="calendar-day-column" key={dateKey(day)}>
          {HOURS.map((hour) => <button key={hour} className="calendar-hour-slot" aria-label={`Create event ${day.toLocaleDateString()} at ${formatHour(hour)}`} onDoubleClick={() => { const date = new Date(dayStart); date.setHours(hour); props.onNewEvent(date); }} />)}
          {positioned.map(({ occurrence, column, columns }) => {
            const start = new Date(Math.max(new Date(occurrence.startAt).valueOf(), dayStart.valueOf()));
            const end = new Date(Math.min(new Date(occurrence.endAt).valueOf(), dayEnd.valueOf()));
            const minutes = start.getHours() * 60 + start.getMinutes();
            const duration = Math.max(22, (end.valueOf() - start.valueOf()) / 60_000 * .8);
            const style = {
              "--event-color": props.calendarColors[occurrence.calendarId] || CALENDAR_COLORS[0],
              top: `${minutes * .8}px`,
              height: `${duration}px`,
              left: `calc(${column * 100 / columns}% + 2px)`,
              width: `calc(${100 / columns}% - 4px)`,
            } as CSSProperties;
            return <button className={`calendar-time-event ${occurrence.availability}`} style={style} key={occurrence.occurrenceId} onClick={() => props.onOpenEvent(occurrence)}><strong>{occurrence.title}</strong><span>{formatEventTime(occurrence)}{occurrence.location ? ` · ${occurrence.location}` : ""}</span>{occurrence.recurrenceFrequency !== "none" ? <Repeat2 /> : null}</button>;
          })}
          {isSameDay(day, new Date()) ? <CurrentTimeLine day={day} /> : null}
        </div>;
      })}</div>
    </div>
  </section>;
}

function CurrentTimeLine({ day }: { day: Date }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  if (!isSameDay(day, now)) return null;
  const top = (now.getHours() * 60 + now.getMinutes()) * .8;
  return <span className="calendar-current-time" style={{ top }}><i /></span>;
}

function EventPill({ event, color, compact, onOpen }: { event: CalendarOccurrence; color?: string; compact?: boolean; onOpen: () => void }) {
  return <button className={`calendar-event-pill ${compact ? "compact" : ""} ${event.availability}`} style={{ "--event-color": color || CALENDAR_COLORS[0] } as CSSProperties} onClick={(click) => { click.stopPropagation(); onOpen(); }} title={`${event.title} — ${formatEventTime(event)}`}><span>{event.allDay ? "" : formatEventTime(event)}</span><strong>{event.title}</strong>{event.recurrenceFrequency !== "none" ? <Repeat2 /> : null}</button>;
}

function AgendaPanel(props: { occurrences: CalendarOccurrence[]; calendars: CalendarRecord[]; onClose: () => void; onOpenEvent: (event: CalendarOccurrence) => void }) {
  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarOccurrence[]>();
    props.occurrences.forEach((event) => {
      const key = dateKey(new Date(event.startAt));
      groups.set(key, [...(groups.get(key) || []), event]);
    });
    return Array.from(groups.entries()).slice(0, 14);
  }, [props.occurrences]);
  const colors = Object.fromEntries(props.calendars.map((calendar) => [calendar.id, calendar.color]));
  return <aside className="calendar-agenda" aria-label="Agenda"><header><span><List /><strong>Agenda</strong></span><button onClick={props.onClose} aria-label="Close agenda"><X /></button></header>{grouped.length ? grouped.map(([key, events]) => <section key={key}><h3>{new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</h3>{events.map((event) => <button key={event.occurrenceId} onClick={() => props.onOpenEvent(event)} style={{ "--event-color": colors[event.calendarId] } as CSSProperties}><i /><span><strong>{event.title}</strong><small>{event.allDay ? "All day" : formatEventTime(event)}{event.location ? ` · ${event.location}` : ""}</small></span></button>)}</section>) : <div className="calendar-empty-agenda"><CalendarDays /><strong>No events in this view</strong><span>Double-click a day or time to add one.</span></div>}</aside>;
}

function EventEditor(props: {
  event: CalendarEventRecord | null;
  start: Date;
  allDay: boolean;
  calendars: CalendarRecord[];
  onClose: () => void;
  onSave: (id: string | null, input: CalendarEventInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<EventDraft>(() => eventDraft(props.event, props.start, props.allDay, props.calendars[0]?.id || ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === "Escape" && !saving) props.onClose(); }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [props.onClose, saving]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const start = combineLocalDateTime(draft.startDate, draft.allDay ? "00:00" : draft.startTime);
    const end = combineLocalDateTime(draft.endDate, draft.allDay ? "00:00" : draft.endTime);
    if (!draft.title.trim()) return setError("Add an event title.");
    if (!draft.calendarId) return setError("Choose a calendar.");
    if (end <= start) return setError("The event must end after it starts.");
    const recurrenceUntil = draft.recurrenceFrequency !== "none" && draft.recurrenceUntil
      ? combineLocalDateTime(draft.recurrenceUntil, "23:59").toISOString()
      : null;
    setSaving(true);
    try {
      await props.onSave(props.event?.id || null, {
        calendarId: draft.calendarId,
        title: draft.title.trim(),
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        allDay: draft.allDay,
        timezone: draft.timezone,
        location: draft.location.trim(),
        description: draft.description,
        availability: draft.availability,
        recurrenceFrequency: draft.recurrenceFrequency,
        recurrenceInterval: draft.recurrenceInterval,
        recurrenceUntil,
        reminderMinutes: draft.reminderMinutes === "" ? null : Number(draft.reminderMinutes),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The event could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <form className="calendar-event-editor" role="dialog" aria-modal="true" aria-labelledby="calendar-editor-title" onSubmit={submit}>
      <header><div><CalendarDays /><span><strong id="calendar-editor-title">{props.event ? props.event.recurrenceFrequency === "none" ? "Edit event" : "Edit recurring series" : "New event"}</strong><small>{draft.timezone}</small></span></div><button type="button" onClick={props.onClose} aria-label="Close event editor"><X /></button></header>
      <div className="calendar-editor-body">
        <input ref={titleRef} className="calendar-event-title" placeholder="Add a title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={255} />
        <label className="calendar-all-day-toggle"><input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft(toggleAllDay(draft, event.target.checked))} /><span>All day</span></label>
        <div className="calendar-date-row"><Clock3 /><label><span>Starts</span><input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label>{!draft.allDay ? <input aria-label="Start time" type="time" step="900" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /> : null}<label><span>Ends</span><input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></label>{!draft.allDay ? <input aria-label="End time" type="time" step="900" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /> : null}</div>
        <label className="calendar-editor-field"><MapPin /><span>Location</span><input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder="Add a room or place" maxLength={500} /></label>
        <div className="calendar-editor-field"><Repeat2 /><label><span>Repeat</span><select value={draft.recurrenceFrequency} onChange={(event) => setDraft({ ...draft, recurrenceFrequency: event.target.value as CalendarRecurrenceFrequency })}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>{draft.recurrenceFrequency !== "none" ? <><label className="calendar-interval"><span>Every</span><input type="number" min="1" max="365" value={draft.recurrenceInterval} onChange={(event) => setDraft({ ...draft, recurrenceInterval: Number(event.target.value) || 1 })} /></label><label><span>Until</span><input type="date" min={draft.startDate} value={draft.recurrenceUntil} onChange={(event) => setDraft({ ...draft, recurrenceUntil: event.target.value })} /></label></> : null}</div>
        <div className="calendar-editor-field"><Bell /><label><span>Reminder</span><select value={draft.reminderMinutes} onChange={(event) => setDraft({ ...draft, reminderMinutes: event.target.value })}><option value="">None</option><option value="0">At start time</option><option value="5">5 minutes before</option><option value="15">15 minutes before</option><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></label><label><span>Show as</span><select value={draft.availability} onChange={(event) => setDraft({ ...draft, availability: event.target.value as CalendarAvailability })}><option value="busy">Busy</option><option value="free">Free</option><option value="tentative">Tentative</option><option value="out_of_office">Out of office</option></select></label></div>
        <label className="calendar-editor-field"><span className="calendar-color-swatch" style={{ background: props.calendars.find((calendar) => calendar.id === draft.calendarId)?.color }} /><span>Calendar</span><select value={draft.calendarId} onChange={(event) => setDraft({ ...draft, calendarId: event.target.value })}>{props.calendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select></label>
        <label className="calendar-description"><span>Notes</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={5} placeholder="Add notes or an agenda…" maxLength={50_000} /></label>
        {error ? <p className="calendar-editor-error">{error}</p> : null}
      </div>
      <footer><div>{props.event ? confirmDelete ? <><span>Delete this {props.event.recurrenceFrequency === "none" ? "event" : "series"}?</span><button type="button" className="calendar-delete-confirm" onClick={() => { setSaving(true); void props.onDelete(props.event!.id).catch(() => setSaving(false)); }}>Yes, delete</button><button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button></> : <button type="button" className="calendar-delete" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</button> : null}</div><span><button type="button" onClick={props.onClose}>Discard</button><button className="calendar-save" disabled={saving}><Check /> {saving ? "Saving…" : "Save"}</button></span></footer>
    </form>
  </div>;
}

function CalendarEditor(props: { calendar: CalendarRecord | null; onClose: () => void; onSave: (id: string | null, data: { name: string; color: string }) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [name, setName] = useState(props.calendar?.name || "");
  const [color, setColor] = useState(props.calendar?.color || CALENDAR_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === "Escape" && !saving) props.onClose(); }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [props.onClose, saving]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Add a calendar name.");
    setSaving(true);
    try { await props.onSave(props.calendar?.id || null, { name: name.trim(), color }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The calendar could not be saved."); setSaving(false); }
  }
  return <div className="calendar-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><form className="calendar-calendar-editor" role="dialog" aria-modal="true" aria-labelledby="calendar-settings-title" onSubmit={submit}><header><strong id="calendar-settings-title">{props.calendar ? "Calendar settings" : "Add calendar"}</strong><button type="button" onClick={props.onClose} aria-label="Close calendar settings"><X /></button></header><label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Calendar name" /></label><fieldset><legend>Colour</legend><div>{CALENDAR_COLORS.map((option) => <button type="button" key={option} className={color === option ? "selected" : ""} style={{ background: option }} onClick={() => setColor(option)} aria-label={`Use ${option}`}>{color === option ? <Check /> : null}</button>)}</div></fieldset>{error ? <p className="calendar-editor-error">{error}</p> : null}<footer><div>{props.calendar && !props.calendar.isDefault ? confirmDelete ? <><button type="button" className="calendar-delete-confirm" onClick={() => { setSaving(true); void props.onDelete(props.calendar!.id).catch(() => setSaving(false)); }}>Delete calendar and events</button><button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button></> : <button type="button" className="calendar-delete" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</button> : null}</div><span><button type="button" onClick={props.onClose}>Cancel</button><button className="calendar-save" disabled={saving}>{saving ? "Saving…" : "Save"}</button></span></footer></form></div>;
}

function eventDraft(event: CalendarEventRecord | null, suggestedStart: Date, allDay: boolean, defaultCalendarId: string): EventDraft {
  const start = event ? new Date(event.startAt) : new Date(suggestedStart);
  const end = event ? new Date(event.endAt) : allDay ? addDays(startOfDay(start), 1) : new Date(start.valueOf() + 60 * 60_000);
  return {
    title: event?.title || "",
    calendarId: event?.calendarId || defaultCalendarId,
    startDate: dateKey(start),
    startTime: timeInput(start),
    endDate: dateKey(end),
    endTime: timeInput(end),
    allDay: event?.allDay ?? allDay,
    timezone: event?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    location: event?.location || "",
    description: event?.description || "",
    availability: event?.availability || "busy",
    recurrenceFrequency: event?.recurrenceFrequency || "none",
    recurrenceInterval: event?.recurrenceInterval || 1,
    recurrenceUntil: event?.recurrenceUntil ? dateKey(new Date(event.recurrenceUntil)) : "",
    reminderMinutes: event?.reminderMinutes === null ? "" : String(event?.reminderMinutes ?? 15),
  };
}

function toggleAllDay(draft: EventDraft, allDay: boolean): EventDraft {
  if (allDay) {
    const endDate = draft.endDate <= draft.startDate ? dateKey(addDays(new Date(`${draft.startDate}T12:00:00`), 1)) : draft.endDate;
    return { ...draft, allDay, endDate };
  }
  return { ...draft, allDay, startTime: draft.startTime || "09:00", endTime: draft.endTime || "10:00" };
}

function combineLocalDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00`);
}

function timeInput(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function nextWholeHour(value: Date): Date {
  const next = new Date(value);
  if (isSameDay(next, new Date())) next.setTime(Date.now());
  next.setMinutes(0, 0, 0);
  next.setHours(Math.min(23, next.getHours() + 1));
  if (next.getHours() < 7) next.setHours(9);
  return next;
}

function viewLabel(view: CalendarView): string {
  return view === "workweek" ? "Work week" : `${view.slice(0, 1).toUpperCase()}${view.slice(1)}`;
}

function formatRangeTitle(anchor: Date, view: CalendarView): string {
  if (view === "month") return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (view === "day") return anchor.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const days = visibleDays(anchor, view);
  const start = days[0];
  const end = days[days.length - 1];
  if (start.getMonth() === end.getMonth()) return `${start.getDate()}–${end.getDate()} ${end.toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;
  return `${start.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${end.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

function formatHour(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function formatEventTime(event: CalendarOccurrence): string {
  if (event.allDay) return "All day";
  const start = new Date(event.startAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const end = new Date(event.endAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${start}–${end}`;
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsDate(value: string, allDay = false): string {
  const date = new Date(value);
  if (allDay) return dateKey(date).replace(/-/g, "");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function exportIcs(events: CalendarEventRecord[]) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//cfmail//Calendar//EN", "CALSCALE:GREGORIAN"];
  events.forEach((event) => {
    lines.push("BEGIN:VEVENT", `UID:${event.id}`, `DTSTAMP:${icsDate(new Date().toISOString())}`);
    lines.push(event.allDay ? `DTSTART;VALUE=DATE:${icsDate(event.startAt, true)}` : `DTSTART:${icsDate(event.startAt)}`);
    lines.push(event.allDay ? `DTEND;VALUE=DATE:${icsDate(event.endAt, true)}` : `DTEND:${icsDate(event.endAt)}`);
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    if (event.recurrenceFrequency !== "none") {
      let rule = `FREQ=${event.recurrenceFrequency.toUpperCase()};INTERVAL=${event.recurrenceInterval}`;
      if (event.recurrenceUntil) rule += `;UNTIL=${icsDate(event.recurrenceUntil)}`;
      lines.push(`RRULE:${rule}`);
    }
    lines.push(`TRANSP:${event.availability === "free" ? "TRANSPARENT" : "OPAQUE"}`, "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  const url = URL.createObjectURL(new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cfmail-calendar-${dateKey(new Date())}.ics`;
  link.click();
  URL.revokeObjectURL(url);
}
