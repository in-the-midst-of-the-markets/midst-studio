"use client";

import { useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import { MIN_CHART_REFRESH_SECONDS } from "@/lib/charts/chart-refresh";
import { cacheTableNameError } from "@/lib/query-cache/body";
import { isQueryCache } from "@/lib/query-cache/connection";
import type { CacheEntry } from "@/lib/query-cache/entry";
import { QUERY_CACHE_MAX_ROWS, tooManyRowsMessage } from "@/lib/query-cache/limits";
import { cacheErrorText, rerunCacheEntry } from "@/lib/query-cache/run-refresh";
import { readCacheIntervalText } from "@/lib/query-cache/schedule";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

export interface CacheResultsProps {
  result: QueryResult;
  /** The statement that produced `result`, stored so a refresh can run it again. */
  sql: string;
  source: DatabaseConnection | null;
  /** Connections a refresh may run the source query on. */
  connections?: readonly DatabaseConnection[];
  /** Called after a table is written, so the open Query cache tree can reload. */
  onCached?: () => void;
}

interface Listed {
  tables: CacheEntry[];
}

const NO_CONNECTIONS: readonly DatabaseConnection[] = [];

const RAISED = `Raised to ${MIN_CHART_REFRESH_SECONDS} seconds, the shortest refresh.`;

/**
 * Cache the rows on screen into the user's DuckDB query cache.
 *
 * Caching a name that already exists replaces that table. Refresh runs the stored
 * source query and replaces the table with whatever comes back, so a later read of
 * the cache does not spend the source again until the user asks it to.
 */
export function CacheResults({ result, sql, source, connections = NO_CONNECTIONS, onCached }: CacheResultsProps) {
  const [open, setOpen] = useState(false);
  const [tableName, setTableName] = useState("");
  const [refreshText, setRefreshText] = useState("");
  const [tables, setTables] = useState<CacheEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (source === null || result.rows.length === 0) return null;

  const existing = tables.find((entry) => entry.tableName === tableName);
  const partial = result.pagination?.hasMore === true;

  const loadTables = async (): Promise<CacheEntry[]> => {
    const response = await appFetch("/api/db/query-cache");
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(cacheErrorText(body, "The query cache could not be read."));
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

  const remember = async (): Promise<void> => {
    setTables(await loadTables());
    onCached?.();
  };

  const store = async (write: {
    tableName: string;
    rows: Record<string, unknown>[];
    fields: string[];
    sourceName: string;
    sourceSql: string;
    sourceConnectionId: string;
    refreshSeconds?: number | null;
  }): Promise<void> => {
    const response = await appFetch("/api/db/query-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(cacheErrorText(body, "The rows could not be cached."));
    const replaced = typeof body === "object" && body !== null && "replaced" in body && body.replaced === true;
    setMessage(
      replaced
        ? `Replaced ${write.tableName} with ${write.rows.length} rows.`
        : `Cached ${write.rows.length} rows as ${write.tableName}.`,
    );
    await remember();
  };

  const intervalOrStop = (): number | null | undefined => {
    const interval = readCacheIntervalText(refreshText);
    if (!interval.ok) {
      setMessage(interval.error);
      return undefined;
    }
    if (interval.raised) {
      setRefreshText(String(interval.seconds));
      setMessage(RAISED);
      return undefined;
    }
    return interval.seconds;
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
    const refreshSeconds = intervalOrStop();
    if (refreshSeconds === undefined) return;
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
        refreshSeconds,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The rows could not be cached.");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (entry: CacheEntry): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await rerunCacheEntry(entry, connections, appFetch);
      if (!outcome.ok) {
        setMessage(outcome.message);
        return;
      }
      setMessage(
        outcome.replaced
          ? `Replaced ${entry.tableName} with ${outcome.rowCount} rows.`
          : `Cached ${outcome.rowCount} rows as ${entry.tableName}.`,
      );
      await remember();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The source query failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async (): Promise<void> => {
    const problem = cacheTableNameError(tableName);
    if (problem !== null) {
      setMessage(problem);
      return;
    }
    const refreshSeconds = intervalOrStop();
    if (refreshSeconds === undefined) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await appFetch("/api/db/query-cache/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableName, refreshSeconds }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw new Error(cacheErrorText(body, "The refresh interval could not be saved."));
      setMessage(
        refreshSeconds === null
          ? `${tableName} refreshes only when you ask.`
          : `${tableName} refreshes every ${refreshSeconds} seconds while KnowSQL is open.`,
      );
      setTables(await loadTables());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The refresh interval could not be saved.");
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
            <label className="text-fg-muted" htmlFor="query-cache-refresh">
              Refresh seconds
            </label>
            <input
              id="query-cache-refresh"
              value={refreshText}
              inputMode="numeric"
              onChange={(event) => setRefreshText(event.target.value)}
              className="h-7 w-24 rounded border border-hairline bg-control px-2 text-fg"
              placeholder="off"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={busy}
              className="h-7 rounded bg-brand-solid px-2 font-medium text-white disabled:opacity-60"
            >
              {existing ? "Replace cached table" : "Cache"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="h-7 rounded border border-hairline px-2 text-fg hover:bg-fill disabled:opacity-60"
              onClick={() => void saveSchedule()}
            >
              Set interval
            </button>
          </form>
          <p className="text-fg-muted">
            A number of seconds reruns the source while KnowSQL is open and replaces the table. Blank refreshes only
            when you ask.
          </p>
          {existing && <p className="text-fg-muted">Replace overwrites the rows in {existing.tableName}.</p>}
          {tables.length > 0 && (
            <ul className="space-y-1">
              {tables.map((entry) => (
                <li key={entry.tableName} className="flex flex-wrap items-center gap-2 text-fg-muted">
                  <button
                    type="button"
                    className="font-mono text-fg hover:text-brand"
                    onClick={() => {
                      setTableName(entry.tableName);
                      setRefreshText(entry.refreshSeconds === undefined ? "" : String(entry.refreshSeconds));
                    }}
                  >
                    {entry.tableName}
                  </button>
                  <span>
                    {entry.rowCount} rows from {entry.sourceName}
                    {entry.refreshSeconds === undefined ? "" : ` · every ${entry.refreshSeconds}s`}
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
