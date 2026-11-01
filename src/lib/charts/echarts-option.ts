/**
 * One ECharts option for the type, variation and columns the user picked.
 *
 * The option is plain data. The component hands it to ECharts, so this module does not
 * import the library and a test can read every series without a canvas.
 */

import { applyChartTitle } from "@/lib/charts/chart-title";
import { chartTheme, type ChartTheme } from "@/lib/charts/palette";
import { echartType, type SlotSelection } from "@/lib/charts/echarts-catalog";

export const CHART_CATEGORY_CAP = 500;
export const HEATMAP_AXIS_CAP = 40;
export const GRAPH_NODE_CAP = 200;

/** The map name Geo plots onto. A world rectangle, so longitude and latitude have a frame. */
export const WORLD_MAP_NAME = "midst-world";

export const WORLD_OUTLINE = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { name: "World" },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [-180, -90],
            [180, -90],
            [180, 90],
            [-180, 90],
            [-180, -90],
          ],
        ],
      },
    },
  ],
};

export interface BuiltChart {
  readonly option: Record<string, unknown>;
  readonly notes: readonly string[];
}

export interface ChartBuildInput {
  readonly typeId: string;
  readonly variationId: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly selection: SlotSelection;
  readonly theme?: ChartTheme;
  /** A series colour asked for on this chart. The palette fills any further series. */
  readonly color?: string | null;
  readonly seriesCap?: number;
  readonly categoryCap?: number;
  readonly heatmapCap?: number;
  readonly nodeCap?: number;
  readonly mask?: (column: string, value: unknown) => string;
  /** Words for `title.text` in the chart code. Empty leaves the chart untitled. */
  readonly title?: string;
}

type Row = Record<string, unknown>;

function themeOf(input: ChartBuildInput): ChartTheme {
  const theme = input.theme ?? chartTheme("dark");
  const color = input.color;
  if (color === undefined || color === null || color === "") return theme;
  const lower = color.toLowerCase();
  return { ...theme, series: [color, ...theme.series.filter((item) => item.toLowerCase() !== lower)] };
}

function first(selection: SlotSelection, id: string): string | null {
  return selection[id]?.[0] ?? null;
}

function many(selection: SlotSelection, id: string): readonly string[] {
  return selection[id] ?? [];
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Text for a category tick. Objects become JSON, and a mask replaces the raw value. */
export function chartLabel(value: unknown, column: string, mask?: (column: string, value: unknown) => string): string {
  if (mask !== undefined) return mask(column, value);
  if (value === null || value === undefined) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function groupKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

interface Group {
  readonly label: string;
  readonly rows: Row[];
}

function groupsOf(rows: readonly Row[], column: string, mask?: ChartBuildInput["mask"]): Group[] {
  const groups = new Map<string, { label: string; rows: Row[] }>();
  for (const row of rows) {
    const value = row[column];
    const key = groupKey(value);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { label: chartLabel(value, column, mask), rows: [row] });
    else existing.rows.push(row);
  }
  return [...groups.values()];
}

function sumOf(rows: readonly Row[], column: string): number | null {
  let total = 0;
  let any = false;
  for (const row of rows) {
    const value = finite(row[column]);
    if (value === null) continue;
    total += value;
    any = true;
  }
  return any ? total : null;
}

function capNote(shown: number, omitted: number, noun: string): string | null {
  if (omitted <= 0) return null;
  return `Showing the first ${shown} of ${shown + omitted} ${noun}.`;
}

function frame(theme: ChartTheme, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    backgroundColor: "transparent",
    color: [...theme.series],
    textStyle: { color: theme.ink, fontFamily: "Montserrat, sans-serif", fontSize: 12 },
    tooltip: { trigger: "axis" },
    legend: { type: "scroll", top: 4, textStyle: { color: theme.ink } },
    ...extra,
  };
}

function categoryAxes(categories: readonly string[], theme: ChartTheme, horizontal: boolean): Record<string, unknown> {
  const category = {
    type: "category" as const,
    data: [...categories],
    axisLabel: { color: theme.axis, hideOverlap: true },
    axisLine: { lineStyle: { color: theme.grid } },
  };
  const value = {
    type: "value" as const,
    axisLabel: { color: theme.axis },
    splitLine: { lineStyle: { color: theme.grid } },
  };
  return {
    grid: { left: 16, right: 16, top: 40, bottom: 16, containLabel: true },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
  };
}

/** A mark size for a bubble. A missing or non-numeric size stays a small dot. */
export function pointSize(value: unknown): number {
  const raw = Array.isArray(value) ? value[2] : value;
  const magnitude = typeof raw === "number" && Number.isFinite(raw) ? Math.abs(raw) : 0;
  return Math.max(6, Math.min(48, Math.sqrt(magnitude) * 4));
}

function categorySeries(input: ChartBuildInput, mark: "line" | "bar"): BuiltChart | null {
  const dimension = first(input.selection, "category");
  const metrics = many(input.selection, "values");
  if (dimension === null || metrics.length === 0) return null;
  const theme = themeOf(input);
  const cap = input.seriesCap ?? theme.series.length;
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const grouped = groupsOf(input.rows, dimension, input.mask);
  const shownGroups = grouped.slice(0, categoryCap);
  const shownMetrics = metrics.slice(0, cap);
  const categories = shownGroups.map((group) => group.label);
  const variation = input.variationId;
  const horizontal = mark === "bar" && (variation === "horizontal" || variation === "stacked-horizontal");
  const series = shownMetrics.map((metric) => {
    const data = shownGroups.map((group) => sumOf(group.rows, metric));
    if (mark === "line") {
      return {
        name: metric,
        type: "line" as const,
        data,
        ...(variation === "smooth" ? { smooth: true } : {}),
        ...(variation === "step" ? { step: "end" as const } : {}),
        ...(variation === "area" || variation === "stacked-area" ? { areaStyle: {} } : {}),
        ...(variation === "stacked" || variation === "stacked-area" ? { stack: "total" } : {}),
      };
    }
    return {
      name: metric,
      type: "bar" as const,
      data,
      ...(variation === "stacked" || variation === "stacked-horizontal" ? { stack: "total" } : {}),
    };
  });
  const notes = [
    capNote(shownGroups.length, grouped.length - shownGroups.length, "categories"),
    capNote(shownMetrics.length, metrics.length - shownMetrics.length, "metrics"),
  ].filter((note): note is string => note !== null);
  return { option: frame(theme, { ...categoryAxes(categories, theme, horizontal), series }), notes };
}

function scatter(input: ChartBuildInput): BuiltChart | null {
  const x = first(input.selection, "x");
  const y = first(input.selection, "y");
  if (x === null || y === null) return null;
  const theme = themeOf(input);
  const cap = input.seriesCap ?? theme.series.length;
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const seriesColumn = first(input.selection, "series");
  const sizeColumn = input.variationId === "bubble" ? first(input.selection, "size") : null;
  const bubble = sizeColumn !== null;
  const buckets = new Map<string, { name: string; data: number[][] }>();
  for (const row of input.rows) {
    const px = finite(row[x]);
    const py = finite(row[y]);
    if (px === null || py === null) continue;
    const size = sizeColumn === null ? null : finite(row[sizeColumn]);
    if (bubble && size === null) continue;
    const name = seriesColumn === null ? "Points" : chartLabel(row[seriesColumn], seriesColumn, input.mask);
    const point = size === null ? [px, py] : [px, py, size];
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, { name, data: [point] });
    else bucket.data.push(point);
  }
  const all = [...buckets.values()];
  const shown: { name: string; type: "scatter"; data: number[][]; symbolSize?: (value: unknown) => number }[] = [];
  let dropped = 0;
  for (const series of all) {
    if (shown.length === cap) {
      dropped += series.data.length;
      continue;
    }
    const data = series.data.slice(0, categoryCap);
    dropped += series.data.length - data.length;
    shown.push({
      name: series.name,
      type: "scatter",
      data,
      ...(bubble ? { symbolSize: pointSize } : {}),
    });
  }
  if (shown.every((series) => series.data.length === 0)) return null;
  const notes = [capNote(shown.length, all.length - shown.length, "series")].filter(
    (note): note is string => note !== null,
  );
  if (dropped > 0) notes.push(`Showing the first ${categoryCap} points in a series. ${dropped} points are not drawn.`);
  return {
    option: frame(theme, {
      xAxis: {
        type: "value",
        name: x,
        axisLabel: { color: theme.axis },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      yAxis: {
        type: "value",
        name: y,
        axisLabel: { color: theme.axis },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      series: shown,
    }),
    notes,
  };
}

function geo(input: ChartBuildInput): BuiltChart | null {
  const longitude = first(input.selection, "longitude");
  const latitude = first(input.selection, "latitude");
  if (longitude === null || latitude === null) return null;
  const valueColumn = first(input.selection, "value");
  const bubble = input.variationId === "bubbles";
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const plotted: { name: string; value: number[] }[] = [];
  for (const row of input.rows) {
    const lon = finite(row[longitude]);
    const lat = finite(row[latitude]);
    if (lon === null || lat === null) continue;
    const value = valueColumn === null ? null : finite(row[valueColumn]);
    if (bubble && value === null) continue;
    plotted.push({
      name: value === null ? "" : String(value),
      value: value === null ? [lon, lat] : [lon, lat, value],
    });
  }
  const data = plotted.slice(0, categoryCap);
  if (data.length === 0) return null;
  const omitted = plotted.length - data.length;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      geo: {
        map: WORLD_MAP_NAME,
        roam: true,
        itemStyle: { areaColor: theme.grid, borderColor: theme.axis },
      },
      series: [
        {
          type: "scatter",
          coordinateSystem: "geo",
          data,
          ...(bubble ? { symbolSize: pointSize } : {}),
        },
      ],
    }),
    notes: omitted > 0 ? [`Showing the first ${data.length} of ${plotted.length} points.`] : [],
  };
}

function movingAverage(closes: readonly number[]): number[] {
  return closes.map((_, index) => {
    const window = closes.slice(Math.max(0, index - 2), index + 1);
    return window.reduce((total, value) => total + value, 0) / window.length;
  });
}

function candlestick(input: ChartBuildInput): BuiltChart | null {
  const time = first(input.selection, "time");
  const open = first(input.selection, "open");
  const close = first(input.selection, "close");
  const low = first(input.selection, "low");
  const high = first(input.selection, "high");
  if (time === null || open === null || close === null || low === null || high === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const groupedAll = groupsOf(input.rows, time, input.mask);
  const grouped = groupedAll.slice(0, categoryCap);
  const categories: string[] = [];
  const data: number[][] = [];
  for (const group of grouped) {
    let firstOpen: number | null = null;
    let lastClose: number | null = null;
    let minLow: number | null = null;
    let maxHigh: number | null = null;
    for (const row of group.rows) {
      const opened = finite(row[open]);
      const closed = finite(row[close]);
      const lowValue = finite(row[low]);
      const highValue = finite(row[high]);
      if (opened !== null && firstOpen === null) firstOpen = opened;
      if (closed !== null) lastClose = closed;
      if (lowValue !== null) minLow = minLow === null ? lowValue : Math.min(minLow, lowValue);
      if (highValue !== null) maxHigh = maxHigh === null ? highValue : Math.max(maxHigh, highValue);
    }
    if (firstOpen === null || lastClose === null || minLow === null || maxHigh === null) continue;
    categories.push(group.label);
    data.push([firstOpen, lastClose, minLow, maxHigh]);
  }
  if (data.length === 0) return null;
  const series: Record<string, unknown>[] = [{ type: "candlestick", data }];
  if (input.variationId === "average") {
    series.push({
      name: "Average",
      type: "line",
      data: movingAverage(data.map((candle) => candle[1] ?? 0)),
      smooth: true,
    });
  }
  const omitted = groupedAll.length - grouped.length;
  return {
    option: frame(theme, { ...categoryAxes(categories, theme, false), series }),
    notes: omitted > 0 ? [`Showing the first ${grouped.length} of ${groupedAll.length} categories.`] : [],
  };
}

function radar(input: ChartBuildInput): BuiltChart | null {
  const metrics = many(input.selection, "axes");
  if (metrics.length === 0) return null;
  const theme = themeOf(input);
  const cap = input.seriesCap ?? theme.series.length;
  const seriesColumn = first(input.selection, "series");
  const grouped =
    seriesColumn === null ? [{ label: "All", rows: [...input.rows] }] : groupsOf(input.rows, seriesColumn, input.mask);
  const shown = grouped.slice(0, cap);
  const totals = shown.map((group) => metrics.map((metric) => sumOf(group.rows, metric) ?? 0));
  const indicator = metrics.map((metric, index) => {
    const peak = Math.max(...totals.map((row) => row[index] ?? 0), 0);
    return { name: metric, max: peak === 0 ? 1 : peak };
  });
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      radar: { indicator, axisName: { color: theme.axis } },
      series: [
        {
          type: "radar",
          ...(input.variationId === "filled" ? { areaStyle: {} } : {}),
          data: shown.map((group, index) => ({ name: group.label, value: totals[index] })),
        },
      ],
    }),
    notes: [capNote(shown.length, grouped.length - shown.length, "series")].filter(
      (note): note is string => note !== null,
    ),
  };
}

function quartile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const low = sorted[lo] ?? 0;
  const high = sorted[hi] ?? low;
  if (lo === hi) return low;
  return low * (hi - pos) + high * (pos - lo);
}

function boxplot(input: ChartBuildInput): BuiltChart | null {
  const groupColumn = first(input.selection, "group");
  const valueColumn = first(input.selection, "values");
  if (groupColumn === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const grouped = groupsOf(input.rows, groupColumn, input.mask);
  const categories: string[] = [];
  const data: number[][] = [];
  let truncated = false;
  for (const group of grouped) {
    if (categories.length === categoryCap) {
      truncated = true;
      break;
    }
    const values = group.rows.map((row) => finite(row[valueColumn])).filter((value): value is number => value !== null);
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    categories.push(group.label);
    data.push([
      quartile(values, 0),
      quartile(values, 0.25),
      quartile(values, 0.5),
      quartile(values, 0.75),
      quartile(values, 1),
    ]);
  }
  if (data.length === 0) return null;
  const horizontal = input.variationId === "horizontal";
  return {
    option: frame(theme, {
      ...categoryAxes(categories, theme, horizontal),
      series: [{ type: "boxplot", data }],
    }),
    notes: truncated ? [`Showing the first ${data.length} of ${grouped.length} categories.`] : [],
  };
}

function heatmap(input: ChartBuildInput): BuiltChart | null {
  const xColumn = first(input.selection, "x");
  const yColumn = first(input.selection, "y");
  const valueColumn = first(input.selection, "value");
  if (xColumn === null || yColumn === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const cap = input.heatmapCap ?? HEATMAP_AXIS_CAP;
  const xLabels: string[] = [];
  const yLabels: string[] = [];
  const xIndex = new Map<string, number>();
  const yIndex = new Map<string, number>();
  const cells = new Map<string, number>();
  let omitted = 0;
  for (const row of input.rows) {
    const xKey = groupKey(row[xColumn]);
    const yKey = groupKey(row[yColumn]);
    if (!xIndex.has(xKey)) {
      if (xLabels.length === cap) {
        omitted += 1;
        continue;
      }
      xIndex.set(xKey, xLabels.length);
      xLabels.push(chartLabel(row[xColumn], xColumn, input.mask));
    }
    if (!yIndex.has(yKey)) {
      if (yLabels.length === cap) {
        omitted += 1;
        continue;
      }
      yIndex.set(yKey, yLabels.length);
      yLabels.push(chartLabel(row[yColumn], yColumn, input.mask));
    }
    const value = finite(row[valueColumn]);
    if (value === null) continue;
    const xi = xIndex.get(xKey);
    const yi = yIndex.get(yKey);
    if (xi === undefined || yi === undefined) continue;
    const key = `${xi}:${yi}`;
    cells.set(key, (cells.get(key) ?? 0) + value);
  }
  const data = [...cells.entries()].map(([key, value]) => {
    const [x, y] = key.split(":");
    return [Number(x), Number(y), value];
  });
  if (data.length === 0) return null;
  const flat = data.map((cell) => cell[2] ?? 0);
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      grid: { left: 16, right: 16, top: 16, bottom: 16, containLabel: true },
      xAxis: { type: "category", data: xLabels, axisLabel: { color: theme.axis } },
      yAxis: { type: "category", data: yLabels, axisLabel: { color: theme.axis } },
      visualMap: {
        min: Math.min(...flat),
        max: Math.max(...flat),
        calculable: false,
        inRange: { color: [theme.grid, theme.series[0] ?? theme.ink] },
        textStyle: { color: theme.ink },
      },
      series: [
        {
          type: "heatmap",
          data,
          ...(input.variationId === "labeled" ? { label: { show: true, color: theme.ink } } : {}),
        },
      ],
    }),
    notes: omitted > 0 ? [`Showing the first ${cap} values on each axis. ${omitted} rows are outside that grid.`] : [],
  };
}

function graph(input: ChartBuildInput): BuiltChart | null {
  const source = first(input.selection, "source");
  const target = first(input.selection, "target");
  if (source === null || target === null) return null;
  const weight = first(input.selection, "weight");
  const theme = themeOf(input);
  const cap = input.nodeCap ?? GRAPH_NODE_CAP;
  const names: string[] = [];
  const seen = new Set<string>();
  const links: { source: string; target: string; value?: number }[] = [];
  let omitted = 0;
  const remember = (label: string): boolean => {
    if (seen.has(label)) return true;
    if (names.length === cap) return false;
    seen.add(label);
    names.push(label);
    return true;
  };
  for (const row of input.rows) {
    const from = chartLabel(row[source], source, input.mask);
    const to = chartLabel(row[target], target, input.mask);
    if (from === to) continue;
    if (!remember(from) || !remember(to)) {
      omitted += 1;
      continue;
    }
    const value = weight === null ? null : finite(row[weight]);
    links.push(value === null ? { source: from, target: to } : { source: from, target: to, value });
  }
  if (links.length === 0) return null;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "graph",
          layout: input.variationId === "circular" ? "circular" : "force",
          roam: true,
          label: { show: true, color: theme.ink },
          data: names.map((name) => ({ name })),
          links,
        },
      ],
    }),
    notes: omitted > 0 ? [`Showing the first ${names.length} nodes. ${omitted} links are not drawn.`] : [],
  };
}

function treemap(input: ChartBuildInput): BuiltChart | null {
  const nameColumn = first(input.selection, "name");
  const sizeColumn = first(input.selection, "size");
  if (nameColumn === null || sizeColumn === null) return null;
  const parentColumn = first(input.selection, "parent");
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const leaves = new Map<string, { name: string; parent: string | null; value: number }>();
  for (const row of input.rows) {
    const amount = finite(row[sizeColumn]);
    if (amount === null || amount <= 0) continue;
    const name = chartLabel(row[nameColumn], nameColumn, input.mask);
    const parent = parentColumn === null ? null : chartLabel(row[parentColumn], parentColumn, input.mask);
    const key = `${parent ?? ""}\0${name}`;
    const existing = leaves.get(key);
    if (existing === undefined) leaves.set(key, { name, parent, value: amount });
    else existing.value += amount;
  }
  const all = [...leaves.values()];
  const shown = all.slice(0, categoryCap);
  if (shown.length === 0) return null;
  const data =
    parentColumn === null
      ? shown.map((leaf) => ({ name: leaf.name, value: leaf.value }))
      : [...new Set(shown.map((leaf) => leaf.parent ?? "(null)"))].map((parent) => ({
          name: parent,
          children: shown
            .filter((leaf) => (leaf.parent ?? "(null)") === parent)
            .map((leaf) => ({ name: leaf.name, value: leaf.value })),
        }));
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "treemap",
          data,
          label: input.variationId === "values" ? { color: theme.ink, formatter: "{b}\n{c}" } : { color: theme.ink },
        },
      ],
    }),
    notes: [capNote(shown.length, all.length - shown.length, "categories")].filter(
      (note): note is string => note !== null,
    ),
  };
}

function sankey(input: ChartBuildInput): BuiltChart | null {
  const source = first(input.selection, "source");
  const target = first(input.selection, "target");
  const valueColumn = first(input.selection, "value");
  if (source === null || target === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const cap = input.nodeCap ?? GRAPH_NODE_CAP;
  const nodes: string[] = [];
  const seen = new Set<string>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  let omitted = 0;
  const remember = (label: string): boolean => {
    if (seen.has(label)) return true;
    if (nodes.length === cap) return false;
    seen.add(label);
    nodes.push(label);
    return true;
  };
  for (const row of input.rows) {
    const from = chartLabel(row[source], source, input.mask);
    const to = chartLabel(row[target], target, input.mask);
    const value = finite(row[valueColumn]);
    if (from === to || value === null || value <= 0) continue;
    if (!remember(from) || !remember(to)) {
      omitted += 1;
      continue;
    }
    const key = `${from}\0${to}`;
    const existing = links.get(key);
    if (existing === undefined) links.set(key, { source: from, target: to, value });
    else existing.value += value;
  }
  if (links.size === 0) return null;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "sankey",
          orient: input.variationId === "vertical" ? "vertical" : "horizontal",
          data: nodes.map((name) => ({ name })),
          links: [...links.values()],
          label: { color: theme.ink },
        },
      ],
    }),
    notes: omitted > 0 ? [`Showing the first ${nodes.length} nodes. ${omitted} links are not drawn.`] : [],
  };
}

function funnel(input: ChartBuildInput): BuiltChart | null {
  const stage = first(input.selection, "stage");
  const valueColumn = first(input.selection, "value");
  if (stage === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const data = groupsOf(input.rows, stage, input.mask)
    .map((group) => ({ name: group.label, value: sumOf(group.rows, valueColumn) }))
    .filter((item): item is { name: string; value: number } => item.value !== null && item.value > 0)
    .sort((a, b) => (input.variationId === "pyramid" ? a.value - b.value : b.value - a.value));
  const shown = data.slice(0, categoryCap);
  if (shown.length === 0) return null;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "funnel",
          sort: input.variationId === "pyramid" ? "ascending" : "descending",
          data: shown,
          label: { color: theme.ink },
        },
      ],
    }),
    notes: [capNote(shown.length, data.length - shown.length, "categories")].filter(
      (note): note is string => note !== null,
    ),
  };
}

function gauge(input: ChartBuildInput): BuiltChart | null {
  const valueColumn = first(input.selection, "value");
  if (valueColumn === null) return null;
  const total = sumOf(input.rows, valueColumn);
  if (total === null) return null;
  const theme = themeOf(input);
  const variation = input.variationId;
  const band = (index: number) => theme.series[index] ?? theme.ink;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "gauge",
          data: [{ name: valueColumn, value: total }],
          detail: { color: theme.ink },
          title: { color: theme.axis },
          ...(variation === "progress" ? { progress: { show: true }, pointer: { show: false } } : {}),
          ...(variation === "grade"
            ? {
                axisLine: {
                  lineStyle: {
                    color: [
                      [0.3, band(0)],
                      [0.7, band(1)],
                      [1, band(2)],
                    ],
                  },
                },
              }
            : {}),
        },
      ],
    }),
    notes: [],
  };
}

const BUILDERS: Record<string, (input: ChartBuildInput) => BuiltChart | null> = {
  line: (input) => categorySeries(input, "line"),
  bar: (input) => categorySeries(input, "bar"),
  scatter,
  geo,
  candlestick,
  radar,
  boxplot,
  heatmap,
  graph,
  treemap,
  sankey,
  funnel,
  gauge,
};

/** The option for one chosen variation, or null when the columns cannot draw it. */
export function buildChartOption(input: ChartBuildInput): BuiltChart | null {
  const type = echartType(input.typeId);
  if (type === null || type.variations.every((item) => item.id !== input.variationId)) return null;
  const built = BUILDERS[type.id]?.(input) ?? null;
  if (built === null) return null;
  return { option: applyChartTitle(built.option, input.title ?? ""), notes: built.notes };
}

/** Disconnects a resize observer, or does nothing where the browser has none. */
export function watchChartSize(element: Element, onResize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => onResize());
  observer.observe(element);
  return () => observer.disconnect();
}
