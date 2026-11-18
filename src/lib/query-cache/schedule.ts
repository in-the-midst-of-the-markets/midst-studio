import { MIN_CHART_REFRESH_SECONDS, readRefreshText, type RefreshScheduleError } from "@/lib/charts/chart-refresh";
import { cacheTableNameError } from "@/lib/query-cache/body";
import type { CacheEntry } from "@/lib/query-cache/entry";

/** A year of daily seconds, so a typed interval stays a delay a timer can hold. */
export const MAX_CACHE_REFRESH_SECONDS = 366 * 24 * 60 * 60;

export interface CacheInterval {
  readonly ok: true;
  /** Null when the field was left blank: the table refreshes only when asked. */
  readonly seconds: number | null;
  readonly raised: boolean;
}

/** One schedule update, after the request body has been checked. */
export interface CacheSchedule {
  tableName: string;
  /** Null clears the interval. The table then refreshes only when asked. */
  refreshSeconds: number | null;
}

/**
 * The refresh field as a cache schedule.
 *
 * A blank field is off. A count below the chart floor is raised to that floor and
 * reported, so the field can show it before anything is saved. A count past a year
 * is refused.
 */
export function readCacheIntervalText(text: string): CacheInterval | RefreshScheduleError {
  const read = readRefreshText(text);
  if (!read.ok) return read;
  if (read.seconds === undefined) return { ok: true, seconds: null, raised: false };
  if (read.raised) return { ok: true, seconds: read.seconds, raised: true };
  if (read.seconds > MAX_CACHE_REFRESH_SECONDS) return { ok: false, error: "A refresh can be at most 366 days." };
  return { ok: true, seconds: read.seconds, raised: false };
}

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

/** Whether `entry` is due for a refresh at `now` (epoch milliseconds). */
export function cacheIsDue(entry: CacheEntry, now: number): boolean {
  if (entry.refreshSeconds === undefined) return false;
  const cached = Date.parse(entry.cachedAt);
  if (!Number.isFinite(cached)) return true;
  return now - cached >= entry.refreshSeconds * 1000;
}

/**
 * Read a schedule update from a request body.
 *
 * Returns the sentence to answer with when the body cannot be stored. The table
 * has to exist already; this only changes how often it refreshes.
 */
export function readScheduleBody(body: Record<string, unknown>): CacheSchedule | string {
  if (typeof body.tableName !== "string") return "Enter a table name. Query cache lists it as a table.";
  const tableName = cacheTableNameError(body.tableName);
  if (tableName !== null) return tableName;
  if (!("refreshSeconds" in body)) {
    return "Say how often the table refreshes, or null to refresh only when asked.";
  }
  const refreshSeconds = readCacheRefresh(body.refreshSeconds);
  if (typeof refreshSeconds === "string") return refreshSeconds;
  return { tableName: body.tableName, refreshSeconds };
}
