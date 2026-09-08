import type { CalendarEventRecord, CalendarRecurrenceFrequency } from "../shared/types";

export type CalendarView = "day" | "workweek" | "week" | "month";

export interface CalendarOccurrence extends CalendarEventRecord {
  occurrenceId: string;
  sourceStartAt: string;
  sourceEndAt: string;
}

export interface PositionedCalendarOccurrence {
  occurrence: CalendarOccurrence;
  column: number;
  columns: number;
}

const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 1_000;

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeek(value: Date): Date {
  const day = startOfDay(value);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}

export function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function monthGridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function visibleDays(anchor: Date, view: CalendarView): Date[] {
  if (view === "month") return monthGridDays(anchor);
  if (view === "day") return [startOfDay(anchor)];
  const weekStart = startOfWeek(anchor);
  return Array.from({ length: view === "workweek" ? 5 : 7 }, (_, index) => addDays(weekStart, index));
}

export function visibleRange(anchor: Date, view: CalendarView): { start: Date; end: Date } {
  const days = visibleDays(anchor, view);
  return { start: days[0], end: addDays(days[days.length - 1], 1) };
}

export function shiftAnchor(anchor: Date, view: CalendarView, direction: -1 | 1): Date {
  const next = new Date(anchor);
  if (view === "month") next.setMonth(next.getMonth() + direction, 1);
  else next.setDate(next.getDate() + direction * (view === "day" ? 1 : 7));
  return next;
}

export function overlapsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return start < rangeEnd && end > rangeStart;
}

function monthOccurrence(base: Date, monthOffset: number): Date {
  const targetMonth = base.getMonth() + monthOffset;
  const year = base.getFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(
    year,
    month,
    Math.min(base.getDate(), lastDay),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
}

function occurrenceStart(base: Date, frequency: CalendarRecurrenceFrequency, interval: number, index: number): Date {
  if (frequency === "daily") return addDays(base, index * interval);
  if (frequency === "weekly") return addDays(base, index * interval * 7);
  if (frequency === "monthly") return monthOccurrence(base, index * interval);
  if (frequency === "yearly") return monthOccurrence(base, index * interval * 12);
  return new Date(base);
}

function approximateStartIndex(base: Date, rangeStart: Date, frequency: CalendarRecurrenceFrequency, interval: number): number {
  if (rangeStart <= base) return 0;
  if (frequency === "daily") return Math.max(0, Math.floor((rangeStart.valueOf() - base.valueOf()) / DAY_MS / interval) - 1);
  if (frequency === "weekly") return Math.max(0, Math.floor((rangeStart.valueOf() - base.valueOf()) / DAY_MS / (interval * 7)) - 1);
  const months = (rangeStart.getFullYear() - base.getFullYear()) * 12 + rangeStart.getMonth() - base.getMonth();
  if (frequency === "monthly") return Math.max(0, Math.floor(months / interval) - 1);
  if (frequency === "yearly") return Math.max(0, Math.floor(months / (interval * 12)) - 1);
  return 0;
}

export function expandCalendarEvents(
  events: CalendarEventRecord[],
  rangeStart: Date,
  rangeEnd: Date,
): CalendarOccurrence[] {
  const occurrences: CalendarOccurrence[] = [];
  for (const event of events) {
    const baseStart = new Date(event.startAt);
    const baseEnd = new Date(event.endAt);
    if (Number.isNaN(baseStart.valueOf()) || Number.isNaN(baseEnd.valueOf()) || baseEnd <= baseStart) continue;
    const duration = baseEnd.valueOf() - baseStart.valueOf();
    if (event.recurrenceFrequency === "none") {
      if (overlapsRange(baseStart, baseEnd, rangeStart, rangeEnd)) {
        occurrences.push({ ...event, occurrenceId: event.id, sourceStartAt: event.startAt, sourceEndAt: event.endAt });
      }
      continue;
    }

    const until = event.recurrenceUntil ? new Date(event.recurrenceUntil) : null;
    const interval = Math.max(1, event.recurrenceInterval || 1);
    let index = approximateStartIndex(baseStart, rangeStart, event.recurrenceFrequency, interval);
    let added = 0;
    while (added < MAX_OCCURRENCES) {
      const start = occurrenceStart(baseStart, event.recurrenceFrequency, interval, index);
      if (until && start > until) break;
      if (start >= rangeEnd) break;
      const end = new Date(start.valueOf() + duration);
      if (overlapsRange(start, end, rangeStart, rangeEnd)) {
        occurrences.push({
          ...event,
          startAt: start.toISOString(),
          endAt: end.toISOString(),
          occurrenceId: `${event.id}:${start.toISOString()}`,
          sourceStartAt: event.startAt,
          sourceEndAt: event.endAt,
        });
        added += 1;
      }
      index += 1;
    }
  }
  return occurrences.sort((left, right) => left.startAt.localeCompare(right.startAt) || left.title.localeCompare(right.title));
}

export function occurrencesForDay(occurrences: CalendarOccurrence[], day: Date): CalendarOccurrence[] {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  return occurrences.filter((occurrence) => overlapsRange(new Date(occurrence.startAt), new Date(occurrence.endAt), start, end));
}

export function layoutTimedOccurrences(occurrences: CalendarOccurrence[]): PositionedCalendarOccurrence[] {
  const sorted = [...occurrences].sort((left, right) => left.startAt.localeCompare(right.startAt) || right.endAt.localeCompare(left.endAt));
  const columnEnds: number[] = [];
  const positioned = sorted.map((occurrence) => {
    const start = Date.parse(occurrence.startAt);
    const end = Date.parse(occurrence.endAt);
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
    if (column < 0) column = columnEnds.length;
    columnEnds[column] = end;
    return { occurrence, column, columns: 1 };
  });
  const columns = Math.max(1, columnEnds.length);
  return positioned.map((item) => ({ ...item, columns }));
}

export function isSameDay(left: Date, right: Date): boolean {
  return dateKey(left) === dateKey(right);
}
