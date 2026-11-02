/**
 * How a query filter is drawn. The chart code can set it.
 *
 * `filters.<name>.control` is `text`, `select`, `number`, or `slider`.
 * A slider also reads `min`, `max`, and `step`. The query still owns the value.
 */

import { isNumericFilterValue, type QueryFilter } from "@/lib/charts/query-filters";

export type FilterControlKind = "text" | "select" | "number" | "slider";

export interface FilterLook {
  readonly control: FilterControlKind;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
}

const CONTROLS = new Set<FilterControlKind>(["text", "select", "number", "slider"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readLook(value: unknown): FilterLook | null {
  if (!isRecord(value)) return null;
  const control = value.control;
  if (typeof control !== "string" || !CONTROLS.has(control as FilterControlKind)) return null;
  return {
    control: control as FilterControlKind,
    min: finiteOrNull(value.min),
    max: finiteOrNull(value.max),
    step: finiteOrNull(value.step),
  };
}

/** Looks written under `filters` in chart code. Anything else is ignored. */
export function readFilterLooks(option: Record<string, unknown> | null | undefined): ReadonlyMap<string, FilterLook> {
  const looks = new Map<string, FilterLook>();
  const filters = option === null || option === undefined ? null : option.filters;
  if (!isRecord(filters)) return looks;
  for (const [name, value] of Object.entries(filters)) {
    const look = readLook(value);
    if (look !== null) looks.set(name, look);
  }
  return looks;
}

/** The control a filter shows before the chart code says otherwise. */
export function defaultFilterLooks(
  filters: readonly QueryFilter[],
  metrics: readonly string[],
): ReadonlyMap<string, FilterLook> {
  const metricNames = new Set(metrics);
  const looks = new Map<string, FilterLook>();
  for (const filter of filters) {
    const control: FilterControlKind = metricNames.has(filter.name)
      ? "number"
      : filter.options.length > 0
        ? "select"
        : "text";
    looks.set(filter.name, { control, min: null, max: null, step: null });
  }
  return looks;
}

/** The chart code wins for a filter it names. A name that is not a filter is ignored. */
export function mergeFilterLooks(
  defaults: ReadonlyMap<string, FilterLook>,
  edited: ReadonlyMap<string, FilterLook>,
): ReadonlyMap<string, FilterLook> {
  const merged = new Map(defaults);
  for (const [name, look] of edited) {
    if (merged.has(name)) merged.set(name, look);
  }
  return merged;
}

/** The option plus a `filters` block. An empty block leaves the option without that key. */
export function withFilterLooks(
  option: Record<string, unknown>,
  looks: ReadonlyMap<string, FilterLook>,
): Record<string, unknown> {
  if (looks.size === 0) {
    if (!Object.hasOwn(option, "filters")) return option;
    const next = { ...option };
    delete next.filters;
    return next;
  }
  const filters: Record<string, unknown> = {};
  for (const [name, look] of looks) {
    const entry: Record<string, unknown> = { control: look.control };
    if (look.min !== null) entry.min = look.min;
    if (look.max !== null) entry.max = look.max;
    if (look.step !== null) entry.step = look.step;
    filters[name] = entry;
  }
  return { ...option, filters };
}

/** The option ECharts can draw. `filters` is for the chart code, not the canvas. */
export function withoutFilterLooks(option: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(option, "filters")) return option;
  const next = { ...option };
  delete next.filters;
  return next;
}

function fallbackControl(filter: QueryFilter, numeric: boolean): FilterControlKind {
  if (numeric) return "number";
  if (filter.options.length > 0) return "select";
  return "text";
}

/** The control to draw. A slider or a number needs a numeric value; a select needs choices. */
export function shownFilterControl(
  filter: QueryFilter,
  numeric: boolean,
  look: FilterLook | undefined,
): FilterControlKind {
  const asked = look?.control;
  if (asked === "text") return "text";
  if (asked === "select") return filter.options.length > 0 ? "select" : fallbackControl(filter, numeric);
  if (asked === "number")
    return numeric || isNumericFilterValue(filter.value) ? "number" : fallbackControl(filter, numeric);
  if (asked === "slider") return isNumericFilterValue(filter.value) ? "slider" : fallbackControl(filter, numeric);
  return fallbackControl(filter, numeric);
}

/** The min, max, and step a slider can use. The current value always fits on it. */
export function sliderRange(look: FilterLook, value: string): { min: number; max: number; step: number } {
  const parsed = Number(value);
  const current = Number.isFinite(parsed) ? parsed : 0;
  let min = look.min ?? Math.min(0, current);
  let max = look.max ?? Math.max(current, min + 10);
  if (current < min) min = current;
  if (current > max) max = current;
  if (!(max > min)) max = min + 10;
  const step = look.step !== null && look.step > 0 ? look.step : 1;
  return { min, max, step };
}
