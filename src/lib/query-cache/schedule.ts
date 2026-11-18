import {
  ASSIST_SCHEDULE_DAILY_SECONDS,
  ASSIST_SCHEDULE_DEFAULT_MINUTE,
  ASSIST_SCHEDULE_HOURLY_SECONDS,
  assistDateKey,
  assistMinuteLabel,
  readAssistDate,
} from "@/lib/ai/assist-schedule";
import { MIN_CHART_REFRESH_SECONDS } from "@/lib/charts/chart-refresh";
import { cacheTableNameError } from "@/lib/query-cache/body";
import type { CacheEntry } from "@/lib/query-cache/entry";

/** A year of daily seconds, so a typed interval stays a delay a timer can hold. */
export const MAX_CACHE_REFRESH_SECONDS = 366 * 24 * 60 * 60;

const MINUTES_PER_DAY = 24 * 60;

/** How the calendar asks a table to refresh. */
export type CacheScheduleEvery = "hourly" | "daily" | "off";

/** The day, clock time, and month the cache calendar is showing. */
export interface CacheScheduleDraft {
  every: CacheScheduleEvery;
  minuteOfDay: number;
  startsOn: string;
  year: number;
  month: number;
}

/** Pause or resume a saved run without changing its calendar. */
export interface CachePause {
  tableName: string;
  paused: boolean;
}

/** One schedule update, after the request body has been checked. */
export interface CacheSchedule {
  tableName: string;
  /** Null clears the interval. The table then refreshes only when asked. */
  refreshSeconds: number | null;
  /** Local minutes after midnight. Null unless the schedule is daily at a clock time. */
  refreshMinute: number | null;
  /** Local calendar day `YYYY-MM-DD` a daily clock time may start. Null otherwise. */
  refreshStartsOn: string | null;
}

const CLEARED = {
  refreshSeconds: null,
  refreshMinute: null,
  refreshStartsOn: null,
} as const;

/**
 * The refresh a request asked for.
 *
 * `null` clears it. A whole number of seconds at or above the floor is kept.
 * Anything else is the sentence to answer with.
 */
export function readCacheRefresh(value: unknown): number | null | string {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return "Refresh must be a whole number of seconds.";
  }
  if (value < MIN_CHART_REFRESH_SECONDS) {
    return `A refresh waits at least ${MIN_CHART_REFRESH_SECONDS} seconds.`;
  }
  if (value > MAX_CACHE_REFRESH_SECONDS) return "A refresh can be at most 366 days.";
  return value;
}

function readMinute(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) return null;
  return value;
}

/** The calendar opened on today at 9:00, or on the clock already stored for `entry`. */
export function cacheScheduleDraft(
  entry: Pick<CacheEntry, "refreshSeconds" | "refreshMinute" | "refreshStartsOn"> | undefined,
  now = new Date(),
): CacheScheduleDraft {
  const today = assistDateKey(now);
  const opened: CacheScheduleDraft = {
    every: "daily",
    minuteOfDay: ASSIST_SCHEDULE_DEFAULT_MINUTE,
    startsOn: today,
    year: now.getFullYear(),
    month: now.getMonth(),
  };
  if (entry === undefined) return opened;
  if (entry.refreshMinute !== undefined && readMinute(entry.refreshMinute) !== null) {
    const stored = entry.refreshStartsOn === undefined ? null : readAssistDate(entry.refreshStartsOn);
    const startsOn = stored ?? today;
    return {
      every: "daily",
      minuteOfDay: entry.refreshMinute,
      startsOn,
      year: Number(startsOn.slice(0, 4)),
      month: Number(startsOn.slice(5, 7)) - 1,
    };
  }
  if (entry.refreshSeconds === ASSIST_SCHEDULE_HOURLY_SECONDS) return { ...opened, every: "hourly" };
  if (entry.refreshSeconds === ASSIST_SCHEDULE_DAILY_SECONDS) return opened;
  if (entry.refreshSeconds !== undefined) return { ...opened, every: "off" };
  return opened;
}

/** The words shown beside a cached table. Empty when it refreshes only when asked. */
export function cacheScheduleLabel(
  entry: Pick<CacheEntry, "refreshSeconds" | "refreshMinute" | "refreshStartsOn">,
  today = assistDateKey(new Date()),
): string {
  if (entry.refreshMinute !== undefined && readMinute(entry.refreshMinute) !== null) {
    const time = `Daily at ${assistMinuteLabel(entry.refreshMinute)}`;
    const day = entry.refreshStartsOn === undefined ? null : readAssistDate(entry.refreshStartsOn);
    if (day !== null && day > today) {
      const year = Number(day.slice(0, 4));
      const month = Number(day.slice(5, 7));
      const date = Number(day.slice(8, 10));
      const short = new Date(year, month - 1, date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `${time} · ${short}`;
    }
    return time;
  }
  if (entry.refreshSeconds === undefined) return "";
  if (entry.refreshSeconds === ASSIST_SCHEDULE_HOURLY_SECONDS) return "Hourly";
  if (entry.refreshSeconds === ASSIST_SCHEDULE_DAILY_SECONDS) return "Daily";
  return `every ${entry.refreshSeconds}s`;
}

type DailyWhen = number | "invalid" | "waiting";

/** The latest daily clock time at or before `now`, or why there is not one. */
function dailyInstant(minute: number, startsOn: string | undefined, now: number): DailyWhen {
  const rounded = readMinute(minute);
  if (rounded === null) return "invalid";
  const nowDate = new Date(now);
  const hour = Math.floor(rounded / 60);
  const mins = rounded % 60;
  const todayAt = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), hour, mins, 0, 0).getTime();
  const latest =
    todayAt <= now
      ? todayAt
      : new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1, hour, mins, 0, 0).getTime();
  const day = startsOn === undefined ? null : readAssistDate(startsOn);
  if (day === null) return latest;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const first = new Date(year, month - 1, date, hour, mins, 0, 0).getTime();
  if (now < first) return "waiting";
  return latest < first ? first : latest;
}

/** Whether `entry` is due for a refresh at `now` (epoch milliseconds). */
export function cacheIsDue(entry: CacheEntry, now: number): boolean {
  if (entry.refreshPaused === true) return false;
  if (entry.refreshMinute !== undefined) {
    const instant = dailyInstant(entry.refreshMinute, entry.refreshStartsOn, now);
    if (instant === "waiting") return false;
    if (instant !== "invalid") {
      const cached = Date.parse(entry.cachedAt);
      if (!Number.isFinite(cached)) return true;
      return cached < instant;
    }
  }
  if (entry.refreshSeconds === undefined) return false;
  const cached = Date.parse(entry.cachedAt);
  if (!Number.isFinite(cached)) return true;
  return now - cached >= entry.refreshSeconds * 1000;
}

function readEvery(value: unknown): CacheScheduleEvery | null {
  if (typeof value !== "string") return null;
  const every = value.trim().toLowerCase();
  if (every === "hourly" || every === "daily" || every === "off") return every;
  return null;
}

function calendarSchedule(
  tableName: string,
  every: CacheScheduleEvery,
  body: Record<string, unknown>,
): CacheSchedule | string {
  if (every === "off") return { tableName, ...CLEARED };
  if (every === "hourly") {
    return { tableName, refreshSeconds: ASSIST_SCHEDULE_HOURLY_SECONDS, refreshMinute: null, refreshStartsOn: null };
  }
  const refreshMinute = readMinute(body.minuteOfDay);
  if (refreshMinute === null) return "Choose a time.";
  if (typeof body.startsOn !== "string") return "Choose a day.";
  const refreshStartsOn = readAssistDate(body.startsOn);
  if (refreshStartsOn === null) return "Choose a day.";
  return { tableName, refreshSeconds: ASSIST_SCHEDULE_DAILY_SECONDS, refreshMinute, refreshStartsOn };
}

/**
 * Read a schedule update from a request body.
 *
 * `every` is the calendar: hourly, daily at a clock time, or off. `paused` holds
 * a saved run or lets it run again. A body that still sends `refreshSeconds`
 * keeps that interval and clears any clock time.
 * Returns the sentence to answer with when the body cannot be stored.
 */
export function readScheduleBody(body: Record<string, unknown>): CacheSchedule | CachePause | string {
  if (typeof body.tableName !== "string") return "Enter a table name. Query cache lists it as a table.";
  const nameError = cacheTableNameError(body.tableName);
  if (nameError !== null) return nameError;
  if ("paused" in body && !("every" in body) && !("refreshSeconds" in body)) {
    if (typeof body.paused !== "boolean") return "Say whether the run is paused.";
    return { tableName: body.tableName, paused: body.paused };
  }
  if ("every" in body) {
    const every = readEvery(body.every);
    if (every === null) return "Choose hourly, daily, or only when asked.";
    return calendarSchedule(body.tableName, every, body);
  }
  if (!("refreshSeconds" in body)) {
    return "Say how often the table refreshes, or null to refresh only when asked.";
  }
  const refreshSeconds = readCacheRefresh(body.refreshSeconds);
  if (typeof refreshSeconds === "string") return refreshSeconds;
  return { tableName: body.tableName, refreshSeconds, refreshMinute: null, refreshStartsOn: null };
}
