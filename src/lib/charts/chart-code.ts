/**
 * The chart option as text the user can edit.
 *
 * The generated option is plain data, except a scatter point size, which is a function.
 * The text omits functions. The canvas keeps the generated option, functions included,
 * until the text parses as a JSON object.
 */

import type { SlotSelection } from "@/lib/charts/echarts-catalog";

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
