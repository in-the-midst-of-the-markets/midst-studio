import type { DetailedObject } from "@/lib/db/detailed-object";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import { savedQueryTableIdError } from "@/lib/saved-query-id";
import type { ColumnSchema, DatabaseConnection, SavedQuery } from "@/lib/types";
import { savedQueryShape } from "./columns";

/**
 * The connection the editor keeps for a saved-query join.
 *
 * It is not a DuckDB file and it is not stored with the user's connections. Selecting it is
 * what makes the editor DuckDB. Its tables are the saved queries that have an ID, and a
 * statement names them directly: `SELECT * FROM orders JOIN people ON orders.id = people.id`.
 */
export const CROSS_DB_JOINS_ID = "cross-db-joins";

export const CROSS_DB_JOINS_NAME = "Cross_DB_Joins";

/** What the object tree and the editor are told this connection can do. Nothing here opens a database. */
export const CROSS_DB_JOINS_CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: false,
  supportsTransactions: false,
  // Required by the capability type. This connection has no engine to limit, maintain, or dial.
  supportsExternalQueryLimiting: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: null,
  // A statement here never changes a database, so the tree is not reloaded from one.
  schemaRefreshPattern: "(?!)",
  identifierQuoting: "double",
  statementTerminator: "none",
  objectKinds: [
    {
      id: "table",
      role: "relation",
      label: "Saved query",
      labelPlural: "Saved queries",
    },
  ],
};

export function isCrossDbJoins(connection: { id: string } | null | undefined): boolean {
  return connection?.id === CROSS_DB_JOINS_ID;
}

/** A new record each call. The id is the identity; the object itself is never written to storage. */
export function crossDbJoinsConnection(): DatabaseConnection {
  return {
    id: CROSS_DB_JOINS_ID,
    name: CROSS_DB_JOINS_NAME,
    type: "duckdb",
    createdAt: new Date(0),
  };
}

/**
 * The list the sidebar shows: this connection first, then the ones the user actually has.
 *
 * A copy that was already in the list is dropped, so a reorder or a reload cannot keep a
 * second one or write this id into the saved order through the list it returns.
 */
export function withCrossDbJoins(connections: readonly DatabaseConnection[]): DatabaseConnection[] {
  return [crossDbJoinsConnection(), ...connections.filter((connection) => !isCrossDbJoins(connection))];
}

/** One saved query the DuckDB editor can join, with the columns its select list names. */
export interface CrossDbJoinTable {
  readonly tableId: string;
  readonly columns: readonly string[];
  readonly star: boolean;
}

/**
 * Saved queries that can be tables, in display order.
 *
 * A query saved on this connection is not one. Columns come from the select list, so the
 * editor can offer them before any join has run. A `*` leaves the column list empty.
 */
export function crossDbJoinTables(queries: readonly SavedQuery[]): CrossDbJoinTable[] {
  const tables: CrossDbJoinTable[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (query.connectionId === CROSS_DB_JOINS_ID) continue;
    const tableId = query.tableId;
    if (tableId === undefined || savedQueryTableIdError(tableId) !== null) continue;
    const key = tableId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const shape = savedQueryShape(query.query);
    tables.push({ tableId, columns: shape.columns, star: shape.star });
  }
  tables.sort((left, right) => left.tableId.localeCompare(right.tableId));
  return tables;
}

function columnsOf(table: CrossDbJoinTable | undefined): ColumnSchema[] {
  if (table === undefined) return [];
  // A select list names a result column, not a key, and the value can be null.
  return table.columns.map((name) => ({ name, type: "", nullable: true, isPrimary: false }));
}

/** The schema the mobile explorer and the assistant read. */
export function crossDbJoinsSchema(queries: readonly SavedQuery[]): DetailedObject[] {
  return crossDbJoinTables(queries).map((table) => ({
    name: table.tableId,
    kind: "table",
    path: [table.tableId],
    columns: columnsOf(table),
    indexes: [],
  }));
}

/** The object-tree listing. The path is the table name alone, so a click writes `orders` and not `main.orders`. */
function crossDbJoinsObjects(queries: readonly SavedQuery[]): DatabaseObject[] {
  return crossDbJoinTables(queries).map((table) => ({
    name: table.tableId,
    kind: "table",
    path: [table.tableId],
  }));
}

/**
 * One object-tree read, answered from saved queries.
 *
 * The tree asks for containers, counts, a listing, and a description. This connection has
 * no database behind it, so those answers are the saved-query IDs and nothing else.
 */
export function crossDbJoinsObjectAnswer(
  queries: readonly SavedQuery[],
  request: { route: string; kind?: string; path?: readonly string[] },
): unknown {
  if (request.route === "describe") {
    const tableId = request.path?.at(-1);
    const table =
      tableId === undefined
        ? undefined
        : crossDbJoinTables(queries).find((item) => item.tableId.toLowerCase() === tableId.toLowerCase());
    return { columns: columnsOf(table), indexes: [] };
  }
  if (request.route === "counts") return {};
  if (request.route === "list" && request.kind === "table") return crossDbJoinsObjects(queries);
  return [];
}
