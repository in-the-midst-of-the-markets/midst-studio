import { openDuckDBClient, type DuckDBClient } from "@/lib/db/providers/sql/duckdb/client";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import type { DatabaseConnection, QueryPagination, QueryResult } from "@/lib/types";
import { savedQueryTableIdError } from "@/lib/saved-query-id";
import { joinExtensionFiles } from "@/lib/saved-join/extensions";
import { linkedQueryNames, propertyGraphSql, type GraphColumnTable } from "@/lib/saved-join/graph";
import {
  SAVED_JOIN_LIMITS,
  SAVED_JOIN_MAX_TABLES,
  SavedJoinError,
  resultRowLimitMessage,
  sourceRowLimitMessage,
  timeoutMessage,
  type SavedJoinLimits,
} from "./limits";

/** One saved query the join may read, plus the connection it runs on when it still has one. */
export interface SavedJoinSource {
  name: string;
  query: string;
  /** The caller's own connection record, when this query was not saved from a seed. */
  connection: DatabaseConnection | null;
  /** `seed:<id>` when the saved query reads a managed connection. */
  connectionId?: string;
}

export interface SavedJoinPage {
  limit: number;
  offset: number;
  unlimited: boolean;
}

export interface SavedJoinTable {
  fields: string[];
  rows: Record<string, unknown>[];
}

/** The rows of one saved query. Called only for a query the DuckDB statement names. */
export type SavedJoinRunner = (source: SavedJoinSource, signal: AbortSignal) => Promise<SavedJoinTable>;

export interface SavedJoinRun {
  sql: string;
  saved: readonly SavedJoinSource[];
  page: SavedJoinPage;
  signal: AbortSignal;
  runSource: SavedJoinRunner;
  limits?: SavedJoinLimits;
}

type ColumnType = "BOOLEAN" | "BIGINT" | "DOUBLE" | "VARCHAR" | `FLOAT[${number}]`;

interface ParsedJoin {
  tables: string[];
  /** The statement calls pagerank or another DuckPGQ table function. */
  graph: boolean;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function throwIfStopped(signal: AbortSignal, limits: SavedJoinLimits): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError")
    throw new SavedJoinError(timeoutMessage(limits.timeoutMs));
  throw new SavedJoinError("The join was cancelled.");
}

function columnType(values: readonly unknown[]): ColumnType {
  let chosen: ColumnType | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const next = valueType(value);
    if (next === null) return "VARCHAR";
    if (chosen === null) {
      chosen = next;
      continue;
    }
    if (chosen === next) continue;
    if ((chosen === "BIGINT" && next === "DOUBLE") || (chosen === "DOUBLE" && next === "BIGINT")) {
      chosen = "DOUBLE";
      continue;
    }
    return "VARCHAR";
  }
  return chosen ?? "VARCHAR";
}

function numericArrayLength(value: unknown): number | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2048) return null;
  if (!parsed.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return parsed.length;
}

function valueType(value: unknown): ColumnType | null {
  const length = numericArrayLength(value);
  if (length !== null) return `FLOAT[${length}]`;
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "bigint") return "BIGINT";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return "BIGINT";
    if (Number.isFinite(value)) return "DOUBLE";
  }
  if (typeof value === "string") return "VARCHAR";
  return null;
}

function bindValue(value: unknown, type: ColumnType): string | number | bigint | boolean | null {
  if (value === null || value === undefined) return null;
  if (type.startsWith("FLOAT[")) {
    const length = numericArrayLength(value);
    if (length === null) return null;
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown[]) : (value as unknown[]);
    return JSON.stringify(parsed);
  }
  if (type === "BOOLEAN") return value === true;
  if (type === "BIGINT") return typeof value === "bigint" ? value : Math.trunc(Number(value));
  if (type === "DOUBLE") return Number(value);
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectCteNames(node: unknown, names: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectCteNames(entry, names);
    return;
  }
  if (!isRecord(node)) return;
  const map = node.cte_map;
  if (isRecord(map) && Array.isArray(map.map)) {
    for (const entry of map.map) {
      if (isRecord(entry) && typeof entry.key === "string") names.add(entry.key.toLowerCase());
    }
  }
  for (const value of Object.values(node)) collectCteNames(value, names);
}

/** Scalar functions that read this process's DuckDB configuration, which names directories on the server. */
const SERVER_STATE_FUNCTIONS = new Set(["current_setting"]);

/**
 * Functions that run SQL from a string. The text inside the call is not part of this
 * statement's tree, so the checks below cannot see a `current_setting` hidden there.
 */
const HIDDEN_SQL_FUNCTIONS = new Set(["json_execute_serialized_sql", "query", "query_table"]);

/**
 * Schemas a saved join accepts. An unqualified name and `main` are the table the editor
 * writes. `saved` remains the name a statement used before the connection existed.
 */
const JOIN_TABLE_SCHEMAS = new Set(["", "main", "saved"]);

/** DuckPGQ table functions. Their string arguments name the vertex table, not a file. */
const GRAPH_TABLE_FUNCTIONS = new Set(["pagerank", "weakly_connected_component", "local_clustering_coefficient"]);

/**
 * Vector table functions. The first column-reference arguments are saved-query IDs.
 * `vss_join` takes two tables, `vss_match` takes the table it searches.
 */
const VECTOR_TABLE_FUNCTIONS = new Set(["vss_join", "vss_match"]);

interface JoinScan {
  tables: string[];
  /** Names a graph or vector function mentioned. A label that is not a saved query is ignored. */
  mentions: string[];
  graph: boolean;
}

function functionRecord(node: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(node.function) ? node.function : null;
}

function functionName(node: Record<string, unknown>): string | null {
  const fn = functionRecord(node);
  return fn !== null && typeof fn.function_name === "string" ? fn.function_name.toLowerCase() : null;
}

function collectFunctionTables(node: Record<string, unknown>, mentions: string[]): void {
  const name = functionName(node);
  const fn = functionRecord(node);
  if (name === null || fn === null || !Array.isArray(fn.children)) return;
  if (GRAPH_TABLE_FUNCTIONS.has(name)) {
    for (const child of fn.children) {
      if (!isRecord(child) || child.type !== "VALUE_CONSTANT" || !isRecord(child.value)) continue;
      const value = child.value.value;
      if (typeof value === "string" && savedQueryTableIdError(value) === null) mentions.push(value);
    }
    return;
  }
  if (!VECTOR_TABLE_FUNCTIONS.has(name)) return;
  const tableArgs = name === "vss_match" ? 1 : 2;
  let seen = 0;
  for (const child of fn.children) {
    if (seen >= tableArgs) return;
    if (!isRecord(child) || child.type !== "COLUMN_REF" || !Array.isArray(child.column_names)) continue;
    seen += 1;
    const table = child.column_names.length === 1 ? child.column_names[0] : null;
    if (typeof table === "string") mentions.push(table);
  }
}

function collectTables(node: unknown, tables: string[], ctes: Set<string>, scan: JoinScan): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectTables(entry, tables, ctes, scan);
    return;
  }
  if (!isRecord(node)) return;
  if (node.type === "SHOW_REF") {
    throw new SavedJoinError("A saved join can only read saved queries by their ID.");
  }
  if (node.type === "TABLE_FUNCTION") {
    const name = functionName(node);
    if (name === null || (!GRAPH_TABLE_FUNCTIONS.has(name) && !VECTOR_TABLE_FUNCTIONS.has(name))) {
      throw new SavedJoinError("A saved join can only read saved queries by their ID.");
    }
    if (GRAPH_TABLE_FUNCTIONS.has(name)) scan.graph = true;
    collectFunctionTables(node, scan.mentions);
  }
  if (node.type === "FUNCTION" && typeof node.function_name === "string") {
    const name = node.function_name.toLowerCase();
    if (SERVER_STATE_FUNCTIONS.has(name)) {
      throw new SavedJoinError("A saved join cannot read the server's settings.");
    }
    if (HIDDEN_SQL_FUNCTIONS.has(name)) {
      throw new SavedJoinError("A saved join cannot run SQL hidden inside a function.");
    }
  }
  if (node.type === "BASE_TABLE") {
    const schema = typeof node.schema_name === "string" ? node.schema_name : "";
    const table = typeof node.table_name === "string" ? node.table_name : "";
    const catalog = typeof node.catalog_name === "string" ? node.catalog_name : "";
    if (catalog !== "" || node.at_clause != null) {
      throw new SavedJoinError("A saved join can only read saved queries by their ID.");
    }
    const schemaKey = schema.toLowerCase();
    if (!JOIN_TABLE_SCHEMAS.has(schemaKey)) {
      throw new SavedJoinError(`A saved join can only read saved queries. "${schema}.${table}" is not one.`);
    }
    if (table === "") throw new SavedJoinError("A saved join needs the saved query's ID.");
    // A common-table expression is not a saved query. A qualified name is, even when a
    // common-table expression uses the same spelling.
    const isCte = schemaKey === "" && ctes.has(table.toLowerCase());
    if (!isCte) tables.push(table);
  }
  for (const value of Object.values(node)) collectTables(value, tables, ctes, scan);
}

async function parseJoin(client: DuckDBClient, sql: string, saved: readonly SavedJoinSource[]): Promise<ParsedJoin> {
  const grammar = resolveSqlGrammar("duckdb");
  if (countCodeStatements(sql, grammar) !== 1) {
    throw new SavedJoinError(
      "A saved join has to be one DuckDB statement. It runs the saved queries first, then that statement.",
    );
  }
  let parsed: { rows: Record<string, unknown>[] };
  try {
    parsed = await client.run("SELECT json_serialize_sql(?::VARCHAR) AS ast", [sql]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SavedJoinError(message);
  }
  let ast: unknown;
  try {
    ast = JSON.parse(String(parsed.rows[0]?.ast ?? "null"));
  } catch {
    throw new SavedJoinError("The statement could not be read.");
  }
  if (!isRecord(ast) || ast.error === true) {
    const message =
      isRecord(ast) && typeof ast.error_message === "string" ? ast.error_message : "The statement could not be read.";
    if (message.includes("Only SELECT statements")) {
      throw new SavedJoinError(
        "A saved join has to be one DuckDB SELECT. It runs the saved queries first, then that statement.",
      );
    }
    throw new SavedJoinError(message);
  }
  const statements = Array.isArray(ast.statements) ? ast.statements : [];
  if (statements.length !== 1 || !isRecord(statements[0]) || !isRecord(statements[0].node)) {
    throw new SavedJoinError(
      "A saved join has to be one DuckDB statement. It runs the saved queries first, then that statement.",
    );
  }
  const ctes = new Set<string>();
  collectCteNames(statements[0].node, ctes);
  const scan: JoinScan = { tables: [], mentions: [], graph: false };
  collectTables(statements[0].node, scan.tables, ctes, scan);
  const known = new Set(saved.map((entry) => entry.name.toLowerCase()));
  const tables = [...scan.tables, ...scan.mentions.filter((name) => known.has(name.toLowerCase()))];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    const key = table.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(table);
  }
  if (unique.length === 0) {
    throw new SavedJoinError(
      "Name at least one saved query by its ID. The join runs that query first, then this DuckDB statement.",
    );
  }
  if (unique.length > SAVED_JOIN_MAX_TABLES) {
    throw new SavedJoinError(
      `A saved join can read at most ${SAVED_JOIN_MAX_TABLES} saved queries. This statement names ${unique.length}.`,
    );
  }
  for (const table of unique) {
    const idError = savedQueryTableIdError(table);
    if (idError !== null) throw new SavedJoinError(idError);
  }
  return { tables: unique, graph: scan.graph };
}

function matchSource(tableName: string, saved: readonly SavedJoinSource[]): SavedJoinSource {
  const exact = saved.filter((entry) => entry.name === tableName);
  if (exact.length > 1) {
    throw new SavedJoinError(
      `More than one saved query uses the ID "${tableName}". Pick a different ID for one of them.`,
    );
  }
  if (exact.length === 1) return exact[0] as SavedJoinSource;
  const folded = saved.filter((entry) => entry.name.toLowerCase() === tableName.toLowerCase());
  if (folded.length > 1) {
    throw new SavedJoinError(
      `More than one saved query matches the ID "${tableName}". Pick a different ID for one of them.`,
    );
  }
  if (folded.length === 1) return folded[0] as SavedJoinSource;
  throw new SavedJoinError(`There is no saved query with the ID "${tableName}".`);
}

async function loadTable(client: DuckDBClient, table: string, sheet: SavedJoinTable): Promise<ColumnType[]> {
  if (sheet.fields.length === 0) {
    throw new SavedJoinError(`Saved query "${table}" returned no columns, so there is nothing to join.`);
  }
  const types = sheet.fields.map((field) => columnType(sheet.rows.map((row) => row[field])));
  const columns = sheet.fields.map((field, index) => `${quoteIdent(field)} ${types[index]}`).join(", ");
  // DuckDB's default schema is `main`, which is where an unqualified name looks. The view
  // keeps `saved.<id>` working for a statement written that way. The view names `main`
  // explicitly: `SELECT * FROM orders` inside `saved.orders` would bind the view to itself.
  const name = `${quoteIdent("main")}.${quoteIdent(table)}`;
  await client.run(`CREATE TABLE ${name} (${columns})`);
  const placeholders = types.map((type) => (type.startsWith("FLOAT[") ? `?::${type}` : "?")).join(", ");
  const insert = `INSERT INTO ${name} VALUES (${placeholders})`;
  for (const row of sheet.rows) {
    const values = sheet.fields.map((field, index) => bindValue(row[field], types[index] ?? "VARCHAR"));
    // oxlint-disable-next-line no-await-in-loop -- one connection inserts one row at a time.
    await client.run(insert, values);
  }
  await client.run(`CREATE VIEW ${quoteIdent("saved")}.${quoteIdent(table)} AS SELECT * FROM ${name}`);
  return types;
}

function pageOf(
  rows: Record<string, unknown>[],
  page: SavedJoinPage,
): { rows: Record<string, unknown>[]; pagination: QueryPagination } {
  if (page.unlimited) {
    return {
      rows,
      pagination: { limit: rows.length, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: false },
    };
  }
  const sliced = rows.slice(page.offset, page.offset + page.limit);
  return {
    rows: sliced,
    pagination: {
      limit: page.limit,
      offset: page.offset,
      hasMore: page.offset + sliced.length < rows.length,
      totalReturned: sliced.length,
      wasLimited: false,
    },
  };
}

const MEMORY_LIMIT = /^[0-9]+(?:KB|MB|GB|TB)$/;

function assertEngineLimits(limits: SavedJoinLimits): void {
  if (!MEMORY_LIMIT.test(limits.memoryLimit)) {
    throw new SavedJoinError("The join memory limit is not a size this server can apply.");
  }
  if (!Number.isInteger(limits.threads) || limits.threads < 1 || limits.threads > 4) {
    throw new SavedJoinError("The join thread count is not a count this server can apply.");
  }
}

async function indexVectors(
  client: DuckDBClient,
  table: string,
  fields: readonly string[],
  types: readonly ColumnType[],
): Promise<void> {
  if (!client.loadedExtensions.includes("vss")) return;
  for (const [index, field] of fields.entries()) {
    const type = types[index] ?? "VARCHAR";
    if (!type.startsWith("FLOAT[")) continue;
    const indexName = quoteIdent(`hnsw_${table}_${field}`);
    // oxlint-disable-next-line no-await-in-loop -- one connection builds one index, then the next.
    await client.run(
      `CREATE INDEX ${indexName} ON ${quoteIdent("main")}.${quoteIdent(table)} USING HNSW (${quoteIdent(field)}) WITH (metric = 'cosine')`,
    );
  }
}

/**
 * Run each saved query the statement names, load the rows into a private DuckDB, and run the statement.
 *
 * The handle loads `vss` and `duckpgq` when those builds exist for this DuckDB, then turns external
 * access off before the statement runs, so the statement still cannot read a file or the network.
 * It is closed before this returns, including on failure.
 */
export async function runSavedJoin(
  input: SavedJoinRun,
): Promise<Omit<QueryResult, "pagination"> & { pagination: QueryPagination }> {
  const limits = input.limits ?? SAVED_JOIN_LIMITS;
  const started = Date.now();
  assertEngineLimits(limits);
  throwIfStopped(input.signal, limits);
  const extensions = await joinExtensionFiles(input.signal);
  throwIfStopped(input.signal, limits);
  const client = await openDuckDBClient(":memory:", {
    readOnly: false,
    denyExternalAccess: extensions.signed.length === 0 && extensions.community.length === 0,
    joinExtensions: extensions.signed.length === 0 && extensions.community.length === 0 ? undefined : extensions,
  });
  const stop = (): void => client.interrupt();
  input.signal.addEventListener("abort", stop);
  try {
    throwIfStopped(input.signal, limits);
    await client.run(`SET memory_limit = '${limits.memoryLimit}'`);
    await client.run(`SET threads = ${limits.threads}`);
    let parsed: ParsedJoin;
    try {
      parsed = await parseJoin(client, input.sql, input.saved);
    } catch (error) {
      if (input.signal.aborted) throwIfStopped(input.signal, limits);
      throw error;
    }
    await client.run("CREATE SCHEMA saved");
    const loaded: GraphColumnTable[] = [];
    const typesByTable = new Map<string, ColumnType[]>();
    const loadedNames = new Set<string>();
    const loadNamed = async (table: string): Promise<void> => {
      throwIfStopped(input.signal, limits);
      const source = matchSource(table, input.saved);
      if (source.connection === null && source.connectionId === undefined) {
        throw new SavedJoinError(
          `Saved query "${source.name}" has no connection. Save it again from the database it reads.`,
        );
      }
      let sheet: SavedJoinTable;
      try {
        sheet = await input.runSource(source, input.signal);
      } catch (error) {
        if (input.signal.aborted) throwIfStopped(input.signal, limits);
        if (error instanceof SavedJoinError || error instanceof SeedConnectionError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new SavedJoinError(`Saved query "${source.name}" failed: ${message}`);
      }
      if (sheet.rows.length > limits.maxSourceRows) {
        throw new SavedJoinError(sourceRowLimitMessage(source.name, limits.maxSourceRows));
      }
      const types = await loadTable(client, source.name, sheet);
      loaded.push({ name: source.name, fields: sheet.fields });
      typesByTable.set(source.name, types);
      loadedNames.add(source.name.toLowerCase());
    };
    for (const table of parsed.tables) {
      // oxlint-disable-next-line no-await-in-loop -- each saved query runs after the one before it, under the one memory limit.
      await loadNamed(table);
    }
    if (parsed.graph) {
      const available = input.saved.map((entry) => entry.name);
      let grew = true;
      while (grew && loaded.length < SAVED_JOIN_MAX_TABLES) {
        grew = false;
        for (const table of [...loaded]) {
          for (const partner of linkedQueryNames(table.fields, available)) {
            if (loadedNames.has(partner.toLowerCase()) || loaded.length >= SAVED_JOIN_MAX_TABLES) continue;
            // oxlint-disable-next-line no-await-in-loop -- a foreign key loads its target after the table that points at it.
            await loadNamed(partner);
            grew = true;
          }
        }
      }
      if (client.loadedExtensions.includes("duckpgq")) {
        for (const statement of propertyGraphSql(loaded)) {
          // oxlint-disable-next-line no-await-in-loop -- the graph is a schema, then one table per edge, then the graph.
          await client.run(statement);
        }
      }
    }
    for (const table of loaded) {
      // oxlint-disable-next-line no-await-in-loop -- each FLOAT array column gets its own cosine index.
      await indexVectors(client, table.name, table.fields, typesByTable.get(table.name) ?? []);
    }
    throwIfStopped(input.signal, limits);
    let result: Awaited<ReturnType<DuckDBClient["run"]>>;
    try {
      result = await client.run(input.sql);
    } catch (error) {
      if (input.signal.aborted) throwIfStopped(input.signal, limits);
      const message = error instanceof Error ? error.message : String(error);
      throw new SavedJoinError(message);
    }
    if (result.rows.length > limits.maxResultRows) {
      throw new SavedJoinError(resultRowLimitMessage(limits.maxResultRows));
    }
    const paged = pageOf(result.rows, input.page);
    return {
      rows: rowsWithNonFiniteWords(paged.rows),
      fields: result.columnNames,
      rowCount: paged.rows.length,
      executionTime: Date.now() - started,
      pagination: paged.pagination,
    };
  } finally {
    input.signal.removeEventListener("abort", stop);
    client.close();
  }
}
