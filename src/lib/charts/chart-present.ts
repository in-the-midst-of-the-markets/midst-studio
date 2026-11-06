/**
 * The option a dashboard draws from chart code.
 *
 * A title in that code is drawn on the plot. An empty title stays off it, and the
 * legend and grid keep the room the untitled chart uses.
 * `prefix` and `suffix` on an axis label or the tooltip wrap each value, so a
 * currency mark or a percent sign can sit at the start or the end. A `formatter`
 * the code already sets is left as written.
 */

import { chartTitleText, omitDrawnChartTitle } from "@/lib/charts/chart-title";

const AFFIX_CAP = 32;
const TITLE_LEGEND_TOP = 28;
const TITLE_GRID_TOP = 64;
const AXIS_KEYS = ["xAxis", "yAxis", "radiusAxis", "angleAxis", "singleAxis"] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function affixText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > AFFIX_CAP ? value.slice(0, AFFIX_CAP) : value;
}

function affixOf(record: Record<string, unknown>): { prefix: string; suffix: string } | null {
  const prefix = affixText(record.prefix);
  const suffix = affixText(record.suffix);
  if (prefix === "" && suffix === "") return null;
  return { prefix, suffix };
}

function valueText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length === 0 ? "" : valueText(value[value.length - 1]);
  const nested = recordOf(value);
  if (nested !== null && "value" in nested) return valueText(nested.value);
  return "";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function axisFormatter(prefix: string, suffix: string): (value: unknown) => string {
  return (value: unknown) => `${prefix}${valueText(value)}${suffix}`;
}

function tooltipFormatter(prefix: string, suffix: string): (params: unknown) => string {
  return (params: unknown) => {
    const rows = Array.isArray(params) ? params : [params];
    const lines: string[] = [];
    for (const row of rows) {
      const item = recordOf(row);
      if (item === null) continue;
      const label = [item.seriesName, item.name, item.axisValueLabel].find((part) => typeof part === "string") ?? "";
      const shown = `${prefix}${valueText(item.value)}${suffix}`;
      const marker = typeof item.marker === "string" ? item.marker : "";
      const text = label === "" ? shown : `${label}: ${shown}`;
      lines.push(`${marker}${escapeHtml(text)}`);
    }
    return lines.join("<br/>");
  };
}

function withTitleRoom(option: Record<string, unknown>, untitled: Record<string, unknown>): Record<string, unknown> {
  if (chartTitleText(option) === "") return omitDrawnChartTitle(option, untitled);
  let next = option;
  if (typeof option.title === "string") {
    next = { ...option, title: { text: option.title, left: "center", top: 0 } };
  }
  const untitledLegend = recordOf(untitled.legend);
  const legend = recordOf(next.legend);
  if (untitledLegend !== null && legend !== null && legend.top === untitledLegend.top) {
    next = { ...next, legend: { ...legend, top: TITLE_LEGEND_TOP } };
  }
  const untitledGrid = recordOf(untitled.grid);
  const grid = recordOf(next.grid);
  if (untitledGrid !== null && grid !== null && grid.top === untitledGrid.top) {
    const top = typeof untitledGrid.top === "number" ? Math.max(untitledGrid.top, TITLE_GRID_TOP) : TITLE_GRID_TOP;
    next = { ...next, grid: { ...grid, top } };
  }
  return next;
}

function withAxisAffix(axis: unknown): unknown {
  if (Array.isArray(axis)) return axis.map(withAxisAffix);
  const record = recordOf(axis);
  if (record === null) return axis;
  const label = recordOf(record.axisLabel);
  if (label === null || label.formatter !== undefined) return axis;
  const affix = affixOf(label);
  if (affix === null) return axis;
  return { ...record, axisLabel: { ...label, formatter: axisFormatter(affix.prefix, affix.suffix) } };
}

function withTooltipAffix(tooltip: unknown): unknown {
  if (Array.isArray(tooltip)) return tooltip.map(withTooltipAffix);
  const record = recordOf(tooltip);
  if (record === null || record.formatter !== undefined) return tooltip;
  const affix = affixOf(record);
  if (affix === null) return tooltip;
  return { ...record, formatter: tooltipFormatter(affix.prefix, affix.suffix) };
}

/** The option the dashboard canvas draws. */
export function presentChartOption(
  option: Record<string, unknown>,
  untitled: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...withTitleRoom(option, untitled) };
  for (const key of AXIS_KEYS) {
    if (!(key in next)) continue;
    const painted = withAxisAffix(next[key]);
    if (painted !== next[key]) next[key] = painted;
  }
  if ("tooltip" in next) {
    const painted = withTooltipAffix(next.tooltip);
    if (painted !== next.tooltip) next.tooltip = painted;
  }
  return next;
}
