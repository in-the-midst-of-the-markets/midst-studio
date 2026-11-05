import { savedQueryTableIdError } from "@/lib/saved-query-id";
import type { DatabaseConnection, SavedQuery } from "@/lib/types";
import { CROSS_DB_JOINS_ID } from "./connection";

/**
 * One saved query as the join route receives it.
 *
 * A seed is named by `connectionId` (`seed:<id>`), the same shape a normal run uses.
 * Every other connection travels as the record the browser already holds. A query saved
 * before connections were recorded, or whose connection was deleted, carries neither.
 */
export interface SavedJoinCatalogEntry {
  name: string;
  query: string;
  connectionId?: string;
  connection?: DatabaseConnection;
}

/** The connection payload a normal editor run would send for `connection`. */
function connectionPayload(
  connection: DatabaseConnection,
): { connectionId: string } | { connection: DatabaseConnection } {
  if (connection.managed && connection.seedId) return { connectionId: `seed:${connection.seedId}` };
  return { connection };
}

/** The saved queries the open editor can offer a join, each pointed at its connection. */
export function savedJoinCatalog(
  queries: readonly SavedQuery[],
  connections: readonly DatabaseConnection[],
): SavedJoinCatalogEntry[] {
  const entries: SavedJoinCatalogEntry[] = [];
  for (const query of queries) {
    // The join names the ID, not the display name. A query saved before IDs existed
    // cannot be a table until it is saved again.
    if (query.tableId === undefined || savedQueryTableIdError(query.tableId) !== null) continue;
    // A statement saved on Cross_DB_Joins is DuckDB over other saved queries. It is reopened
    // from Saved Queries. It is not a source table, because it has no database to read.
    if (query.connectionId === CROSS_DB_JOINS_ID) continue;
    const connection = connections.find((item) => item.id === query.connectionId);
    if (!connection) {
      entries.push({ name: query.tableId, query: query.query });
      continue;
    }
    entries.push({ name: query.tableId, query: query.query, ...connectionPayload(connection) });
  }
  return entries;
}
