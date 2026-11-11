/**
 * How a monitoring tab spells a duration that came from the server.
 *
 * `formatDuration` in `pool-manager.ts` prints one unit with two decimals (`1.50m`).
 * The engines below print a clock instead, and they already agreed on the words.
 */

/** Days, hours and minutes: `1d 1h 1m`, `1h 2m`, or `2m`. */
export function formatUptime(seconds: number): string {
  return spellUptime(seconds, false);
}

/**
 * The same clock, except a span of a day or more stops at the hour: `1d 0h`.
 * MySQL's `Uptime` status and MongoDB's `serverStatus.uptime` are read this way.
 */
export function formatUptimeToTheHour(seconds: number): string {
  return spellUptime(seconds, true);
}

function spellUptime(seconds: number, daysToTheHour: boolean): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return daysToTheHour ? `${days}d ${hours}h` : `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A session length: `500.6ms`, `5.0s`, `1m 5s`, or `2h 1m`. */
export function formatRunningTime(ms: number): string {
  return spellRunningTime(ms, `${ms}ms`);
}

/** The same session length, with a fractional millisecond rounded: `500.6` becomes `501ms`. */
export function formatRunningTimeRounded(ms: number): string {
  return spellRunningTime(ms, `${Math.round(ms)}ms`);
}

function spellRunningTime(ms: number, subsecond: string): string {
  if (ms < 1000) return subsecond;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
