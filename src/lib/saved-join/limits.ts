/**
 * The compute budget of one saved join.
 *
 * The join runs in a private in-memory DuckDB after each saved query has run on its own
 * database. These bounds are what keep that from becoming a second, unbounded database:
 * a saved query that returns more than the row cap is refused, the DuckDB statement that
 * returns more than the result cap is refused, and the engine itself is opened with a
 * memory limit, one thread, and a deadline.
 */

export const SAVED_JOIN_MAX_SOURCE_ROWS = 10_000;
export const SAVED_JOIN_MAX_RESULT_ROWS = 10_000;
export const SAVED_JOIN_MEMORY_LIMIT = "256MB";
export const SAVED_JOIN_THREADS = 1;
export const SAVED_JOIN_TIMEOUT_MS = 15_000;
export const SAVED_JOIN_MAX_SQL_CHARS = 100_000;
/** How many saved queries one statement may name. Each one runs before the join. */
export const SAVED_JOIN_MAX_TABLES = 8;

export interface SavedJoinLimits {
  maxSourceRows: number;
  maxResultRows: number;
  memoryLimit: string;
  threads: number;
  timeoutMs: number;
}

export const SAVED_JOIN_LIMITS: SavedJoinLimits = {
  maxSourceRows: SAVED_JOIN_MAX_SOURCE_ROWS,
  maxResultRows: SAVED_JOIN_MAX_RESULT_ROWS,
  memoryLimit: SAVED_JOIN_MEMORY_LIMIT,
  threads: SAVED_JOIN_THREADS,
  timeoutMs: SAVED_JOIN_TIMEOUT_MS,
};

/** A join the user asked for that this server will not run. The route answers it as 400. */
export class SavedJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedJoinError";
  }
}

export function sourceRowLimitMessage(name: string, maxRows: number): string {
  return `Saved query "${name}" returned more than ${maxRows.toLocaleString("en-US")} rows. The join stops there so one saved query cannot use the whole server.`;
}

export function resultRowLimitMessage(maxRows: number): string {
  return `This join produced more than ${maxRows.toLocaleString("en-US")} rows. Narrow the DuckDB statement or the saved queries.`;
}

export function timeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `This join ran longer than ${seconds} seconds and was stopped.`;
}
