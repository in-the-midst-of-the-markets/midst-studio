/**
 * One ECharts option for the type, variation and columns the user picked.
 *
 * The option is plain data. The component hands it to ECharts, so this module does not
 * import the library and a test can read every series without a canvas.
 */

import { applyChartSettings, type ChartSettings } from "@/lib/charts/chart-settings";
import { applyChartTitle } from "@/lib/charts/chart-title";
import { CIRCLE_PACK, layoutCircles, type PackTree } from "@/lib/charts/circle-pack";
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
  /** Profile defaults. Omitted leaves the builder's own look. */
  readonly settings?: ChartSettings;
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

/** One metric's share of the metrics drawn for that category, as a percent. */
function percentShare(group: Group, metrics: readonly string[], metric: string): number | null {
  let total = 0;
  for (const name of metrics) total += sumOf(group.rows, name) ?? 0;
  const mine = sumOf(group.rows, metric);
  if (mine === null || total === 0) return null;
  return (mine / total) * 100;
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
  const percent = mark === "bar" && variation === "percent";
  const horizontal = mark === "bar" && (variation === "horizontal" || variation === "stacked-horizontal");
  const stacked =
    variation === "stacked" || variation === "stacked-area" || variation === "stacked-horizontal" || percent;
  const series = shownMetrics.map((metric) => {
    const data = percent
      ? shownGroups.map((group) => percentShare(group, shownMetrics, metric))
      : shownGroups.map((group) => sumOf(group.rows, metric));
    if (mark === "line") {
      const area = variation === "area" || variation === "stacked-area" || variation === "smooth-area";
      return {
        name: metric,
        type: "line" as const,
        data,
        ...(variation === "smooth" || variation === "smooth-area" ? { smooth: true } : {}),
        ...(variation === "step" ? { step: "end" as const } : {}),
        ...(area ? { areaStyle: {} } : {}),
        ...(variation === "dashed" ? { lineStyle: { type: "dashed" as const } } : {}),
        ...(variation === "marker" ? { showSymbol: true, symbolSize: 8 } : {}),
        ...(stacked ? { stack: "total" } : {}),
      };
    }
    return {
      name: metric,
      type: "bar" as const,
      data,
      ...(stacked ? { stack: "total" } : {}),
      ...(variation === "rounded" ? { itemStyle: { borderRadius: [4, 4, 0, 0] } } : {}),
      ...(variation === "background" ? { showBackground: true } : {}),
    };
  });
  const notes = [
    capNote(shownGroups.length, grouped.length - shownGroups.length, "categories"),
    capNote(shownMetrics.length, metrics.length - shownMetrics.length, "metrics"),
  ].filter((note): note is string => note !== null);
  if (mark === "line" && variation === "sparkline") {
    return { option: sparklineOption(theme, categories, series), notes };
  }
  return { option: frame(theme, { ...categoryAxes(categories, theme, horizontal), series }), notes };
}

/** One quiet line per metric. Axes and the legend stay hidden so the line is the whole chart. */
function sparklineOption(
  theme: ChartTheme,
  categories: readonly string[],
  series: readonly { readonly name?: string; readonly data?: unknown }[],
): Record<string, unknown> {
  const count = Math.max(series.length, 1);
  const band = 100 / count;
  return frame(theme, {
    legend: { show: false },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: series.map((_, index) => ({
      left: 8,
      right: 8,
      top: `${index * band + 1}%`,
      height: `${Math.max(band - 2, 1)}%`,
    })),
    xAxis: series.map((_, index) => ({
      type: "category" as const,
      gridIndex: index,
      data: [...categories],
      boundaryGap: false,
      show: false,
      splitLine: { show: false },
    })),
    yAxis: series.map((_, index) => ({
      type: "value" as const,
      gridIndex: index,
      show: false,
      scale: true,
      splitLine: { show: false },
    })),
    series: series.map((item, index) => ({
      name: item.name,
      type: "line" as const,
      data: item.data,
      xAxisIndex: index,
      yAxisIndex: index,
      showSymbol: false,
      smooth: true,
      areaStyle: { opacity: 0.2 },
    })),
  });
}

function scatter(input: ChartBuildInput): BuiltChart | null {
  if (input.variationId === "pack") return circlePack(input);
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
  const shown: Record<string, unknown>[] = [];
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
      type: input.variationId === "ripple" ? "effectScatter" : "scatter",
      data,
      ...(bubble ? { symbolSize: pointSize } : {}),
      ...(input.variationId === "diamond" ? { symbol: "diamond" } : {}),
    });
  }
  const drawn = shown.length;
  if (input.variationId === "connected") {
    for (const series of [...shown]) {
      shown.push({ name: series.name, type: "line", data: series.data, showSymbol: false });
    }
  }
  if (shown.every((series) => (series.data as unknown[]).length === 0)) return null;
  const notes = [capNote(drawn, all.length - drawn, "series")].filter((note): note is string => note !== null);
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
  const variation = input.variationId;
  const bubble = variation === "bubbles";
  const heat = variation === "heat";
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const plotted: { name: string; value: number[] }[] = [];
  const magnitudes: number[] = [];
  for (const row of input.rows) {
    const lon = finite(row[longitude]);
    const lat = finite(row[latitude]);
    if (lon === null || lat === null) continue;
    const value = valueColumn === null ? null : finite(row[valueColumn]);
    if (value === null) {
      if (bubble || heat) continue;
    } else if (heat) {
      magnitudes.push(value);
    }
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
      ...(heat ? { visualMap: heatScale(theme, magnitudes.slice(0, data.length), "grid") } : {}),
      series: [
        {
          type: heat ? "heatmap" : variation === "ripple" ? "effectScatter" : "scatter",
          coordinateSystem: "geo",
          data,
          ...(bubble ? { symbolSize: pointSize } : {}),
          ...(variation === "labeled" ? { label: { show: true, color: theme.ink } } : {}),
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
  const variation = input.variationId;
  const volumeRequired = variation === "volume" || variation === "average-volume";
  const volumeColumn = volumeRequired || variation === "brush" ? first(input.selection, "volume") : null;
  if (volumeRequired && volumeColumn === null) return null;
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const groupedAll = groupsOf(input.rows, time, input.mask);
  const grouped = groupedAll.slice(0, categoryCap);
  const categories: string[] = [];
  const data: number[][] = [];
  const volumes: number[] = [];
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
    if (volumeColumn !== null) volumes.push(sumOf(group.rows, volumeColumn) ?? 0);
  }
  if (data.length === 0) return null;
  const paint = theme.series[0] ?? theme.ink;
  const paintDown = theme.series[1] ?? theme.axis;
  const series: Record<string, unknown>[] = [
    {
      type: "candlestick",
      data,
      ...(variation === "themed"
        ? { itemStyle: { color: paint, color0: paintDown, borderColor: paint, borderColor0: paintDown } }
        : {}),
    },
  ];
  if (variation === "average" || variation === "average-volume") {
    series.push({
      name: "Average",
      type: "line",
      data: movingAverage(data.map((candle) => candle[1] ?? 0)),
      smooth: true,
    });
  }
  if (volumeColumn !== null)
    series.push({
      name: "Volume",
      type: "bar",
      data: volumes,
      ...(variation === "brush" ? { xAxisIndex: 1, yAxisIndex: 1 } : {}),
    });
  const omitted = groupedAll.length - grouped.length;
  const notes = omitted > 0 ? [`Showing the first ${grouped.length} of ${groupedAll.length} categories.`] : [];
  if (variation === "brush") {
    const withVolume = volumeColumn !== null;
    return {
      option: frame(theme, {
        brush: { xAxisIndex: "all", brushLink: "all", outOfBrush: { colorAlpha: 0.1 } },
        toolbox: { right: 8, top: 8, feature: { brush: { type: ["lineX", "clear"] } } },
        dataZoom: [
          { type: "inside", xAxisIndex: withVolume ? [0, 1] : [0], start: 0, end: 100 },
          { type: "slider", xAxisIndex: withVolume ? [0, 1] : [0], bottom: 8, start: 0, end: 100 },
        ],
        grid: withVolume
          ? [
              { left: 48, right: 16, top: 32, height: "52%" },
              { left: 48, right: 16, top: "72%", height: "12%" },
            ]
          : [{ left: 48, right: 16, top: 32, bottom: 56 }],
        xAxis: [
          {
            type: "category",
            data: categories,
            boundaryGap: false,
            axisLine: { onZero: false, lineStyle: { color: theme.axis } },
            axisLabel: { color: theme.axis },
            splitLine: { show: false },
            min: "dataMin",
            max: "dataMax",
          },
          ...(withVolume
            ? [
                {
                  type: "category",
                  gridIndex: 1,
                  data: categories,
                  boundaryGap: false,
                  axisLabel: { show: false },
                  axisTick: { show: false },
                  splitLine: { show: false },
                  min: "dataMin",
                  max: "dataMax",
                },
              ]
            : []),
        ],
        yAxis: [
          { scale: true, axisLabel: { color: theme.axis }, splitLine: { lineStyle: { color: theme.grid } } },
          ...(withVolume
            ? [
                {
                  scale: true,
                  gridIndex: 1,
                  axisLabel: { show: false },
                  axisTick: { show: false },
                  splitLine: { show: false },
                },
              ]
            : []),
        ],
        series: [{ ...series[0], name: "Price" }, ...series.slice(1)],
      }),
      notes,
    };
  }
  return {
    option: frame(theme, { ...categoryAxes(categories, theme, false), series }),
    notes,
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
  const variation = input.variationId;
  const filled = variation === "filled" || variation === "circular-filled";
  const circular = variation === "circular" || variation === "circular-filled";
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      radar: { indicator, axisName: { color: theme.axis }, ...(circular ? { shape: "circle" } : {}) },
      series: [
        {
          type: "radar",
          ...(filled ? { areaStyle: {} } : {}),
          ...(variation === "symbols" ? { symbol: "circle", symbolSize: 6 } : {}),
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
  const variation = input.variationId;
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const grouped = groupsOf(input.rows, groupColumn, input.mask);
  const categories: string[] = [];
  const data: number[][] = [];
  const marks: number[][] = [];
  let truncated = false;
  const outliers = variation === "outliers" || variation === "outliers-horizontal";
  const showPoints = variation === "points";
  const horizontal = variation === "horizontal" || variation === "outliers-horizontal";
  for (const group of grouped) {
    if (categories.length === categoryCap) {
      truncated = true;
      break;
    }
    const values = group.rows.map((row) => finite(row[valueColumn])).filter((value): value is number => value !== null);
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    const index = categories.length;
    categories.push(group.label);
    if (outliers) {
      const q1 = quartile(values, 0.25);
      const q3 = quartile(values, 0.75);
      const iqr = q3 - q1;
      const low = q1 - iqr * 1.5;
      const high = q3 + iqr * 1.5;
      const inside = values.filter((value) => value >= low && value <= high);
      data.push([Math.min(q1, ...inside), q1, quartile(values, 0.5), q3, Math.max(q3, ...inside)]);
      for (const value of values) {
        if (value < low || value > high) marks.push(horizontal ? [value, index] : [index, value]);
      }
    } else {
      data.push([
        quartile(values, 0),
        quartile(values, 0.25),
        quartile(values, 0.5),
        quartile(values, 0.75),
        quartile(values, 1),
      ]);
      if (showPoints) for (const value of values) marks.push([index, value]);
    }
  }
  if (data.length === 0) return null;
  const series: Record<string, unknown>[] = [{ type: "boxplot", data }];
  if (outliers || showPoints) series.push({ type: "scatter", data: marks });
  return {
    option: frame(theme, {
      ...categoryAxes(categories, theme, horizontal),
      series,
    }),
    notes: truncated ? [`Showing the first ${data.length} of ${grouped.length} categories.`] : [],
  };
}

function heatScale(theme: ChartTheme, flat: readonly number[], variation: string): Record<string, unknown> {
  const high = theme.series[0] ?? theme.ink;
  const mid = theme.series[1] ?? theme.axis;
  const pieces = variation === "pieces" || variation === "labeled-pieces";
  return {
    min: Math.min(...flat),
    max: Math.max(...flat),
    calculable: false,
    ...(pieces ? { type: "piecewise" as const } : {}),
    inRange: { color: variation === "diverging" ? [mid, theme.grid, high] : [theme.grid, high] },
    textStyle: { color: theme.ink },
  };
}

function heatmap(input: ChartBuildInput): BuiltChart | null {
  if (input.variationId === "calendar") return calendarHeatmap(input);
  if (input.variationId === "correlation") return correlationHeatmap(input);
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
  const labeled = input.variationId === "labeled" || input.variationId === "labeled-pieces";
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      grid: { left: 16, right: 16, top: 16, bottom: 16, containLabel: true },
      xAxis: { type: "category", data: xLabels, axisLabel: { color: theme.axis } },
      yAxis: { type: "category", data: yLabels, axisLabel: { color: theme.axis } },
      visualMap: heatScale(theme, flat, input.variationId),
      series: [
        {
          type: "heatmap",
          data,
          ...(labeled ? { label: { show: true, color: theme.ink } } : {}),
        },
      ],
    }),
    notes: omitted > 0 ? [`Showing the first ${cap} values on each axis. ${omitted} rows are outside that grid.`] : [],
  };
}

/** A calendar day, or null when the cell is not a date. */
function calendarDay(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function calendarHeatmap(input: ChartBuildInput): BuiltChart | null {
  const dateColumn = first(input.selection, "date");
  const valueColumn = first(input.selection, "value");
  if (dateColumn === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const totals = new Map<string, number>();
  const order: string[] = [];
  let omitted = 0;
  for (const row of input.rows) {
    const day = calendarDay(row[dateColumn]);
    const value = finite(row[valueColumn]);
    if (day === null || value === null) continue;
    if (!totals.has(day) && order.length === categoryCap) {
      omitted += 1;
      continue;
    }
    if (!totals.has(day)) order.push(day);
    totals.set(day, (totals.get(day) ?? 0) + value);
  }
  if (order.length === 0) return null;
  const sorted = [...order].sort();
  const data = order.map((day) => [day, totals.get(day) ?? 0]);
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      legend: { show: false },
      visualMap: heatScale(
        theme,
        data.map((cell) => Number(cell[1])),
        "grid",
      ),
      calendar: {
        range: [sorted[0], sorted[sorted.length - 1]],
        cellSize: ["auto", 16],
        itemStyle: { color: theme.grid, borderColor: theme.axis, borderWidth: 1 },
        dayLabel: { color: theme.axis },
        monthLabel: { color: theme.axis },
        yearLabel: { color: theme.ink },
      },
      series: [{ type: "heatmap", coordinateSystem: "calendar", data }],
    }),
    notes: omitted > 0 ? [`Showing the first ${order.length} days. ${omitted} rows are outside that range.`] : [],
  };
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const count = xs.length;
  if (count < 2 || ys.length !== count) return null;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < count; index += 1) {
    sumX += xs[index] ?? 0;
    sumY += ys[index] ?? 0;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let numerator = 0;
  let squareX = 0;
  let squareY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    const dy = (ys[index] ?? 0) - meanY;
    numerator += dx * dy;
    squareX += dx * dx;
    squareY += dy * dy;
  }
  if (squareX === 0 || squareY === 0) return null;
  return numerator / Math.sqrt(squareX * squareY);
}

function correlationHeatmap(input: ChartBuildInput): BuiltChart | null {
  const metrics = many(input.selection, "metrics");
  if (metrics.length < 2) return null;
  const theme = themeOf(input);
  const cap = input.heatmapCap ?? HEATMAP_AXIS_CAP;
  const shown = metrics.slice(0, cap);
  const columns = shown.map((metric) => input.rows.map((row) => finite(row[metric])));
  const data: number[][] = [];
  for (let x = 0; x < shown.length; x += 1) {
    for (let y = 0; y < shown.length; y += 1) {
      const left = columns[x] ?? [];
      const right = columns[y] ?? [];
      const xs: number[] = [];
      const ys: number[] = [];
      const count = Math.min(left.length, right.length);
      for (let index = 0; index < count; index += 1) {
        const a = left[index];
        const b = right[index];
        if (a === null || a === undefined || b === null || b === undefined) continue;
        xs.push(a);
        ys.push(b);
      }
      const value = pearson(xs, ys);
      if (value === null) continue;
      data.push([x, y, Math.round(value * 1000) / 1000]);
    }
  }
  if (data.length === 0) return null;
  const high = theme.series[0] ?? theme.ink;
  const mid = theme.series[1] ?? theme.axis;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      grid: { left: 16, right: 16, top: 16, bottom: 16, containLabel: true },
      xAxis: { type: "category", data: [...shown], axisLabel: { color: theme.axis } },
      yAxis: { type: "category", data: [...shown], axisLabel: { color: theme.axis } },
      visualMap: {
        min: -1,
        max: 1,
        calculable: false,
        inRange: { color: [mid, theme.grid, high] },
        textStyle: { color: theme.ink },
      },
      series: [{ type: "heatmap", data, label: { show: true, color: theme.ink } }],
    }),
    notes: shown.length < metrics.length ? [`Showing the first ${shown.length} of ${metrics.length} metrics.`] : [],
  };
}

function blankCell(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function circlePack(input: ChartBuildInput): BuiltChart | null {
  const nameColumn = first(input.selection, "name");
  const sizeColumn = first(input.selection, "size");
  if (nameColumn === null || sizeColumn === null) return null;
  const parentColumn = first(input.selection, "parent");
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const leaves = new Map<string, { name: string; parent: string | null; value: number }>();
  let seen = 0;
  let omitted = 0;
  for (const row of input.rows) {
    const amount = finite(row[sizeColumn]);
    if (amount === null || amount <= 0) continue;
    if (seen === categoryCap) {
      omitted += 1;
      continue;
    }
    seen += 1;
    const name = chartLabel(row[nameColumn], nameColumn, input.mask);
    const parentRaw = parentColumn === null ? undefined : row[parentColumn];
    const parent =
      parentColumn === null || blankCell(parentRaw) ? null : chartLabel(parentRaw, parentColumn, input.mask);
    const groupedParent = parent === name ? null : parent;
    const key = `${groupedParent ?? ""}\0${name}`;
    const existing = leaves.get(key);
    if (existing === undefined) leaves.set(key, { name, parent: groupedParent, value: amount });
    else existing.value += amount;
  }
  const shown = [...leaves.values()];
  if (shown.length === 0) return null;
  const groups = new Map<string, PackTree>();
  const roots: PackTree[] = [];
  for (const leaf of shown) {
    const node: PackTree = { name: leaf.name, value: leaf.value };
    if (leaf.parent === null) {
      roots.push(node);
      continue;
    }
    const group = groups.get(leaf.parent);
    if (group === undefined) groups.set(leaf.parent, { name: leaf.parent, children: [node] });
    else group.children?.push(node);
  }
  const circles = layoutCircles({ name: "", children: [...groups.values(), ...roots] }, theme.series, theme.grid);
  if (circles === null) return null;
  return {
    option: frame(theme, {
      libredb: CIRCLE_PACK,
      ink: theme.ink,
      legend: { show: false },
      data: circles,
    }),
    notes: omitted > 0 ? [`Showing the first ${seen} circles. ${omitted} rows are not drawn.`] : [],
  };
}

function graph(input: ChartBuildInput): BuiltChart | null {
  const source = first(input.selection, "source");
  const target = first(input.selection, "target");
  if (source === null || target === null) return null;
  const weight = first(input.selection, "weight");
  // Node size is the source node's measure. A source on several links keeps the greatest finite value.
  const sizeColumn = first(input.selection, "size");
  const theme = themeOf(input);
  const cap = input.nodeCap ?? GRAPH_NODE_CAP;
  const names: string[] = [];
  const seen = new Set<string>();
  const links: { source: string; target: string; value?: number }[] = [];
  const sizes = new Map<string, number>();
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
    if (sizeColumn !== null) {
      const amount = finite(row[sizeColumn]);
      if (amount !== null) {
        const current = sizes.get(from);
        if (current === undefined || amount > current) sizes.set(from, amount);
      }
    }
    const value = weight === null ? null : finite(row[weight]);
    links.push(value === null ? { source: from, target: to } : { source: from, target: to, value });
  }
  if (links.length === 0) return null;
  const variation = input.variationId;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "graph",
          layout: variation === "circular" ? "circular" : "force",
          roam: true,
          label: { show: false, color: theme.ink },
          ...(variation === "curved" ? { lineStyle: { curveness: 0.3 } } : {}),
          ...(variation === "arrows" ? { edgeSymbol: ["none", "arrow"] } : {}),
          ...(variation === "labeled" ? { edgeLabel: { show: true, color: theme.ink } } : {}),
          ...(sizeColumn !== null ? { symbolSize: pointSize } : {}),
          data: names.map((name) => {
            const size = sizes.get(name);
            return size === undefined ? { name } : { name, value: size };
          }),
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
          ...(input.variationId === "depth" ? { leafDepth: 1 } : {}),
          ...(input.variationId === "plain" ? { breadcrumb: { show: false } } : {}),
          ...(input.variationId === "padded" ? { itemStyle: { gapWidth: 4 } } : {}),
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
  const targets = many(input.selection, "target");
  const valueColumn = first(input.selection, "value");
  if (source === null || targets.length === 0 || valueColumn === null) return null;
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
    const value = finite(row[valueColumn]);
    if (value === null || value <= 0) continue;
    for (const target of targets) {
      if (blankCell(row[target])) continue;
      const to = chartLabel(row[target], target, input.mask);
      if (from === to) continue;
      if (!remember(from) || !remember(to)) {
        omitted += 1;
        continue;
      }
      const key = `${from}\0${to}`;
      const existing = links.get(key);
      if (existing === undefined) links.set(key, { source: from, target: to, value });
      else existing.value += value;
    }
  }
  if (links.size === 0) return null;
  const variation = input.variationId;
  const outflow = new Map<string, number>();
  for (const link of links.values()) outflow.set(link.source, (outflow.get(link.source) ?? 0) + link.value);
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "sankey",
          orient: variation === "vertical" ? "vertical" : "horizontal",
          ...(variation === "left" ? { nodeAlign: "left" } : {}),
          ...(variation === "gradient" ? { lineStyle: { color: "gradient" } } : {}),
          data: nodes.map((name) => (variation === "values" ? { name, value: outflow.get(name) ?? 0 } : { name })),
          links: [...links.values()],
          label: variation === "values" ? { color: theme.ink, formatter: "{b}\n{c}" } : { color: theme.ink },
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
  const variation = input.variationId;
  const align = variation === "left" ? "left" : variation === "right" ? "right" : null;
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "funnel",
          sort: variation === "pyramid" ? "ascending" : "descending",
          ...(align === null ? {} : { funnelAlign: align }),
          data: shown,
          label: {
            color: theme.ink,
            ...(variation === "percent" ? { formatter: "{b}\n{d}%" } : {}),
          },
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
          ...(variation === "ring"
            ? {
                startAngle: 90,
                endAngle: -270,
                progress: { show: true, roundCap: true },
                pointer: { show: false },
                axisLine: { roundCap: true },
              }
            : {}),
          ...(variation === "grade" || variation === "stage"
            ? {
                axisLine: {
                  lineStyle: {
                    color:
                      variation === "stage"
                        ? [
                            [0.2, band(0)],
                            [0.4, band(1)],
                            [0.6, band(2)],
                            [0.8, band(3)],
                            [1, band(4)],
                          ]
                        : [
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

function pie(input: ChartBuildInput): BuiltChart | null {
  const nameColumn = first(input.selection, "name");
  const valueColumn = first(input.selection, "value");
  if (nameColumn === null || valueColumn === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const slices = groupsOf(input.rows, nameColumn, input.mask)
    .map((group) => ({ name: group.label, value: sumOf(group.rows, valueColumn) }))
    .filter((item): item is { name: string; value: number } => item.value !== null && item.value > 0);
  const shown = slices.slice(0, categoryCap);
  if (shown.length === 0) return null;
  const variation = input.variationId;
  const radius =
    variation === "half"
      ? ["40%", "70%"]
      : variation === "donut"
        ? ["42%", "70%"]
        : variation === "rose" || variation === "nightingale"
          ? ["8%", "70%"]
          : "70%";
  return {
    option: frame(theme, {
      tooltip: { trigger: "item" },
      series: [
        {
          type: "pie",
          radius,
          data: shown,
          ...(variation === "rose" ? { roseType: "radius" } : {}),
          ...(variation === "nightingale" ? { roseType: "area" } : {}),
          ...(variation === "half" ? { startAngle: 180, endAngle: 360 } : {}),
          label: {
            color: theme.ink,
            ...(variation === "labeled" ? { formatter: "{b}\n{d}%" } : {}),
          },
        },
      ],
    }),
    notes: [capNote(shown.length, slices.length - shown.length, "categories")].filter(
      (note): note is string => note !== null,
    ),
  };
}

/** The signed change drawn on a waterfall bar, or nothing for the invisible base. */
function waterfallLabel(data: unknown): string {
  if (typeof data !== "object" || data === null || !("signed" in data)) return "";
  const signed = data.signed;
  if (typeof signed !== "number" || !Number.isFinite(signed)) return "";
  if (signed > 0) return `+${signed}`;
  return String(signed);
}

interface WaterfallStep {
  readonly label: string;
  readonly change: number;
  /** A total stands on zero instead of on the bar before it. */
  readonly fromZero: boolean;
}

function waterfallSteps(
  points: readonly { label: string; value: number }[],
  variation: string,
): readonly WaterfallStep[] {
  if (variation === "balance") {
    const steps: WaterfallStep[] = [];
    let previous: number | null = null;
    for (const point of points) {
      const change = previous === null ? point.value : point.value - previous;
      steps.push({ label: point.label, change, fromZero: false });
      previous = point.value;
    }
    return steps;
  }
  const steps = points.map((point) => ({ label: point.label, change: point.value, fromZero: false }));
  if (variation !== "total") return steps;
  let sum = 0;
  for (const step of steps) sum += step.change;
  return [...steps, { label: "Total", change: sum, fromZero: true }];
}

function waterfall(input: ChartBuildInput): BuiltChart | null {
  const dimension = first(input.selection, "category");
  const metric = first(input.selection, "value");
  if (dimension === null || metric === null) return null;
  const theme = themeOf(input);
  const categoryCap = input.categoryCap ?? CHART_CATEGORY_CAP;
  const grouped = groupsOf(input.rows, dimension, input.mask);
  const shownGroups = grouped.slice(0, categoryCap);
  const points: { label: string; value: number }[] = [];
  for (const group of shownGroups) {
    const value = sumOf(group.rows, metric);
    if (value === null) continue;
    points.push({ label: group.label, value });
  }
  const steps = waterfallSteps(points, input.variationId);
  if (steps.length === 0) return null;
  const variation = input.variationId;
  const horizontal = variation === "horizontal";
  const assist: number[] = [];
  const rise: ({ value: number; signed: number } | "-")[] = [];
  const fall: ({ value: number; signed: number } | "-")[] = [];
  let running = 0;
  for (const step of steps) {
    const base = step.fromZero ? 0 : running;
    if (step.change >= 0) {
      assist.push(base);
      rise.push({ value: step.change, signed: step.change });
      fall.push("-");
      running = base + step.change;
    } else {
      assist.push(base + step.change);
      rise.push("-");
      fall.push({ value: -step.change, signed: step.change });
      running = base + step.change;
    }
  }
  const label = {
    show: variation === "labeled",
    position: horizontal ? "right" : "top",
    color: theme.ink,
    formatter: (params: { data?: unknown }) => waterfallLabel(params.data),
  };
  return {
    option: frame(theme, {
      ...categoryAxes(
        steps.map((step) => step.label),
        theme,
        horizontal,
      ),
      legend: {
        type: "scroll",
        top: 4,
        textStyle: { color: theme.ink },
        data: ["Increase", "Decrease"],
      },
      series: [
        {
          name: "Base",
          type: "bar",
          stack: "waterfall",
          itemStyle: { color: "transparent", borderColor: "transparent" },
          emphasis: { itemStyle: { color: "transparent", borderColor: "transparent" } },
          tooltip: { show: false },
          data: assist,
        },
        {
          name: "Increase",
          type: "bar",
          stack: "waterfall",
          itemStyle: { color: theme.series[2] },
          label,
          data: rise,
        },
        {
          name: "Decrease",
          type: "bar",
          stack: "waterfall",
          itemStyle: { color: theme.series[7] },
          label,
          data: fall,
        },
      ],
    }),
    notes: [capNote(shownGroups.length, grouped.length - shownGroups.length, "categories")].filter(
      (note): note is string => note !== null,
    ),
  };
}

const BUILDERS: Record<string, (input: ChartBuildInput) => BuiltChart | null> = {
  line: (input) => categorySeries(input, "line"),
  bar: (input) => categorySeries(input, "bar"),
  waterfall,
  pie,
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
  const titled = applyChartTitle(built.option, input.title ?? "");
  if (input.settings === undefined) return { option: titled, notes: built.notes };
  return { option: applyChartSettings(titled, input.typeId, input.variationId, input.settings), notes: built.notes };
}

/** Disconnects a resize observer, or does nothing where the browser has none. */
export function watchChartSize(element: Element, onResize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => onResize());
  observer.observe(element);
  return () => observer.disconnect();
}
