import { embedTokens } from "@/lib/embeddings/placeholder";
import { addQueryFilter, applyQueryFilters, readQueryFilters, removeQueryFilter } from "@/lib/charts/query-filters";
import type { FilterCompare } from "@/lib/charts/query-filters";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { ensureChartToken } from "@/lib/dashboards/public-id";
import { queryWithDashboardFilters } from "@/lib/dashboards/dashboard";
import { CROSS_DB_JOINS_ID } from "@/lib/saved-join/connection";
import { sourceReadRefusal } from "@/lib/saved-join/source-guard";
import type {
  DashboardFilter,
  DashboardNote,
  DatabaseConnection,
  DatabaseType,
  SavedChartConfig,
  SavedDashboard,
} from "@/lib/types";
import { SHARE_MAX_TABLES } from "./share-limits";

/**
 * The snapshot a shared dashboard is built from.
 *
 * Each chart, filter and note query runs once on its own connection. A filter written
 * as a column comparison is left open, so the shared page can apply it to the copied
 * rows. A vector value, or a placeholder that is not that comparison, is filled with
 * the current selection and the shared chart keeps that result.
 */

export interface ShareInteractiveFilter {
  readonly name: string;
  readonly compare: FilterCompare;
  readonly value: string;
}

export interface ShareSourcePlan {
  readonly table: string;
  readonly connectionId: string;
  readonly label: string;
  /** The chart name a frozen filter is reported under. Absent for a filter or a note. */
  readonly chartName?: string;
  /** The source statement with open comparisons removed. */
  readonly openedSql: string;
  /** The source statement with every current selection filled in. */
  readonly bakedSql: string;
  readonly interactive: readonly ShareInteractiveFilter[];
}

export interface ShareFrozen {
  readonly chart: string;
  readonly reason: string;
}

export interface SharePlan {
  readonly dashboard: SavedDashboard;
  readonly charts: readonly SavedChartConfig[];
  readonly sources: readonly ShareSourcePlan[];
  readonly frozen: readonly ShareFrozen[];
}

const FILTER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function bake(sql: string, filters: readonly Pick<DashboardFilter, "name" | "value">[]): string {
  return applyQueryFilters(queryWithDashboardFilters(sql, filters));
}

function vectorFrozen(label: string): ShareFrozen {
  return { chart: label, reason: "This query uses a vector, so the shared copy keeps the current result." };
}

function comparisonFrozen(label: string, name: string): ShareFrozen {
  return {
    chart: label,
    reason: `The filter {{${name}}} is not a column comparison, so the shared copy keeps the current result.`,
  };
}

/**
 * Open every dashboard filter that is a single column comparison. The rest stay
 * in the statement and are filled with the current selection.
 */
function openFilters(
  sql: string,
  filters: readonly DashboardFilter[],
  label: string,
): { openedSql: string; bakedSql: string; interactive: ShareInteractiveFilter[]; frozen: ShareFrozen[] } {
  const bakedSql = bake(sql, filters);
  if (embedTokens(sql).length > 0) {
    return { openedSql: bakedSql, bakedSql, interactive: [], frozen: [vectorFrozen(label)] };
  }
  let current = sql;
  const interactive: ShareInteractiveFilter[] = [];
  const frozen: ShareFrozen[] = [];
  for (const filter of filters) {
    const name = filter.name.trim();
    if (!FILTER_NAME.test(name)) continue;
    const described = readQueryFilters(current).find((item) => item.name === name);
    if (described === undefined) continue;
    const removed = removeQueryFilter(current, name);
    if (removed === current) {
      frozen.push(comparisonFrozen(label, name));
      continue;
    }
    const value = filter.value.trim() || described.value;
    interactive.push({ name, compare: described.compare, value });
    current = removed;
  }
  return { openedSql: bake(current, filters), bakedSql, interactive, frozen };
}

function tableFromId(prefix: string, id: string): string | null {
  const body = id.replace(/[^A-Za-z0-9_]/g, "");
  if (body === "") return null;
  const name = `${prefix}${body}`.slice(0, 63);
  return TABLE_NAME.test(name) ? name : null;
}

interface ResolvedQuery {
  readonly connectionId: string;
  readonly type: DatabaseType;
}

function resolveQuery(
  connectionId: string | undefined,
  connections: readonly Pick<DatabaseConnection, "id" | "type">[],
  label: string,
): ResolvedQuery | string {
  if (connectionId === undefined || connectionId === "") return `${label} has no connection.`;
  if (connectionId === CROSS_DB_JOINS_ID) {
    return `${label} reads Cross_DB_Joins. Share it from a saved database connection.`;
  }
  const connection = connections.find((item) => item.id === connectionId);
  if (connection === undefined) return `${label} uses a connection that is no longer available.`;
  return { connectionId, type: connection.type };
}

function refusal(type: DatabaseType, sql: string, label: string): string | null {
  const reason = sourceReadRefusal(type, sql);
  if (reason === null) return null;
  return `${label}: ${reason}`;
}

/** The statement the shared page runs against one snapshot table. */
export function snapshotQuery(table: string, interactive: readonly ShareInteractiveFilter[]): string {
  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  for (const filter of interactive) {
    sql = addQueryFilter(sql, filter.name, filter.value, [], filter.compare, filter.name);
  }
  return sql;
}

/**
 * Which of the opened filters the copied columns can still answer.
 * A filter whose column is not in the result is dropped and the baked rows are used,
 * so the snapshot shows the selection the owner had rather than every row.
 */
export function sourceForFields(
  source: ShareSourcePlan,
  fields: readonly string[],
): { sql: string; interactive: readonly ShareInteractiveFilter[] } {
  const interactive = source.interactive.filter((filter) => fields.includes(filter.name));
  if (interactive.length !== source.interactive.length) {
    return { sql: source.bakedSql, interactive: [] };
  }
  return { sql: source.openedSql, interactive };
}

function publicFilter(filter: DashboardFilter, query: string | undefined): DashboardFilter {
  const next: DashboardFilter = { ...filter, query: query ?? "" };
  delete next.script;
  delete next.connectionId;
  if (next.control === "custom" || next.control === "vector") next.control = "search";
  return next;
}

function publicNote(note: DashboardNote, query: string | undefined): DashboardNote {
  const next: DashboardNote = { id: note.id, text: note.text };
  if (note.width !== undefined) next.width = note.width;
  if (note.height !== undefined) next.height = note.height;
  if (note.style !== undefined) next.style = note.style;
  if (query !== undefined) next.query = query;
  return next;
}

function publicChart(chart: SavedChartConfig, query: string | undefined): SavedChartConfig {
  const next: SavedChartConfig = { ...chart, query };
  delete next.connectionId;
  delete next.refreshSeconds;
  return next;
}

/**
 * The shared board and the queries that fill it.
 * `charts` are the saved charts the board places. A chart that is not on the board is ignored.
 */
export function planDashboardShare(
  dashboard: SavedDashboard,
  charts: readonly SavedChartConfig[],
  connections: readonly Pick<DatabaseConnection, "id" | "type">[],
): SharePlan | string {
  const filters = dashboard.filters ?? [];
  const sources: ShareSourcePlan[] = [];
  const frozen: ShareFrozen[] = [];
  const publicCharts: SavedChartConfig[] = [];
  const seen = new Set<string>();

  for (const frame of dashboard.charts) {
    if (typeof frame?.chartId !== "string") return "The dashboard is not valid.";
    const saved = charts.find((item) => item.id === frame.chartId);
    if (saved === undefined) return "A chart on this dashboard is no longer saved.";
    const chart = ensureChartToken(saved);
    const query = chart.query?.trim() ?? "";
    if (query === "") {
      publicCharts.push(publicChart(chart, chart.query));
      continue;
    }
    const resolved = resolveQuery(chart.connectionId, connections, `Chart "${chart.name}"`);
    if (typeof resolved === "string") return resolved;
    const opened = openFilters(query, filters, chart.name);
    const refused = refusal(resolved.type, opened.bakedSql, `Chart "${chart.name}"`);
    if (refused !== null) return refused;
    if (!TABLE_NAME.test(chart.token ?? "")) return `Chart "${chart.name}" has no id the snapshot can store.`;
    if (seen.has(chart.token ?? "")) return `Two charts on this dashboard use the id "${chart.token}".`;
    seen.add(chart.token ?? "");
    sources.push({
      table: chart.token ?? "",
      connectionId: resolved.connectionId,
      label: `Chart "${chart.name}"`,
      chartName: chart.name,
      openedSql: opened.openedSql,
      bakedSql: opened.bakedSql,
      interactive: opened.interactive,
    });
    frozen.push(...opened.frozen);
    publicCharts.push(publicChart(chart, undefined));
  }

  const publicFilters: DashboardFilter[] = [];
  for (const filter of filters) {
    if (filter.control === "vector") {
      frozen.push(vectorFrozen(filter.label?.trim() || filter.name));
      continue;
    }
    const query = filter.choiceSource === "values" ? "" : filter.query.trim();
    if (query === "") {
      publicFilters.push(publicFilter(filter, undefined));
      continue;
    }
    const label = `Filter "${filter.label?.trim() || filter.name}"`;
    const resolved = resolveQuery(filter.connectionId, connections, label);
    if (typeof resolved === "string") return resolved;
    const bakedSql = bake(query, filters);
    const refused = refusal(resolved.type, bakedSql, label);
    if (refused !== null) return refused;
    const table = tableFromId("f_", filter.id);
    if (table === null || seen.has(table)) return `${label} has no id the snapshot can store.`;
    seen.add(table);
    sources.push({
      table,
      connectionId: resolved.connectionId,
      label,
      openedSql: bakedSql,
      bakedSql,
      interactive: [],
    });
    publicFilters.push(publicFilter(filter, snapshotQuery(table, [])));
  }

  const publicNotes: DashboardNote[] = [];
  for (const note of dashboard.notes ?? []) {
    const query = note.query?.trim() ?? "";
    if (query === "") {
      publicNotes.push(publicNote(note, undefined));
      continue;
    }
    const label = "A note";
    const resolved = resolveQuery(note.connectionId, connections, label);
    if (typeof resolved === "string") return resolved;
    const bakedSql = bake(query, filters);
    const refused = refusal(resolved.type, bakedSql, label);
    if (refused !== null) return refused;
    const table = tableFromId("n_", note.id);
    if (table === null || seen.has(table)) return "A note has no id the snapshot can store.";
    seen.add(table);
    sources.push({
      table,
      connectionId: resolved.connectionId,
      label,
      openedSql: bakedSql,
      bakedSql,
      interactive: [],
    });
    publicNotes.push(publicNote(note, snapshotQuery(table, [])));
  }

  if (sources.length > SHARE_MAX_TABLES) {
    return `A shared dashboard can copy at most ${SHARE_MAX_TABLES} queries. This one has ${sources.length}.`;
  }

  const shared: SavedDashboard = {
    id: dashboard.id,
    name: dashboard.name,
    charts: dashboard.charts.map((frame) => ({ ...frame })),
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
    ...(publicFilters.length > 0 ? { filters: publicFilters } : {}),
    ...(publicNotes.length > 0 ? { notes: publicNotes } : {}),
  };

  return { dashboard: shared, charts: publicCharts, sources, frozen };
}

/** The shortest refresh on a chart this board places, in seconds. Absent when none of them refresh. */
export function shareRefreshSeconds(
  charts: readonly Pick<SavedChartConfig, "id" | "refreshSeconds">[],
  placed: readonly string[],
): number | undefined {
  let seconds: number | undefined;
  for (const chart of charts) {
    if (!placed.includes(chart.id)) continue;
    const delay = refreshDelayMs(chart.refreshSeconds);
    if (delay === null) continue;
    const next = delay / 1000;
    seconds = seconds === undefined ? next : Math.min(seconds, next);
  }
  return seconds;
}

/** The public chart queries, once each source has reported the columns it copied. */
export function withSnapshotQueries(
  plan: SharePlan,
  columns: ReadonlyMap<string, readonly string[]>,
): {
  charts: SavedChartConfig[];
  sources: { table: string; connectionId: string; sql: string }[];
  frozen: ShareFrozen[];
} {
  const frozen = [...plan.frozen];
  const chosen = new Map<string, { sql: string; interactive: readonly ShareInteractiveFilter[] }>();
  for (const source of plan.sources) {
    const fields = columns.get(source.table) ?? [];
    const picked = sourceForFields(source, fields);
    if (picked.interactive.length !== source.interactive.length) {
      for (const filter of source.interactive) {
        if (!fields.includes(filter.name)) {
          frozen.push({
            chart: source.chartName ?? source.label,
            reason: `The filter {{${filter.name}}} is not a column in the result, so the shared copy keeps the current result.`,
          });
        }
      }
    }
    chosen.set(source.table, picked);
  }
  const charts = plan.charts.map((chart) => {
    const token = chart.token ?? "";
    const pick = chosen.get(token);
    if (pick === undefined) return chart;
    return { ...chart, query: snapshotQuery(token, pick.interactive) };
  });
  const sources = plan.sources.map((source) => {
    const pick = chosen.get(source.table);
    return { table: source.table, connectionId: source.connectionId, sql: pick?.sql ?? source.bakedSql };
  });
  return { charts, sources, frozen };
}
