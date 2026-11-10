import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openDuckDBClient, type DuckDBClient } from "@/lib/db/providers/sql/duckdb/client";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import {
  SHARE_MAX_RESULT_ROWS,
  SHARE_MEMORY_LIMIT,
  SHARE_THREADS,
  ShareError,
  ShareNotFoundError,
} from "./share-limits";
import { shareDbPath, shareDirectory } from "./share-record";

/**
 * The snapshot file for one shared dashboard.
 *
 * Writes go to a new file and replace the previous one after the handle closes.
 * Reads open that file with external access off, and only a single SELECT that
 * names the snapshot's own tables is run. One chain per id keeps a read and a
 * replace from opening the file together: DuckDB refuses a second opener.
 */

export interface ShareSheet {
  readonly table: string;
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

export interface ShareQueryResult {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

type ColumnType = "BOOLEAN" | "BIGINT" | "DOUBLE" | "VARCHAR";

const tails = new Map<string, Promise<void>>();

function withShareLock<T>(id: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(id) ?? Promise.resolve();
  const run = previous.then(job, job);
  tails.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function valueType(value: unknown): ColumnType | null {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "bigint") return "BIGINT";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return "BIGINT";
    return "DOUBLE";
  }
  if (typeof value === "string") return "VARCHAR";
  return null;
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

function bindValue(value: unknown, type: ColumnType): string | number | bigint | boolean | null {
  if (value === null || value === undefined) return null;
  if (type === "BOOLEAN") return value === true;
  if (type === "BIGINT") return typeof value === "bigint" ? value : Math.trunc(Number(value));
  if (type === "DOUBLE") return Number(value);
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

async function insertSheet(client: DuckDBClient, sheet: ShareSheet): Promise<void> {
  if (sheet.fields.length === 0) {
    throw new ShareError(`"${sheet.table}" returned no columns, so there is nothing to share.`);
  }
  const types = sheet.fields.map((field) => columnType(sheet.rows.map((row) => row[field])));
  const columns = sheet.fields.map((field, index) => `${quoteIdent(field)} ${types[index]}`).join(", ");
  const name = `${quoteIdent("main")}.${quoteIdent(sheet.table)}`;
  await client.run(`CREATE TABLE ${name} (${columns})`);
  if (sheet.rows.length === 0) return;
  const placeholders = sheet.fields.map(() => "?").join(", ");
  const batchSize = 200;
  for (let start = 0; start < sheet.rows.length; start += batchSize) {
    const batch = sheet.rows.slice(start, start + batchSize);
    const values = batch.flatMap((row) =>
      sheet.fields.map((field, index) => bindValue(row[field], types[index] ?? "VARCHAR")),
    );
    const groups = batch.map(() => `(${placeholders})`).join(", ");
    // oxlint-disable-next-line no-await-in-loop -- one connection fills one table, a batch at a time.
    await client.run(`INSERT INTO ${name} VALUES ${groups}`, values);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SERVER_STATE_FUNCTIONS = new Set(["current_setting"]);
const HIDDEN_SQL_FUNCTIONS = new Set(["json_execute_serialized_sql", "query", "query_table"]);
const TABLE_SCHEMAS = new Set(["", "main"]);

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

function collectTables(node: unknown, tables: string[], ctes: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectTables(entry, tables, ctes);
    return;
  }
  if (!isRecord(node)) return;
  if (node.type === "TABLE_FUNCTION" || node.type === "SHOW_REF") {
    throw new ShareError("A shared dashboard can only read its snapshot.");
  }
  if (node.type === "FUNCTION" && typeof node.function_name === "string") {
    const name = node.function_name.toLowerCase();
    if (SERVER_STATE_FUNCTIONS.has(name)) throw new ShareError("A shared dashboard cannot read the server's settings.");
    if (HIDDEN_SQL_FUNCTIONS.has(name))
      throw new ShareError("A shared dashboard cannot run SQL hidden inside a function.");
  }
  if (node.type === "BASE_TABLE") {
    const schema = typeof node.schema_name === "string" ? node.schema_name : "";
    const table = typeof node.table_name === "string" ? node.table_name : "";
    const catalog = typeof node.catalog_name === "string" ? node.catalog_name : "";
    if (catalog !== "" || node.at_clause != null)
      throw new ShareError("A shared dashboard can only read its snapshot.");
    if (!TABLE_SCHEMAS.has(schema.toLowerCase())) {
      throw new ShareError("A shared dashboard can only read its snapshot.");
    }
    if (table === "") throw new ShareError("A shared dashboard can only read its snapshot.");
    if (!(schema === "" && ctes.has(table.toLowerCase()))) tables.push(table);
  }
  for (const value of Object.values(node)) collectTables(value, tables, ctes);
}

async function tablesIn(client: DuckDBClient, sql: string): Promise<string[]> {
  const grammar = resolveSqlGrammar("duckdb");
  if (countCodeStatements(sql, grammar) !== 1) {
    throw new ShareError("A shared dashboard reads one statement.");
  }
  let parsed: { rows: Record<string, unknown>[] };
  try {
    parsed = await client.run("SELECT json_serialize_sql(?::VARCHAR) AS ast", [sql]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The statement could not be read.";
    throw new ShareError(message);
  }
  let ast: unknown;
  try {
    ast = JSON.parse(String(parsed.rows[0]?.ast ?? "null"));
  } catch {
    throw new ShareError("The statement could not be read.");
  }
  if (!isRecord(ast) || ast.error === true) {
    const message =
      isRecord(ast) && typeof ast.error_message === "string" ? ast.error_message : "The statement could not be read.";
    if (message.includes("Only SELECT statements")) throw new ShareError("A shared dashboard reads one SELECT.");
    throw new ShareError(message);
  }
  const statements = Array.isArray(ast.statements) ? ast.statements : [];
  if (statements.length !== 1 || !isRecord(statements[0]) || !isRecord(statements[0].node)) {
    throw new ShareError("A shared dashboard reads one statement.");
  }
  const ctes = new Set<string>();
  collectCteNames(statements[0].node, ctes);
  const tables: string[] = [];
  collectTables(statements[0].node, tables, ctes);
  return tables;
}

async function applyLimits(client: DuckDBClient): Promise<void> {
  await client.run(`SET memory_limit = '${SHARE_MEMORY_LIMIT}'`);
  await client.run(`SET threads = ${SHARE_THREADS}`);
}

async function writeTemp(id: string, sheets: readonly ShareSheet[]): Promise<void> {
  mkdirSync(shareDirectory(), { recursive: true });
  const destination = shareDbPath(id);
  const temp = `${destination}.${randomBytes(4).toString("hex")}.tmp`;
  const client = await openDuckDBClient(temp, { readOnly: false, denyExternalAccess: true });
  try {
    await applyLimits(client);
    for (const sheet of sheets) {
      // oxlint-disable-next-line no-await-in-loop -- one file, one table after the previous.
      await insertSheet(client, sheet);
    }
  } catch (error) {
    client.close();
    rmSync(temp, { force: true });
    throw error;
  }
  client.close();
  rmSync(`${destination}.wal`, { force: true });
  renameSync(temp, destination);
  rmSync(`${temp}.wal`, { force: true });
}

/** Replace the snapshot file with these tables. The previous file stays until the new one is closed. */
export function writeShareTables(id: string, sheets: readonly ShareSheet[]): Promise<void> {
  return withShareLock(id, () => writeTemp(id, sheets));
}

function allowed(table: string, tables: readonly string[]): boolean {
  return tables.some((item) => item.toLowerCase() === table.toLowerCase());
}

/** Run one SELECT against the snapshot. The statement may name only `tables`. */
export function queryShareFile(id: string, sql: string, tables: readonly string[]): Promise<ShareQueryResult> {
  return withShareLock(id, async () => {
    const path = shareDbPath(id);
    if (!existsSync(path)) throw new ShareNotFoundError();
    const client = await openDuckDBClient(path, { readOnly: true, denyExternalAccess: true });
    try {
      await applyLimits(client);
      const named = await tablesIn(client, sql);
      if (named.length === 0) throw new ShareError("A shared dashboard reads its snapshot.");
      for (const table of named) {
        if (!allowed(table, tables)) throw new ShareError("A shared dashboard can only read its snapshot.");
      }
      const result = await client.run(sql);
      if (result.rows.length > SHARE_MAX_RESULT_ROWS) {
        throw new ShareError("That view returned more rows than a shared dashboard will show.");
      }
      return { fields: result.columnNames, rows: result.rows, rowCount: result.rows.length };
    } finally {
      client.close();
    }
  });
}
