/**
 * Bounds for one cached query result.
 *
 * The rows already on screen are what gets stored. A later read of the DuckDB table
 * does not run the source again, which is the point once a source read spends credits.
 * Refresh runs the source once more and replaces the table, so the cap is the same
 * on the way in and on a refresh.
 */

export const QUERY_CACHE_MAX_ROWS = 10_000;
export const QUERY_CACHE_MAX_SQL = 100_000;
export const QUERY_CACHE_MAX_NAME = 200;
export const QUERY_CACHE_MAX_FIELDS = 500;
export const QUERY_CACHE_MAX_FIELD_NAME = 256;

/** A cache write this server will not do. The route answers it as 400. */
export class QueryCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryCacheError";
  }
}

export function tooManyRowsMessage(): string {
  return `A cached table can hold at most ${QUERY_CACHE_MAX_ROWS.toLocaleString("en-US")} rows. Narrow the query before caching it.`;
}
