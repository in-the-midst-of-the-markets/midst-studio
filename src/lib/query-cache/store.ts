import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openDuckDBClient, type DuckDBClient } from "@/lib/db/providers/sql/duckdb/client";
import { bindValue, columnType } from "@/lib/query-cache/columns";
import { cacheTableNameError, type CacheWrite } from "@/lib/query-cache/body";
import type { CacheEntry } from "@/lib/query-cache/entry";
import { QueryCacheError, tooManyRowsMessage, QUERY_CACHE_MAX_ROWS } from "@/lib/query-cache/limits";
import { queryCacheFile } from "@/lib/query-cache/path";

export interface CacheWriteResult {
  tableName: string;
  rowCount: number;
  /** True when this name already held rows and those rows were replaced. */
  replaced: boolean;
}

/** The one statement shape the cache store runs. DuckDB's client is one. */
export interface CacheRunner {
  run(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const REGISTRY = "libredb.query_cache";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function asCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readEntry(row: Record<string, unknown>): CacheEntry {
  return {
    tableName: asText(row.table_name),
    sourceName: asText(row.source_name),
    sourceSql: asText(row.source_sql),
    sourceConnectionId: asText(row.source_connection_id),
    rowCount: asCount(row.row_count),
    cachedAt: asText(row.cached_at),
  };
}

async function registryExists(runner: CacheRunner): Promise<boolean> {
  const found = await runner.run(
    "SELECT 1 FROM duckdb_tables() WHERE schema_name = 'libredb' AND table_name = 'query_cache'",
  );
  return found.rows.length > 0;
}

/**
 * Replace `input.tableName` with these rows, and record where they came from.
 *
 * `CREATE OR REPLACE` is the refresh. A second cache of the same name drops the
 * previous rows and writes the new ones, then updates the registry in place.
 */
export async function cacheQueryResult(runner: CacheRunner, input: CacheWrite): Promise<CacheWriteResult> {
  const nameProblem = cacheTableNameError(input.tableName);
  if (nameProblem !== null) throw new QueryCacheError(nameProblem);
  if (input.fields.length === 0) throw new QueryCacheError("This result has no columns to cache.");
  if (input.rows.length > QUERY_CACHE_MAX_ROWS) throw new QueryCacheError(tooManyRowsMessage());

  const types = input.fields.map((field) => columnType(input.rows.map((row) => row[field])));
  await runner.run("CREATE SCHEMA IF NOT EXISTS libredb");
  await runner.run(
    `CREATE TABLE IF NOT EXISTS ${REGISTRY} (
      table_name VARCHAR PRIMARY KEY,
      source_name VARCHAR,
      source_sql VARCHAR,
      source_connection_id VARCHAR,
      row_count BIGINT,
      cached_at TIMESTAMP
    )`,
  );
  const existing = await runner.run("SELECT 1 FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = ?", [
    input.tableName,
  ]);
  const columns = input.fields.map((field, index) => `${quoteIdent(field)} ${types[index]}`).join(", ");
  const table = `${quoteIdent("main")}.${quoteIdent(input.tableName)}`;
  await runner.run(`CREATE OR REPLACE TABLE ${table} (${columns})`);
  if (input.rows.length > 0) {
    const placeholders = types.map(() => "?").join(", ");
    const insert = `INSERT INTO ${table} VALUES (${placeholders})`;
    for (const row of input.rows) {
      const values = input.fields.map((field, index) => bindValue(row[field], types[index] ?? "VARCHAR"));
      // oxlint-disable-next-line no-await-in-loop -- one connection inserts one row at a time.
      await runner.run(insert, values);
    }
  }
  await runner.run(
    `INSERT INTO ${REGISTRY} VALUES (?, ?, ?, ?, ?, now())
     ON CONFLICT (table_name) DO UPDATE SET
       source_name = excluded.source_name,
       source_sql = excluded.source_sql,
       source_connection_id = excluded.source_connection_id,
       row_count = excluded.row_count,
       cached_at = excluded.cached_at`,
    [input.tableName, input.sourceName, input.sourceSql, input.sourceConnectionId, input.rows.length],
  );
  return { tableName: input.tableName, rowCount: input.rows.length, replaced: existing.rows.length > 0 };
}

/** The tables this cache file records, in name order. An empty file has none. */
export async function listCachedQueries(runner: CacheRunner): Promise<CacheEntry[]> {
  if (!(await registryExists(runner))) return [];
  const listed = await runner.run(
    `SELECT table_name, source_name, source_sql, source_connection_id, row_count, cached_at
     FROM ${REGISTRY} ORDER BY table_name`,
  );
  return listed.rows.map(readEntry);
}

/** Open this user's cache file, run `body`, and close the file either way. */
export async function withQueryCache<T>(username: string, body: (runner: DuckDBClient) => Promise<T>): Promise<T> {
  const file = queryCacheFile(username);
  await mkdir(path.dirname(file), { recursive: true });
  const client = await openDuckDBClient(file, { readOnly: false, denyExternalAccess: true });
  try {
    return await body(client);
  } finally {
    client.close();
  }
}
