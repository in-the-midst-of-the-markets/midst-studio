/** How much of a dashboard one snapshot will copy. A larger result is refused, not truncated into a silent partial. */

export const SHARE_MAX_SOURCE_ROWS = 10_000;
export const SHARE_MAX_RESULT_ROWS = 10_000;
export const SHARE_MAX_TABLES = 24;
export const SHARE_TIMEOUT_MS = 15_000;
export const SHARE_MEMORY_LIMIT = "256MB";
export const SHARE_THREADS = 1;
export const SHARE_MAX_SQL_CHARS = 100_000;

export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareError";
  }
}

export class ShareNotFoundError extends ShareError {
  constructor() {
    super("This shared dashboard is no longer available.");
    this.name = "ShareNotFoundError";
  }
}

export function shareRowLimitMessage(label: string): string {
  return `${label} returned more than ${SHARE_MAX_SOURCE_ROWS.toLocaleString("en-US")} rows. Narrow that query before sharing the dashboard.`;
}
