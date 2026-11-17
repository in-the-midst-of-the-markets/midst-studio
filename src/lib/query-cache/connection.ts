import { isCrossDbJoins } from "@/lib/saved-join/connection";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The connection the editor keeps for cached query results.
 *
 * It is not stored with the user's connections. The server opens that user's own DuckDB
 * file when a request names this id, and ignores any path the request tried to send.
 */
export const QUERY_CACHE_ID = "query-cache";

export const QUERY_CACHE_NAME = "Query cache";

export function isQueryCache(connection: { id: string } | null | undefined): boolean {
  return connection?.id === QUERY_CACHE_ID;
}

/**
 * A connection the app keeps in the list: Cross_DB_Joins, or the query cache.
 *
 * Neither is a database the user added, so a refresh of the managed list must not
 * drop it, and the row offers no delete.
 */
export function isAppKeptConnection(connection: { id: string } | null | undefined): boolean {
  return isCrossDbJoins(connection) || isQueryCache(connection);
}

/** A new record each call. The file path stays on the server. */
export function queryCacheConnection(): DatabaseConnection {
  return {
    id: QUERY_CACHE_ID,
    name: QUERY_CACHE_NAME,
    type: "duckdb",
    createdAt: new Date(0),
  };
}

/**
 * The list the sidebar shows, with the query cache beside Cross_DB_Joins.
 *
 * A copy that was already in the list is dropped, so a reload cannot keep a second
 * one or write this id into the saved order.
 */
export function withQueryCache(connections: readonly DatabaseConnection[]): DatabaseConnection[] {
  const rest = connections.filter((connection) => !isQueryCache(connection));
  const cache = queryCacheConnection();
  if (!rest.some((connection) => isCrossDbJoins(connection))) return [cache, ...rest];
  const next: DatabaseConnection[] = [];
  let placed = false;
  for (const connection of rest) {
    next.push(connection);
    if (!placed && isCrossDbJoins(connection)) {
      next.push(cache);
      placed = true;
    }
  }
  return next;
}
