import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readAssistDate } from "@/lib/ai/assist-schedule";
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

function asRefresh(value: unknown): number | undefined {
  if (typeof value === "boolean" || value == null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
  return numeric;
}

function asMinute(value: unknown): number | undefined {
  if (typeof value === "boolean" || value == null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= 24 * 60) return undefined;
  return numeric;
}

function asStarts(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return readAssistDate(value) ?? undefined;
}

function asPaused(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  return undefined;
}

function readEntry(row: Record<string, unknown>): CacheEntry {
  const refreshSeconds = asRefresh(row.refresh_seconds);
  const refreshMinute = asMinute(row.refresh_minute);
  const refreshStartsOn = asStarts(row.refresh_starts_on);
  const refreshPaused = asPaused(row.refresh_paused);
  return {
    tableName: asText(row.table_name),
    sourceName: asText(row.source_name),
    sourceSql: asText(row.source_sql),
    sourceConnectionId: asText(row.source_connection_id),
    rowCount: asCount(row.row_count),
    cachedAt: asText(row.cached_at),
    ...(refreshSeconds === undefined ? {} : { refreshSeconds }),
    ...(refreshMinute === undefined ? {} : { refreshMinute }),
    ...(refreshStartsOn === undefined ? {} : { refreshStartsOn }),
    ...(refreshPaused === undefined ? {} : { refreshPaused }),
  };
}

async function registryExists(runner: CacheRunner): Promise<boolean> {
  const found = await runner.run(
    "SELECT 1 FROM duckdb_tables() WHERE schema_name = 'libredb' AND table_name = 'query_cache'",
  );
  return found.rows.length > 0;
}

/** A cache file written before the calendar existed is missing one of these columns. */
async function ensureRefreshColumn(runner: CacheRunner): Promise<void> {
  await runner.run(`ALTER TABLE ${REGISTRY} ADD COLUMN IF NOT EXISTS refresh_seconds BIGINT`);
  await runner.run(`ALTER TABLE ${REGISTRY} ADD COLUMN IF NOT EXISTS refresh_minute BIGINT`);
  await runner.run(`ALTER TABLE ${REGISTRY} ADD COLUMN IF NOT EXISTS refresh_starts_on VARCHAR`);
  await runner.run(`ALTER TABLE ${REGISTRY} ADD COLUMN IF NOT EXISTS refresh_paused BOOLEAN`);
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
      cached_at TIMESTAMP,
      refresh_seconds BIGINT,
      refresh_minute BIGINT,
      refresh_starts_on VARCHAR,
      refresh_paused BOOLEAN
    )`,
  );
  await ensureRefreshColumn(runner);
  // Omitted means keep the schedule already stored. Null clears it.
  const keepRefresh = input.refreshSeconds === undefined ? 1 : 0;
  const refreshSeconds = input.refreshSeconds ?? null;
  const refreshMinute = input.refreshMinute ?? null;
  const refreshStartsOn = input.refreshStartsOn ?? null;
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
    `INSERT INTO ${REGISTRY} (
       table_name, source_name, source_sql, source_connection_id, row_count, cached_at,
       refresh_seconds, refresh_minute, refresh_starts_on, refresh_paused
     ) VALUES (?, ?, ?, ?, ?, now(), ?, ?, ?, ?)
     ON CONFLICT (table_name) DO UPDATE SET
       source_name = excluded.source_name,
       source_sql = excluded.source_sql,
       source_connection_id = excluded.source_connection_id,
       row_count = excluded.row_count,
       cached_at = excluded.cached_at,
       refresh_seconds = CASE WHEN ? = 1 THEN ${REGISTRY}.refresh_seconds ELSE excluded.refresh_seconds END,
       refresh_minute = CASE WHEN ? = 1 THEN ${REGISTRY}.refresh_minute ELSE excluded.refresh_minute END,
       refresh_starts_on = CASE WHEN ? = 1 THEN ${REGISTRY}.refresh_starts_on ELSE excluded.refresh_starts_on END,
       refresh_paused = CASE WHEN ? = 1 THEN ${REGISTRY}.refresh_paused ELSE excluded.refresh_paused END`,
    [
      input.tableName,
      input.sourceName,
      input.sourceSql,
      input.sourceConnectionId,
      input.rows.length,
      refreshSeconds,
      refreshMinute,
      refreshStartsOn,
      false,
      keepRefresh,
      keepRefresh,
      keepRefresh,
      keepRefresh,
    ],
  );
  return { tableName: input.tableName, rowCount: input.rows.length, replaced: existing.rows.length > 0 };
}

/** The tables this cache file records, in name order. An empty file has none. */
export async function listCachedQueries(runner: CacheRunner): Promise<CacheEntry[]> {
  if (!(await registryExists(runner))) return [];
  await ensureRefreshColumn(runner);
  const listed = await runner.run(
    `SELECT table_name, source_name, source_sql, source_connection_id, row_count,
            CAST(cached_at AS VARCHAR) AS cached_at, refresh_seconds, refresh_minute, refresh_starts_on,
            refresh_paused
     FROM ${REGISTRY} ORDER BY table_name`,
  );
  return listed.rows.map(readEntry);
}

/**
 * Set or clear how often `tableName` reruns its source.
 *
 * Returns false when the cache has no such table. The rows are left as they are.
 */
export async function setCacheRefresh(
  runner: CacheRunner,
  tableName: string,
  refreshSeconds: number | null,
  refreshMinute: number | null = null,
  refreshStartsOn: string | null = null,
): Promise<boolean> {
  const problem = cacheTableNameError(tableName);
  if (problem !== null) throw new QueryCacheError(problem);
  if (!(await registryExists(runner))) return false;
  await ensureRefreshColumn(runner);
  const updated = await runner.run(
    `UPDATE ${REGISTRY}
     SET refresh_seconds = ?, refresh_minute = ?, refresh_starts_on = ?, refresh_paused = false
     WHERE table_name = ? RETURNING table_name`,
    [refreshSeconds, refreshMinute, refreshStartsOn, tableName],
  );
  return updated.rows.length > 0;
}

/**
 * Pause or resume one saved run.
 *
 * The calendar stays as it is. Returns false when the cache has no such table.
 */
export async function setCachePaused(runner: CacheRunner, tableName: string, paused: boolean): Promise<boolean> {
  const problem = cacheTableNameError(tableName);
  if (problem !== null) throw new QueryCacheError(problem);
  if (!(await registryExists(runner))) return false;
  await ensureRefreshColumn(runner);
  const updated = await runner.run(
    `UPDATE ${REGISTRY} SET refresh_paused = ? WHERE table_name = ? RETURNING table_name`,
    [paused, tableName],
  );
  return updated.rows.length > 0;
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
