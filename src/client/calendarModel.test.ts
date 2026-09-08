import { describe, expect, it } from "vitest";
import type { CalendarEventRecord } from "../shared/types";
import {
  dateKey,
  expandCalendarEvents,
  layoutTimedOccurrences,
  monthGridDays,
  startOfWeek,
  visibleDays,
} from "./calendarModel";

function event(overrides: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: "event-1",
    calendarId: "calendar-1",
    title: "Planning",
    startAt: "2026-08-28T09:00:00.000Z",
    endAt: "2026-08-28T10:00:00.000Z",
    allDay: false,
    timezone: "UTC",
    location: "",
    description: "",
    availability: "busy",
    recurrenceFrequency: "none",
    recurrenceInterval: 1,
    recurrenceUntil: null,
    reminderMinutes: 15,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("calendar model", () => {
  it("uses Monday as the start of the week and produces a stable six-week month grid", () => {
    expect(dateKey(startOfWeek(new Date(2026, 7, 28)))).toBe("2026-08-24");
    const days = monthGridDays(new Date(2026, 7, 15));
    expect(days).toHaveLength(42);
    expect(dateKey(days[0])).toBe("2026-07-27");
    expect(dateKey(days[41])).toBe("2026-09-06");
    expect(visibleDays(new Date(2026, 7, 28), "workweek").map(dateKey)).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
    ]);
  });

  it("expands recurring events only inside the visible range", () => {
    const occurrences = expandCalendarEvents([
      event({ recurrenceFrequency: "weekly", recurrenceUntil: "2026-09-30T09:00:00.000Z" }),
    ], new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-20T00:00:00.000Z"));
    expect(occurrences.map((item) => item.startAt)).toEqual([
      "2026-09-04T09:00:00.000Z",
      "2026-09-11T09:00:00.000Z",
      "2026-09-18T09:00:00.000Z",
    ]);
  });

  it("clamps monthly recurrences to the last valid day", () => {
    const occurrences = expandCalendarEvents([
      event({
        startAt: "2026-01-31T09:00:00.000Z",
        endAt: "2026-01-31T10:00:00.000Z",
        recurrenceFrequency: "monthly",
        recurrenceUntil: "2026-04-30T09:00:00.000Z",
      }),
    ], new Date("2026-02-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));
    expect(occurrences.map((item) => item.startAt.slice(0, 10))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("assigns separate columns to overlapping events", () => {
    const occurrences = expandCalendarEvents([
      event(),
      event({ id: "event-2", startAt: "2026-08-28T09:30:00.000Z", endAt: "2026-08-28T10:30:00.000Z" }),
      event({ id: "event-3", startAt: "2026-08-28T11:00:00.000Z", endAt: "2026-08-28T12:00:00.000Z" }),
    ], new Date("2026-08-28T00:00:00.000Z"), new Date("2026-08-29T00:00:00.000Z"));
    const positioned = layoutTimedOccurrences(occurrences);
    expect(positioned.map((item) => item.column)).toEqual([0, 1, 0]);
    expect(positioned.every((item) => item.columns === 2)).toBe(true);
  });
});
