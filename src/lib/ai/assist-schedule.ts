/**
 * A prompt the AI page runs again on a timer.
 *
 * The prompt and the saved-query sources are copied when the schedule is saved.
 * Each run reads those sources again, so a query that changed, or rows that
 * changed, are what the next answer sees. A schedule repeats hourly, or daily
 * at a clock time chosen on the calendar.
 */

import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { ASSIST_SAVED_LIST_CAP } from "@/lib/ai/assist-saved";

export const ASSIST_SCHEDULE_KEY = "libredb_ai_assist_schedules";
export const ASSIST_SCHEDULE_CAP = 8;
export const ASSIST_SCHEDULE_HOURLY_SECONDS = 60 * 60;
export const ASSIST_SCHEDULE_DAILY_SECONDS = 24 * 60 * 60;
/** 9:00 in the morning. The calendar opens here. */
export const ASSIST_SCHEDULE_DEFAULT_MINUTE = 9 * 60;
const MINUTES_PER_DAY = 24 * 60;

export type AssistScheduleEvery = "hourly" | "daily";

export interface AssistSchedule {
  readonly id: string;
  readonly prompt: string;
  readonly sourceIds: readonly string[];
  readonly seconds: number;
  /** Local minutes after midnight. A daily schedule with a clock time keeps one. */
  readonly minuteOfDay?: number;
  /** Local calendar day `YYYY-MM-DD` the daily clock time may start. */
  readonly startsOn?: string;
}

/** One day drawn on the month grid. */
export interface AssistCalendarCell {
  readonly key: string;
  readonly day: number;
  readonly inMonth: boolean;
}

/** Start times on the half hour, midnight through 11:30 PM. */
export const ASSIST_START_TIMES: readonly number[] = Array.from({ length: 48 }, (_, index) => index * 30);

interface ScheduleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AssistScheduleDraft =
  | { readonly ok: true; readonly schedule: AssistSchedule }
  | { readonly ok: false; readonly error: string };

type AssistIntervalRead =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly error: string };

function secondsFor(every: AssistScheduleEvery): number {
  return every === "daily" ? ASSIST_SCHEDULE_DAILY_SECONDS : ASSIST_SCHEDULE_HOURLY_SECONDS;
}

/** Hourly, unless the stored gap is at least a day. */
export function assistScheduleEvery(seconds: number): AssistScheduleEvery {
  return seconds >= ASSIST_SCHEDULE_DAILY_SECONDS ? "daily" : "hourly";
}

function clipPrompt(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > ASSIST_TEXT_CAP ? trimmed.slice(0, ASSIST_TEXT_CAP) : trimmed;
}

function sourceIdsOf(ids: readonly string[]): string[] {
  const kept: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === "" || kept.includes(trimmed)) continue;
    kept.push(trimmed);
    if (kept.length === ASSIST_SAVED_LIST_CAP) break;
  }
  return kept;
}

/** Hourly or daily. Anything else is not a schedule. */
export function readAssistInterval(text: string): AssistIntervalRead {
  const every = text.trim().toLowerCase();
  if (every === "hourly" || every === "daily") return { ok: true, seconds: secondsFor(every) };
  return { ok: false, error: "Choose hourly or daily." };
}

/** `YYYY-MM-DD` for a local calendar day, or null when it is not one. */
export function readAssistDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** The local calendar day of `date`. */
export function assistDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "9:00 AM". Minutes outside a day are not a time. */
export function assistMinuteLabel(minute: number): string {
  const rounded = Math.floor(minute);
  const hour = Math.floor(rounded / 60);
  const mins = rounded % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

/** "Friday, November 13, 2026" for a calendar key. */
export function assistDayLabel(key: string): string {
  const day = readAssistDate(key);
  if (day === null) return key;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(year, month - 1, date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "November 2026". */
export function assistMonthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** The month `by` steps away. January minus one is the previous December. */
export function shiftAssistMonth(year: number, monthIndex: number, by: number): { year: number; month: number } {
  const date = new Date(year, monthIndex + by, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

/**
 * Six weeks for one month, Sunday through Saturday.
 * Days from the neighboring months fill the first and last weeks.
 */
export function assistCalendarCells(year: number, monthIndex: number): AssistCalendarCell[] {
  const first = new Date(year, monthIndex, 1);
  const start = new Date(year, monthIndex, 1 - first.getDay());
  const cells: AssistCalendarCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    cells.push({
      key: assistDateKey(date),
      day: date.getDate(),
      inMonth: date.getMonth() === monthIndex,
    });
  }
  return cells;
}

function nextClock(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
  }
  return candidate;
}

/**
 * How long until this schedule should run.
 * Hourly, and a daily schedule saved before clock times, wait out their interval.
 * A daily clock time waits until that minute, on its start day or the next one after `now`.
 */
export function nextAssistRunDelayMs(
  schedule: Pick<AssistSchedule, "seconds" | "minuteOfDay" | "startsOn">,
  now: Date,
): number | null {
  const seconds = Math.floor(schedule.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minute = schedule.minuteOfDay;
  if (assistScheduleEvery(seconds) !== "daily" || minute === undefined) return seconds * 1000;
  const rounded = Math.floor(minute);
  if (!Number.isFinite(rounded) || rounded < 0 || rounded >= MINUTES_PER_DAY) return seconds * 1000;
  const hour = Math.floor(rounded / 60);
  const mins = rounded % 60;
  const startKey = schedule.startsOn === undefined ? null : readAssistDate(schedule.startsOn);
  if (startKey !== null) {
    const year = Number(startKey.slice(0, 4));
    const month = Number(startKey.slice(5, 7));
    const day = Number(startKey.slice(8, 10));
    const first = new Date(year, month - 1, day, hour, mins, 0, 0);
    if (first.getTime() > now.getTime()) return first.getTime() - now.getTime();
  }
  return nextClock(now, hour, mins).getTime() - now.getTime();
}

function clockOf(
  every: AssistScheduleEvery,
  minuteOfDay: number | undefined,
  startsOn: string | undefined,
): { minuteOfDay?: number; startsOn?: string } | { error: string } | undefined {
  if (every !== "daily" || minuteOfDay === undefined) return undefined;
  const minute = Math.floor(minuteOfDay);
  if (!Number.isFinite(minuteOfDay) || minute < 0 || minute >= MINUTES_PER_DAY) {
    return { error: "Choose a time." };
  }
  if (startsOn === undefined || startsOn.trim() === "") return { minuteOfDay: minute };
  const day = readAssistDate(startsOn);
  if (day === null) return { error: "Choose a day." };
  return { minuteOfDay: minute, startsOn: day };
}

/** A stored clock time. A broken time or day is left out instead of failing the schedule. */
function storedClock(
  every: AssistScheduleEvery,
  minuteOfDay: number | undefined,
  startsOn: string | undefined,
): { minuteOfDay?: number; startsOn?: string } | undefined {
  const clock = clockOf(every, minuteOfDay, startsOn);
  if (clock === undefined || "error" in clock) {
    if (every !== "daily" || minuteOfDay === undefined) return undefined;
    const minute = Math.floor(minuteOfDay);
    if (!Number.isFinite(minuteOfDay) || minute < 0 || minute >= MINUTES_PER_DAY) return undefined;
    return { minuteOfDay: minute };
  }
  return clock;
}

/**
 * One schedule from the prompt on screen, the sources added to it, and the interval.
 * A prompt or a source is enough. Neither is not.
 */
export function draftAssistSchedule(input: {
  readonly id: string;
  readonly prompt: string;
  readonly sourceIds: readonly string[];
  readonly every: string;
  readonly existing: number;
  readonly minuteOfDay?: number;
  readonly startsOn?: string;
}): AssistScheduleDraft {
  if (input.existing >= ASSIST_SCHEDULE_CAP) {
    return { ok: false, error: `${ASSIST_SCHEDULE_CAP} schedules are the most this page keeps.` };
  }
  const interval = readAssistInterval(input.every);
  if (!interval.ok) return interval;
  const clock = clockOf(assistScheduleEvery(interval.seconds), input.minuteOfDay, input.startsOn);
  if (clock !== undefined && "error" in clock) return { ok: false, error: clock.error };
  const prompt = clipPrompt(input.prompt);
  const sourceIds = sourceIdsOf(input.sourceIds);
  if (prompt === "" && sourceIds.length === 0) {
    return { ok: false, error: "Write a prompt or add a source." };
  }
  return {
    ok: true,
    schedule: {
      id: input.id.trim() || "schedule",
      prompt,
      sourceIds,
      seconds: interval.seconds,
      ...clock,
    },
  };
}

function scheduleOf(value: unknown): AssistSchedule | null {
  if (value === null || typeof value !== "object") return null;
  const id = "id" in value && typeof value.id === "string" ? value.id.trim() : "";
  if (id === "") return null;
  const prompt = "prompt" in value && typeof value.prompt === "string" ? clipPrompt(value.prompt) : "";
  const rawIds = "sourceIds" in value && Array.isArray(value.sourceIds) ? value.sourceIds : [];
  const sourceIds = sourceIdsOf(rawIds.filter((item): item is string => typeof item === "string"));
  const seconds = "seconds" in value && typeof value.seconds === "number" ? Math.floor(value.seconds) : 0;
  if (prompt === "" && sourceIds.length === 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const every = assistScheduleEvery(seconds);
  const rawMinute = "minuteOfDay" in value && typeof value.minuteOfDay === "number" ? value.minuteOfDay : undefined;
  const rawDay = "startsOn" in value && typeof value.startsOn === "string" ? value.startsOn : undefined;
  return { id, prompt, sourceIds, seconds: secondsFor(every), ...storedClock(every, rawMinute, rawDay) };
}

/** Schedules kept in this browser. A broken record is left out. */
export function readAssistSchedules(store: ScheduleStore = localStorage): readonly AssistSchedule[] {
  const raw = store.getItem(ASSIST_SCHEDULE_KEY);
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const schedules: AssistSchedule[] = [];
    for (const item of parsed) {
      const schedule = scheduleOf(item);
      if (schedule === null || schedules.some((kept) => kept.id === schedule.id)) continue;
      schedules.push(schedule);
      if (schedules.length === ASSIST_SCHEDULE_CAP) break;
    }
    return schedules;
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

/** Tells the page the saved schedules changed. */
export function subscribeAssistSchedules(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let cachedRaw = "\u0000";
let cachedSchedules: readonly AssistSchedule[] = [];

/** The schedules last read, stable while the stored text is unchanged. */
export function readAssistScheduleSnapshot(): readonly AssistSchedule[] {
  const raw = localStorage.getItem(ASSIST_SCHEDULE_KEY) ?? "";
  if (raw === cachedRaw) return cachedSchedules;
  cachedRaw = raw;
  cachedSchedules = readAssistSchedules();
  return cachedSchedules;
}

/** Replaces the saved schedules and tells the page. */
export function writeAssistSchedules(schedules: readonly AssistSchedule[], store: ScheduleStore = localStorage): void {
  store.setItem(ASSIST_SCHEDULE_KEY, JSON.stringify(schedules.slice(0, ASSIST_SCHEDULE_CAP)));
  if (store === localStorage) {
    cachedRaw = "\u0000";
    for (const listener of listeners) listener();
  }
}

/** The words shown for one schedule. The first line of the prompt, then its sources. */
export function assistScheduleLabel(
  schedule: AssistSchedule,
  picks: readonly { readonly id: string; readonly name: string }[],
): string {
  const names = schedule.sourceIds.flatMap((id) => {
    const pick = picks.find((item) => item.id === id);
    return pick === undefined ? [] : [pick.name];
  });
  const first = schedule.prompt.split("\n")[0]?.trim() ?? "";
  const lead = first === "" ? "Saved sources" : first;
  const extra = names.length === 0 ? "" : ` · ${names.join(", ")}`;
  return `${lead}${extra} · ${cadenceOf(schedule, assistDateKey(new Date()))}`;
}

function cadenceOf(schedule: AssistSchedule, today: string): string {
  if (assistScheduleEvery(schedule.seconds) !== "daily") return "Hourly";
  if (schedule.minuteOfDay === undefined) return "Daily";
  const time = `Daily at ${assistMinuteLabel(schedule.minuteOfDay)}`;
  const day = schedule.startsOn === undefined ? null : readAssistDate(schedule.startsOn);
  if (day !== null && day > today) {
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(5, 7));
    const date = Number(day.slice(8, 10));
    const short = new Date(year, month - 1, date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${time} · ${short}`;
  }
  return time;
}
