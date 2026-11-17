"use client";

import { useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import { isCrossDbJoins } from "@/lib/saved-join/connection";
import { cacheTableNameError } from "@/lib/query-cache/body";
import { isQueryCache } from "@/lib/query-cache/connection";
import type { CacheEntry } from "@/lib/query-cache/entry";
import { QUERY_CACHE_MAX_ROWS, tooManyRowsMessage } from "@/lib/query-cache/limits";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

export interface CacheResultsProps {
  result: QueryResult;
  /** The statement that produced `result`, stored so a refresh can run it again. */
  sql: string;
  source: DatabaseConnection | null;
  /** Connections a refresh may run the source query on. */
  connections?: readonly DatabaseConnection[];
}

interface Listed {
  tables: CacheEntry[];
}

const NO_CONNECTIONS: readonly DatabaseConnection[] = [];

function errorText(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback;
}

/**
 * Cache the rows on screen into the user's DuckDB query cache.
 *
 * Caching a name that already exists replaces that table. Refresh runs the stored
 * source query and replaces the table with whatever comes back, so a later read of
 * the cache does not spend the source again until the user asks it to.
 */
export function CacheResults({ result, sql, source, connections = NO_CONNECTIONS }: CacheResultsProps) {
  const [open, setOpen] = useState(false);
  const [tableName, setTableName] = useState("");
  const [tables, setTables] = useState<CacheEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (source === null || result.rows.length === 0) return null;

  const existing = tables.find((entry) => entry.tableName === tableName);
  const partial = result.pagination?.hasMore === true;

  const loadTables = async (): Promise<CacheEntry[]> => {
    const response = await appFetch("/api/db/query-cache");
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(errorText(body, "The query cache could not be read."));
    const listed = body as Listed;
    return Array.isArray(listed.tables) ? listed.tables : [];
  };

  const openPanel = (): void => {
    setOpen((value) => !value);
    setMessage(null);
    if (open) return;
    void loadTables()
      .then(setTables)
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "The query cache could not be read.");
      });
  };

  const store = async (write: {
    tableName: string;
    rows: Record<string, unknown>[];
    fields: string[];
    sourceName: string;
    sourceSql: string;
    sourceConnectionId: string;
  }): Promise<void> => {
    const response = await appFetch("/api/db/query-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(errorText(body, "The rows could not be cached."));
    const replaced = typeof body === "object" && body !== null && "replaced" in body && body.replaced === true;
    setMessage(
      replaced
        ? `Replaced ${write.tableName} with ${write.rows.length} rows.`
        : `Cached ${write.rows.length} rows as ${write.tableName}.`,
    );
    setTables(await loadTables());
  };

  const cacheCurrent = async (): Promise<void> => {
    const problem = cacheTableNameError(tableName);
    if (problem !== null) {
      setMessage(problem);
      return;
    }
    if (result.rows.length > QUERY_CACHE_MAX_ROWS) {
      setMessage(tooManyRowsMessage());
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await store({
        tableName,
        rows: result.rows,
        fields: result.fields,
        sourceName: source.name,
        sourceSql: sql,
        sourceConnectionId: source.id,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The rows could not be cached.");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (entry: CacheEntry): Promise<void> => {
    const found = connections.find((connection) => connection.id === entry.sourceConnectionId);
    if (found === undefined) {
      setMessage(
        `${entry.sourceName} is not open here. Run the query there, then replace ${entry.tableName} with the new rows.`,
      );
      return;
    }
    if (isCrossDbJoins(found)) {
      setMessage(`Run the join again, then replace ${entry.tableName} with the new rows.`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await appFetch("/api/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection: found,
          sql: entry.sourceSql,
          options: { limit: QUERY_CACHE_MAX_ROWS },
        }),
      });
      const body = (await response.json().catch(() => null)) as QueryResult | { error?: string } | null;
      if (!response.ok || body === null || !("rows" in body)) {
        throw new Error(errorText(body, "The source query failed."));
      }
      if (body.pagination?.hasMore === true || body.rows.length > QUERY_CACHE_MAX_ROWS) {
        setMessage(tooManyRowsMessage());
        return;
      }
      await store({
        tableName: entry.tableName,
        rows: body.rows,
        fields: body.fields,
        sourceName: entry.sourceName,
        sourceSql: entry.sourceSql,
        sourceConnectionId: entry.sourceConnectionId,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The source query failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-hairline bg-surface px-3 py-1.5 text-xs">
      <button
        type="button"
        className="font-medium text-brand hover:text-brand-bright"
        aria-expanded={open}
        onClick={openPanel}
      >
        {open ? "Hide cache" : "Cache results"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-fg-muted">
            {isQueryCache(source)
              ? "These rows are already in Query cache. Caching them again writes another table."
              : "Save these rows in Query cache. A later read uses the DuckDB table instead of the source."}
            {partial ? " Only the rows loaded so far are cached." : ""}
          </p>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void cacheCurrent();
            }}
          >
            <label className="text-fg-muted" htmlFor="query-cache-table">
              Table
            </label>
            <input
              id="query-cache-table"
              value={tableName}
              onChange={(event) => setTableName(event.target.value)}
              className="h-7 rounded border border-hairline bg-control px-2 text-fg"
              placeholder="orders"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={busy}
              className="h-7 rounded bg-brand-solid px-2 font-medium text-white disabled:opacity-60"
            >
              {existing ? "Replace cached table" : "Cache"}
            </button>
          </form>
          {existing && <p className="text-fg-muted">Replace overwrites the rows in {existing.tableName}.</p>}
          {tables.length > 0 && (
            <ul className="space-y-1">
              {tables.map((entry) => (
                <li key={entry.tableName} className="flex flex-wrap items-center gap-2 text-fg-muted">
                  <button
                    type="button"
                    className="font-mono text-fg hover:text-brand"
                    onClick={() => setTableName(entry.tableName)}
                  >
                    {entry.tableName}
                  </button>
                  <span>
                    {entry.rowCount} rows from {entry.sourceName}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded border border-hairline px-1.5 py-0.5 text-fg hover:bg-fill disabled:opacity-60"
                    onClick={() => void refresh(entry)}
                  >
                    Refresh
                  </button>
                </li>
              ))}
            </ul>
          )}
          {message !== null && <output className="block text-fg">{message}</output>}
        </div>
      )}
    </div>
  );
}
