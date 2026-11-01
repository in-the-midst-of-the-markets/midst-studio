/** The shortest schedule. A chart may refresh by rerunning its query, and not more often than this. */
export const MIN_CHART_REFRESH_SECONDS = 60;

export interface RefreshSchedule {
  readonly ok: true;
  /** Absent when the field was left blank: the chart keeps the last result. */
  readonly seconds?: number;
  /** True when the user asked for a shorter gap and the schedule was raised to the floor. */
  readonly raised: boolean;
}

export interface RefreshScheduleError {
  readonly ok: false;
  readonly error: string;
}

/**
 * The refresh field as a schedule.
 * A blank field is off. Anything that is not a whole number of seconds is refused.
 * A count below the floor is kept, raised to the floor, and reported so the field can show it.
 */
export function readRefreshText(text: string): RefreshSchedule | RefreshScheduleError {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, raised: false };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Refresh must be a whole number of seconds." };
  const seconds = Number(trimmed);
  if (seconds < MIN_CHART_REFRESH_SECONDS) {
    return { ok: true, seconds: MIN_CHART_REFRESH_SECONDS, raised: true };
  }
  return { ok: true, seconds, raised: false };
}

/** The timer delay for a stored schedule, or null when the chart does not refresh. */
export function refreshDelayMs(seconds: number | undefined): number | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  const stored = Math.floor(seconds);
  if (stored <= 0) return null;
  return Math.max(stored, MIN_CHART_REFRESH_SECONDS) * 1000;
}
