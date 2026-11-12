/**
 * A click on a chart point, stored so another query can filter on it.
 *
 * The chart name "Test" and the dimension column "Dim" publish `Test-Dim`.
 * The same click also stores `Test-` plus the metric column. The chart's
 * `publish` choice is the id a query writes as `{{Test-Dim}}`. A query that
 * contains that id runs again with the clicked value. `dashboardId` opens
 * that dashboard, which is the drilldown.
 */

import { writeQueryFilter } from "@/lib/charts/query-filters";
import type { ChartClickConfig } from "@/lib/types";

const CLICK_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
const VALUE_CAP = 200;

const DIMENSION_SLOTS = ["category", "name", "source", "x"];
const METRIC_SLOTS = ["values", "value", "y", "size"];

export interface ChartClickSource {
  readonly name: string;
  /** Absent on a chart saved before axes were stored. */
  readonly xAxis?: string;
  readonly yAxis?: readonly string[];
  readonly selection?: Readonly<Record<string, readonly string[]>>;
  readonly click?: ChartClickConfig;
}

export interface ChartClickFields {
  readonly dimension: string;
  readonly metric: string;
}

export interface ChartClickIds {
  readonly dimension: string | null;
  readonly metric: string | null;
}

export interface ChartClickPoint {
  readonly name: string;
  readonly value: unknown;
}

/** The id a query writes, or null when the name and column cannot form one. */
export function clickFilterId(chartName: string, field: string): string | null {
  const left = clickPart(chartName);
  const right = clickPart(field);
  if (left === "" || right === "") return null;
  const id = `${left}-${right}`;
  return CLICK_ID.test(id) ? id : null;
}

function clickPart(text: string): string {
  return text.trim().replace(/[^A-Za-z0-9_]/g, "");
}

function slotValue(
  selection: Readonly<Record<string, readonly string[]>> | undefined,
  slots: readonly string[],
): string {
  if (selection === undefined) return "";
  for (const slot of slots) {
    const chosen = selection[slot]?.find((item) => item.trim() !== "");
    if (chosen !== undefined) return chosen.trim();
  }
  return "";
}

/** The dimension and metric columns a click reads. A stored choice wins over the shelves. */
export function chartClickFields(chart: ChartClickSource): ChartClickFields {
  const dimension =
    chart.click?.dimension?.trim() || slotValue(chart.selection, DIMENSION_SLOTS) || (chart.xAxis ?? "").trim();
  const metric =
    chart.click?.metric?.trim() ||
    slotValue(chart.selection, METRIC_SLOTS) ||
    (chart.yAxis ?? []).find((item) => item.trim() !== "")?.trim() ||
    "";
  return { dimension, metric };
}

/** Both ids this chart can publish. */
export function chartClickIds(chartName: string, fields: ChartClickFields): ChartClickIds {
  return {
    dimension: clickFilterId(chartName, fields.dimension),
    metric: clickFilterId(chartName, fields.metric),
  };
}

/** A point ECharts reported, or null when the click was not on a series. */
export function chartClickPoint(params: unknown): ChartClickPoint | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as { componentType?: unknown; name?: unknown; value?: unknown; data?: unknown };
  if (record.componentType !== undefined && record.componentType !== "series") return null;
  const name = typeof record.name === "string" ? record.name : "";
  const value = record.value !== undefined ? record.value : record.data;
  return { name, value };
}

/** Text a filter can store. Objects and blank text contribute nothing. */
export function chartClickText(value: unknown): string {
  if (typeof value === "string")
    return value
      .replace(/[|}\r\n]/g, "")
      .trim()
      .slice(0, VALUE_CAP);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function unwrapped(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** The dimension text and the metric text from one clicked point. */
export function chartClickValues(point: ChartClickPoint): { dimension: string; metric: string } {
  const value = unwrapped(point.value);
  const named = chartClickText(point.name);
  if (Array.isArray(value)) {
    const dimension = named !== "" ? named : chartClickText(value[0]);
    let metric = "";
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const text = chartClickText(value[index]);
      if (text !== "") {
        metric = text;
        break;
      }
    }
    return { dimension, metric };
  }
  return { dimension: named, metric: chartClickText(value) };
}

/**
 * Stores whichever side has an id and a value.
 * Returns the same map when the click had nothing to record.
 */
export function mergeClickValues(
  current: Readonly<Record<string, string>>,
  ids: ChartClickIds,
  values: { readonly dimension: string; readonly metric: string },
): Record<string, string> {
  let changed = false;
  const next = { ...current };
  if (ids.dimension !== null && values.dimension !== "") {
    next[ids.dimension] = values.dimension;
    changed = true;
  }
  if (ids.metric !== null && values.metric !== "") {
    next[ids.metric] = values.metric;
    changed = true;
  }
  return changed ? next : current;
}

/** The ids the charts currently publish, with the values a click stored. */
export function publishedClickFilters(
  charts: readonly ChartClickSource[],
  values: Readonly<Record<string, string>>,
): { name: string; value: string }[] {
  const filters: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const chart of charts) {
    const ids = chartClickIds(chart.name, chartClickFields(chart));
    const id = chart.click?.publish === "metric" ? ids.metric : ids.dimension;
    if (id === null || seen.has(id)) continue;
    const value = values[id];
    if (value === undefined || value.trim() === "") continue;
    seen.add(id);
    filters.push({ name: id, value });
  }
  return filters;
}

/** Writes each published click into the placeholders of the same id. */
export function applyChartClicks(sql: string, filters: readonly { name: string; value: string }[]): string {
  return filters.reduce((current, filter) => writeQueryFilter(current, filter.name, filter.value), sql);
}

/** The next stored click setup. An empty setup is dropped. */
export function nextChartClick(
  current: ChartClickConfig | undefined,
  patch: Partial<ChartClickConfig>,
): ChartClickConfig | undefined {
  const merged: ChartClickConfig = { ...current, ...patch };
  const next: ChartClickConfig = {};
  const dimension = merged.dimension?.trim() ?? "";
  const metric = merged.metric?.trim() ?? "";
  const dashboardId = merged.dashboardId?.trim() ?? "";
  if (dimension !== "") next.dimension = dimension;
  if (metric !== "") next.metric = metric;
  if (merged.publish === "metric") next.publish = "metric";
  if (dashboardId !== "") next.dashboardId = dashboardId;
  if (
    next.dimension === undefined &&
    next.metric === undefined &&
    next.publish === undefined &&
    next.dashboardId === undefined
  ) {
    return undefined;
  }
  return next;
}

/** The dashboard a click opens, or null when the click stays here. */
export function drilldownDashboard(
  currentId: string,
  targetId: string | undefined,
  known: readonly string[],
): string | null {
  const target = targetId?.trim() ?? "";
  if (target === "" || target === currentId || !known.includes(target)) return null;
  return target;
}

/** Columns the click controls can offer, with the current choice kept even before a result arrives. */
export function clickColumnChoices(fields: readonly string[], dimension: string, metric: string): string[] {
  const columns: string[] = [];
  for (const name of [...fields, dimension, metric]) {
    const trimmed = name.trim();
    if (trimmed === "" || columns.includes(trimmed)) continue;
    columns.push(trimmed);
  }
  return columns;
}
