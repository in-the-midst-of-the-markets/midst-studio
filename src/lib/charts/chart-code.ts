/**
 * The chart option as text the user can edit.
 *
 * The text is how the chart looks: title, series style, colors, filter controls.
 * The query owns the values (`data`, `links`, and a radar `indicator`), so they are
 * left out of the text and filled in again whenever the chart is drawn.
 * A scatter point size is a function. The text omits functions. Until the text parses
 * as a JSON object, the canvas keeps the generated option, functions included.
 */

import type { SlotSelection } from "@/lib/charts/echarts-catalog";

/** Keys whose contents come from the query, not from the chart code. */
const QUERY_VALUE_KEYS = new Set(["data", "links", "indicator"]);

/**
 * A missing one of these is the chart's values with nowhere to sit, so the query's
 * copy is used. Deleting the legend or the grid stays deleted.
 */
const QUERY_VALUE_CONTAINERS = new Set([
  "series",
  "xAxis",
  "yAxis",
  "angleAxis",
  "radiusAxis",
  "radar",
  "dataset",
  "singleAxis",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
}

export interface ChartCode {
  readonly ok: true;
  readonly option: Record<string, unknown>;
}

export interface ChartCodeError {
  readonly ok: false;
  readonly error: string;
}

/** Pretty JSON for an option. A value that cannot be serialized becomes empty text. */
export function formatChartCode(option: Record<string, unknown>): string {
  try {
    return JSON.stringify(option, null, 2);
  } catch {
    return "";
  }
}

/** A JSON object is chart code. Anything else is a message to show above the text. */
export function parseChartCode(text: string): ChartCode | ChartCodeError {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Chart code is not valid JSON." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Chart code must be a JSON object." };
  }
  return { ok: true, option: value as Record<string, unknown> };
}

function stripNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNode);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (QUERY_VALUE_KEYS.has(key)) continue;
    next[key] = stripNode(item);
  }
  return next;
}

/** The option with the query's values removed, so the chart code is only the look. */
export function stripChartValues(option: Record<string, unknown>): Record<string, unknown> {
  return stripNode(option) as Record<string, unknown>;
}

function applyNode(edited: unknown, generated: unknown): unknown {
  if (Array.isArray(generated)) {
    if (!Array.isArray(edited)) return copyValue(generated);
    const next = generated.map((item, index) =>
      index >= edited.length ? copyValue(item) : applyNode(edited[index], item),
    );
    if (edited.length > generated.length) next.push(...edited.slice(generated.length));
    return next;
  }
  if (isRecord(generated) && isRecord(edited)) {
    const next: Record<string, unknown> = { ...edited };
    for (const [key, value] of Object.entries(generated)) {
      if (QUERY_VALUE_KEYS.has(key)) {
        next[key] = copyValue(value);
        continue;
      }
      if (!(key in edited)) {
        if (QUERY_VALUE_CONTAINERS.has(key)) next[key] = copyValue(value);
        continue;
      }
      next[key] = applyNode(edited[key], value);
    }
    return next;
  }
  return edited;
}

/**
 * The user's chart with the query's values filled in.
 * A series, axis, or radar they left out is copied from the query. The legend they
 * deleted stays deleted. Numbers they typed into `data` are replaced by the query.
 */
export function applyChartValues(
  edited: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  return applyNode(edited, generated) as Record<string, unknown>;
}

/**
 * Identity of the shelves that produced the generated option.
 * A new type, variation, or column selection starts again from that option.
 * The same shelves keep the user's text when only the rows change.
 */
export function chartSourceKey(
  typeId: string | null,
  variationId: string | null,
  selection: SlotSelection | null,
): string {
  return JSON.stringify([typeId, variationId, selection]);
}
