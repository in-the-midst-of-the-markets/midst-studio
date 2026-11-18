import { isCrossDbJoins } from "@/lib/saved-join/connection";
import { isQueryCache } from "@/lib/query-cache/connection";
import type { CacheEntry } from "@/lib/query-cache/entry";
import { QUERY_CACHE_MAX_ROWS, tooManyRowsMessage } from "@/lib/query-cache/limits";
import { cacheIsDue } from "@/lib/query-cache/schedule";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

/** The fetch the editor already uses. A test passes its own. */
export type CacheFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type CacheRerun =
  | { ok: true; replaced: boolean; rowCount: number; tableName: string }
  | { ok: false; message: string };

export function cacheErrorText(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback;
}

/**
 * Run one cached table's source and replace the table with what comes back.
 *
 * The schedule is left as it is: the write omits `refreshSeconds`, and the store
 * keeps the interval already on the row. A missing source, a join, and a result
 * past the cap are messages, and the table stays as it was.
 */
export async function rerunCacheEntry(
  entry: CacheEntry,
  connections: readonly DatabaseConnection[],
  fetchImpl: CacheFetch,
): Promise<CacheRerun> {
  const found = connections.find((connection) => connection.id === entry.sourceConnectionId);
  if (found === undefined) {
    return {
      ok: false,
      message: `${entry.sourceName} is not open here. Run the query there, then replace ${entry.tableName} with the new rows.`,
    };
  }
  if (isCrossDbJoins(found)) {
    return { ok: false, message: `Run the join again, then replace ${entry.tableName} with the new rows.` };
  }
  const response = await fetchImpl("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connection: found,
      sql: entry.sourceSql,
      options: { limit: QUERY_CACHE_MAX_ROWS },
    }),
  });
  const body = (await response.json().catch(() => null)) as QueryResult | { error?: string } | null;
  if (!response.ok || body === null || !("rows" in body) || !Array.isArray(body.rows)) {
    return { ok: false, message: cacheErrorText(body, "The source query failed.") };
  }
  if (body.pagination?.hasMore === true || body.rows.length > QUERY_CACHE_MAX_ROWS) {
    return { ok: false, message: tooManyRowsMessage() };
  }
  if (!Array.isArray(body.fields)) {
    return { ok: false, message: "The source query failed." };
  }
  const stored = await fetchImpl("/api/db/query-cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tableName: entry.tableName,
      rows: body.rows,
      fields: body.fields,
      sourceName: entry.sourceName,
      sourceSql: entry.sourceSql,
      sourceConnectionId: entry.sourceConnectionId,
    }),
  });
  const storedBody = (await stored.json().catch(() => null)) as unknown;
  if (!stored.ok) return { ok: false, message: cacheErrorText(storedBody, "The rows could not be cached.") };
  const replaced =
    typeof storedBody === "object" && storedBody !== null && "replaced" in storedBody && storedBody.replaced === true;
  return { ok: true, replaced, rowCount: body.rows.length, tableName: entry.tableName };
}

/**
 * Replace every cached table whose interval has elapsed.
 *
 * A source that is the query cache itself is skipped: refreshing it would read
 * the cache and write it back. A source that fails is skipped too, and the next
 * table still runs. Returns whether any table was replaced.
 */
export async function refreshDueCaches(
  connections: readonly DatabaseConnection[],
  fetchImpl: CacheFetch,
  now = Date.now(),
): Promise<boolean> {
  const response = await fetchImpl("/api/db/query-cache");
  const body = (await response.json().catch(() => null)) as { tables?: unknown } | null;
  if (!response.ok || body === null || typeof body !== "object") {
    throw new Error(cacheErrorText(body, "The query cache could not be read."));
  }
  const tables = Array.isArray(body.tables) ? (body.tables as CacheEntry[]) : [];
  let changed = false;
  for (const entry of tables) {
    if (!cacheIsDue(entry, now)) continue;
    if (isQueryCache({ id: entry.sourceConnectionId })) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one DuckDB file, so one refresh at a time.
      const outcome = await rerunCacheEntry(entry, connections, fetchImpl);
      if (outcome.ok) changed = true;
    } catch {
      // This source did not answer. The next table, and the next tick, still run.
    }
  }
  return changed;
}
