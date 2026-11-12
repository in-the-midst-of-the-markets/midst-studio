/**
 * The chart defaults a person sets from the profile menu.
 *
 * They are this browser's starting look for each chart type: type, sizes,
 * background, font color, and up to eight chart colors. Chart code the
 * person edits still wins, and a variation that exists to turn one of these
 * on or off keeps that choice for the chart where they picked it.
 */

import { ECHART_TYPES } from "@/lib/charts/echarts-catalog";
import { chartTheme, type ChartTheme } from "@/lib/charts/palette";

const STORAGE_KEY = "libredb_chart_settings";

export const CHART_FONT_SIZE_MIN = 8;
export const CHART_FONT_SIZE_MAX = 72;
/** How many chart colors the profile menu keeps. */
export const CHART_COLOR_LIMIT = 8;

const CHART_COLOR = /^#[0-9a-f]{6}$/;

export const CHART_FONTS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "Montserrat, sans-serif", label: "Montserrat" },
  { id: "Georgia, serif", label: "Georgia" },
  { id: "Palatino, Palatino Linotype, serif", label: "Palatino" },
  { id: "ui-sans-serif, sans-serif", label: "System" },
  { id: "ui-monospace, SFMono-Regular, monospace", label: "Mono" },
];

export interface ChartTextSettings {
  readonly fontFamily: string;
  readonly titleFontSize: number;
  readonly axisFontSize: number;
  readonly labelFontSize: number;
  readonly legend: boolean;
}

export interface ChartColorSettings {
  /** Empty leaves the page showing through the plot. */
  readonly background: string;
  /** Empty leaves the theme's own ink. */
  readonly font: string;
  /** Empty leaves the theme palette. At most eight different colors, in slot order. */
  readonly series: readonly string[];
}

export interface ChartSettings {
  readonly text: ChartTextSettings;
  readonly colors: ChartColorSettings;
  readonly types: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

interface ChartControl {
  readonly id: string;
  readonly label: string;
  /** What a chart draws before anyone changes this control. */
  readonly defaultValue: boolean;
  /** Variations that decide this control themselves. */
  readonly lock: readonly string[];
  readonly apply: (option: Record<string, unknown>, value: boolean) => Record<string, unknown>;
}

export interface ChartCategory {
  readonly id: string;
  readonly label: string;
  readonly controls: readonly { readonly id: string; readonly label: string; readonly defaultValue: boolean }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(record: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, value]) => record[key] === value);
}

function withNested(
  record: Record<string, unknown>,
  key: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const current = record[key];
  const base = isRecord(current) ? current : {};
  if (isRecord(current) && matches(base, patch)) return record;
  return { ...record, [key]: { ...base, ...patch } };
}

function mapAxes(
  option: Record<string, unknown>,
  map: (axis: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  let changed = false;
  const patch: Record<string, unknown> = {};
  for (const key of ["xAxis", "yAxis"]) {
    const value = option[key];
    if (Array.isArray(value)) {
      const mapped = value.map((item) => (isRecord(item) ? map(item) : item));
      patch[key] = mapped;
      if (mapped.some((item, index) => item !== value[index])) changed = true;
    } else if (isRecord(value)) {
      const mapped = map(value);
      patch[key] = mapped;
      if (mapped !== value) changed = true;
    }
  }
  return changed ? { ...option, ...patch } : option;
}

function mapSeries(
  option: Record<string, unknown>,
  map: (series: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const series = option.series;
  if (Array.isArray(series)) {
    const mapped = series.map((item) => (isRecord(item) ? map(item) : item));
    if (mapped.every((item, index) => item === series[index])) return option;
    return { ...option, series: mapped };
  }
  if (!isRecord(series)) return option;
  const mapped = map(series);
  return mapped === series ? option : { ...option, series: mapped };
}

function showOnSeries(option: Record<string, unknown>, key: string, show: boolean): Record<string, unknown> {
  return mapSeries(option, (series) => withNested(series, key, { show }));
}

function showGridlines(option: Record<string, unknown>, show: boolean): Record<string, unknown> {
  return mapAxes(option, (axis) => withNested(axis, "splitLine", { show }));
}

function showSymbols(option: Record<string, unknown>, show: boolean): Record<string, unknown> {
  return mapSeries(option, (series) => {
    if (series.type !== "line" || series.showSymbol === show) return series;
    return { ...series, showSymbol: show };
  });
}

function showRadarLabels(option: Record<string, unknown>, show: boolean): Record<string, unknown> {
  const radar = option.radar;
  if (!isRecord(radar)) return option;
  const next = withNested(radar, "axisName", { show });
  return next === radar ? option : { ...option, radar: next };
}

const lineControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
  { id: "symbols", label: "Point markers", defaultValue: true, lock: ["marker"], apply: showSymbols },
];

const barControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
];

function showWaterfallLabels(option: Record<string, unknown>, show: boolean): Record<string, unknown> {
  return mapSeries(option, (series) => (series.name === "Base" ? series : withNested(series, "label", { show })));
}

const waterfallControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
  { id: "labels", label: "Bar labels", defaultValue: false, lock: ["labeled"], apply: showWaterfallLabels },
];

const pieControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Slice labels",
    defaultValue: true,
    lock: ["labeled"],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
];

const scatterControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
];

const geoControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Point labels",
    defaultValue: false,
    lock: ["labeled"],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
];

const candlestickControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
];

const radarControls: readonly ChartControl[] = [
  { id: "labels", label: "Axis labels", defaultValue: true, lock: [], apply: showRadarLabels },
];

const boxplotControls: readonly ChartControl[] = [
  { id: "gridlines", label: "Gridlines", defaultValue: true, lock: [], apply: showGridlines },
];

const heatmapControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Cell labels",
    defaultValue: false,
    lock: ["labeled", "labeled-pieces"],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
];

const graphControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Node labels",
    defaultValue: false,
    lock: [],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
  {
    id: "edgeLabels",
    label: "Edge labels",
    defaultValue: false,
    lock: ["labeled"],
    apply: (option, show) => showOnSeries(option, "edgeLabel", show),
  },
];

const treemapControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Tile labels",
    defaultValue: true,
    lock: [],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
  {
    id: "breadcrumb",
    label: "Breadcrumb",
    defaultValue: true,
    lock: ["plain"],
    apply: (option, show) => showOnSeries(option, "breadcrumb", show),
  },
];

const sankeyControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Node labels",
    defaultValue: true,
    lock: [],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
];

const funnelControls: readonly ChartControl[] = [
  {
    id: "labels",
    label: "Stage labels",
    defaultValue: true,
    lock: [],
    apply: (option, show) => showOnSeries(option, "label", show),
  },
];

const gaugeControls: readonly ChartControl[] = [
  {
    id: "pointer",
    label: "Pointer",
    defaultValue: true,
    lock: ["progress", "ring"],
    apply: (option, show) => showOnSeries(option, "pointer", show),
  },
  {
    id: "labels",
    label: "Value label",
    defaultValue: true,
    lock: [],
    apply: (option, show) => showOnSeries(option, "detail", show),
  },
];

const CONTROLS: Readonly<Record<string, readonly ChartControl[]>> = {
  line: lineControls,
  bar: barControls,
  waterfall: waterfallControls,
  pie: pieControls,
  scatter: scatterControls,
  geo: geoControls,
  candlestick: candlestickControls,
  radar: radarControls,
  boxplot: boxplotControls,
  heatmap: heatmapControls,
  graph: graphControls,
  treemap: treemapControls,
  sankey: sankeyControls,
  funnel: funnelControls,
  gauge: gaugeControls,
};

function categoryControls(typeId: string): readonly ChartControl[] {
  return CONTROLS[typeId] ?? [];
}

/** The chart types, in the same order as the chart picker, and the controls each one offers. */
export function chartCategories(): readonly ChartCategory[] {
  return ECHART_TYPES.map((type) => ({
    id: type.id,
    label: type.label,
    controls: categoryControls(type.id).map((control) => ({
      id: control.id,
      label: control.label,
      defaultValue: control.defaultValue,
    })),
  }));
}

function textDefaults(): ChartTextSettings {
  return {
    fontFamily: "Montserrat, sans-serif",
    titleFontSize: 14,
    axisFontSize: 12,
    labelFontSize: 12,
    legend: true,
  };
}

function typeDefaults(): Record<string, Record<string, boolean>> {
  const types: Record<string, Record<string, boolean>> = {};
  for (const type of ECHART_TYPES) {
    const values: Record<string, boolean> = {};
    for (const control of categoryControls(type.id)) values[control.id] = control.defaultValue;
    types[type.id] = values;
  }
  return types;
}

function colorDefaults(): ChartColorSettings {
  return { background: "", font: "", series: [] };
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  text: textDefaults(),
  colors: colorDefaults(),
  types: typeDefaults(),
};

/** A `#rrggbb` color, or "" when the value is not one. */
export function chartColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const color = value.trim().toLowerCase();
  return CHART_COLOR.test(color) ? color : "";
}

/** The next built-in chart color that is not already in the list. */
export function nextChartColor(colors: readonly string[]): string {
  const choices = chartTheme("dark").series;
  for (const color of choices) {
    if (!colors.includes(color)) return color;
  }
  return choices[0] as string;
}

function fontFamilyOf(value: unknown): string {
  return CHART_FONTS.some((font) => font.id === value) ? (value as string) : DEFAULT_CHART_SETTINGS.text.fontFamily;
}

function fontSizeOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < CHART_FONT_SIZE_MIN || value > CHART_FONT_SIZE_MAX) return fallback;
  return value;
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function colorsFrom(value: unknown): ChartColorSettings {
  const record = isRecord(value) ? value : {};
  const series: string[] = [];
  if (Array.isArray(record.series)) {
    for (const item of record.series) {
      if (series.length >= CHART_COLOR_LIMIT) break;
      const color = chartColor(item);
      if (color === "" || series.includes(color)) continue;
      series.push(color);
    }
  }
  return { background: chartColor(record.background), font: chartColor(record.font), series };
}

function sameColors(colors: ChartColorSettings): boolean {
  return (
    colors.background === DEFAULT_CHART_SETTINGS.colors.background &&
    colors.font === DEFAULT_CHART_SETTINGS.colors.font &&
    colors.series.length === DEFAULT_CHART_SETTINGS.colors.series.length
  );
}

function textFrom(value: unknown): ChartTextSettings {
  const record = isRecord(value) ? value : {};
  const defaults = DEFAULT_CHART_SETTINGS.text;
  return {
    fontFamily: fontFamilyOf(record.fontFamily),
    titleFontSize: fontSizeOf(record.titleFontSize, defaults.titleFontSize),
    axisFontSize: fontSizeOf(record.axisFontSize, defaults.axisFontSize),
    labelFontSize: fontSizeOf(record.labelFontSize, defaults.labelFontSize),
    legend: booleanOf(record.legend, defaults.legend),
  };
}

function typesFrom(value: unknown): Record<string, Record<string, boolean>> {
  const record = isRecord(value) ? value : {};
  const types: Record<string, Record<string, boolean>> = {};
  for (const type of ECHART_TYPES) {
    const stored = record[type.id];
    const source = isRecord(stored) ? stored : {};
    const values: Record<string, boolean> = {};
    for (const control of categoryControls(type.id)) {
      values[control.id] = booleanOf(source[control.id], control.defaultValue);
    }
    types[type.id] = values;
  }
  return types;
}

/** A stored object, or the defaults when it is not one. */
export function normalizeChartSettings(value: unknown): ChartSettings {
  if (!isRecord(value)) return DEFAULT_CHART_SETTINGS;
  const text = textFrom(value.text);
  const colors = colorsFrom(value.colors);
  const types = typesFrom(value.types);
  const sameText =
    text.fontFamily === DEFAULT_CHART_SETTINGS.text.fontFamily &&
    text.titleFontSize === DEFAULT_CHART_SETTINGS.text.titleFontSize &&
    text.axisFontSize === DEFAULT_CHART_SETTINGS.text.axisFontSize &&
    text.labelFontSize === DEFAULT_CHART_SETTINGS.text.labelFontSize &&
    text.legend === DEFAULT_CHART_SETTINGS.text.legend;
  const sameTypes = ECHART_TYPES.every((type) => {
    const next = types[type.id] ?? {};
    const defaults = DEFAULT_CHART_SETTINGS.types[type.id] ?? {};
    return categoryControls(type.id).every((control) => next[control.id] === defaults[control.id]);
  });
  if (sameText && sameTypes && sameColors(colors)) return DEFAULT_CHART_SETTINGS;
  return { text, colors, types };
}

let cachedRaw: string | null | undefined;
let cachedSettings: ChartSettings = DEFAULT_CHART_SETTINGS;
const listeners = new Set<() => void>();

function remember(raw: string | null, settings: ChartSettings): ChartSettings {
  cachedRaw = raw;
  cachedSettings = settings;
  return settings;
}

/** Notifies an open chart when this browser's defaults change. */
export function subscribeChartSettings(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: Event) => {
    if (!("key" in event)) return;
    const key = event.key;
    if (key === STORAGE_KEY || key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function settingsFrom(raw: string | null): ChartSettings {
  if (raw === null) return DEFAULT_CHART_SETTINGS;
  try {
    return normalizeChartSettings(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_CHART_SETTINGS;
  }
}

/** The saved defaults, or the built-in look when nothing usable is stored. */
export function readChartSettings(): ChartSettings {
  if (typeof localStorage === "undefined") return DEFAULT_CHART_SETTINGS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSettings;
  return remember(raw, settingsFrom(raw));
}

/** Writes the defaults. A full disk or a locked browser leaves the previous value. */
export function writeChartSettings(settings: ChartSettings): void {
  if (typeof localStorage === "undefined") return;
  const normalized = normalizeChartSettings(settings);
  try {
    const raw = JSON.stringify(normalized);
    localStorage.setItem(STORAGE_KEY, raw);
    remember(raw, normalized);
    for (const listener of listeners) listener();
  } catch {
    // The previous defaults stay in place when the browser refuses the write.
  }
}

function withTextStyle(option: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = withNested(option, "textStyle", patch);
  return next;
}

function withTitleStyle(option: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const title = option.title;
  if (!isRecord(title)) return option;
  const next = withNested(title, "textStyle", patch);
  return next === title ? option : { ...option, title: next };
}

function withLegendStyle(option: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const legend = option.legend;
  if (!isRecord(legend)) return option;
  const next = withNested(legend, "textStyle", patch);
  return next === legend ? option : { ...option, legend: next };
}

function withRadarStyle(option: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const radar = option.radar;
  if (!isRecord(radar)) return option;
  const next = withNested(radar, "axisName", patch);
  return next === radar ? option : { ...option, radar: next };
}

function paintFont(option: Record<string, unknown>, family: string): Record<string, unknown> {
  let next = withTextStyle(option, { fontFamily: family });
  next = withTitleStyle(next, { fontFamily: family });
  next = withLegendStyle(next, { fontFamily: family });
  next = withRadarStyle(next, { fontFamily: family });
  next = mapAxes(next, (axis) => withNested(axis, "axisLabel", { fontFamily: family }));
  next = mapSeries(next, (series) =>
    isRecord(series.label) ? withNested(series, "label", { fontFamily: family }) : series,
  );
  return next;
}

function paintLabelSize(option: Record<string, unknown>, size: number): Record<string, unknown> {
  return withTextStyle(option, { fontSize: size });
}

function paintTitleSize(option: Record<string, unknown>, size: number): Record<string, unknown> {
  return withTitleStyle(option, { fontSize: size });
}

function paintAxisSize(option: Record<string, unknown>, size: number): Record<string, unknown> {
  const axes = mapAxes(option, (axis) => withNested(axis, "axisLabel", { fontSize: size }));
  return withRadarStyle(axes, { fontSize: size });
}

function hideLegend(option: Record<string, unknown>): Record<string, unknown> {
  const legend = option.legend;
  if (isRecord(legend)) {
    if (legend.show === false) return option;
    return { ...option, legend: { ...legend, show: false } };
  }
  return { ...option, legend: { show: false } };
}

function paletteOf(theme: ChartTheme, saved: readonly string[]): readonly string[] {
  if (saved.length === 0) return theme.series;
  const chosen: string[] = [];
  const limit = theme.series.length;
  for (const color of saved) {
    if (chosen.length >= limit) break;
    if (chosen.includes(color)) continue;
    chosen.push(color);
  }
  for (const color of theme.series) {
    if (chosen.length >= limit) break;
    if (chosen.includes(color)) continue;
    chosen.push(color);
  }
  return chosen;
}

/**
 * The theme a chart is built from, with this browser's colors in front.
 * An empty font or an empty chart-color list leaves that part of the theme.
 */
export function chartThemeWithSettings(theme: ChartTheme, settings: ChartSettings): ChartTheme {
  const series = paletteOf(theme, settings.colors.series);
  if (settings.colors.font === "" && series === theme.series) return theme;
  return {
    ...theme,
    series,
    ...(settings.colors.font === "" ? {} : { ink: settings.colors.font }),
  };
}

function paintSeriesInk(series: Record<string, unknown>, color: string): Record<string, unknown> {
  let painted = series;
  if (isRecord(series.label)) painted = withNested(painted, "label", { color });
  if (isRecord(painted.edgeLabel)) painted = withNested(painted, "edgeLabel", { color });
  if (isRecord(painted.detail)) painted = withNested(painted, "detail", { color });
  if (isRecord(painted.title)) painted = withNested(painted, "title", { color });
  return painted;
}

function paintNamedInk(
  option: Record<string, unknown>,
  key: string,
  paint: (record: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const value = option[key];
  if (!isRecord(value)) return option;
  const painted = paint(value);
  return painted === value ? option : { ...option, [key]: painted };
}

function paintCalendarInk(calendar: Record<string, unknown>, color: string): Record<string, unknown> {
  let painted = calendar;
  for (const key of ["dayLabel", "monthLabel", "yearLabel"]) painted = withNested(painted, key, { color });
  return painted;
}

function paintInk(option: Record<string, unknown>, color: string): Record<string, unknown> {
  let next = withTextStyle(option, { color });
  next = withTitleStyle(next, { color });
  next = withLegendStyle(next, { color });
  next = withRadarStyle(next, { color });
  next = mapAxes(next, (axis) => withNested(axis, "axisLabel", { color }));
  next = mapSeries(next, (series) => paintSeriesInk(series, color));
  next = paintNamedInk(next, "visualMap", (record) => withNested(record, "textStyle", { color }));
  next = paintNamedInk(next, "calendar", (record) => paintCalendarInk(record, color));
  return next;
}

function applyColors(option: Record<string, unknown>, colors: ChartColorSettings): Record<string, unknown> {
  if (colors.background === "" && colors.font === "") return option;
  let next = option;
  if (colors.background !== "" && next.backgroundColor !== colors.background) {
    next = { ...next, backgroundColor: colors.background };
  }
  if (colors.font !== "") next = paintInk(next, colors.font);
  return next;
}

function applyText(option: Record<string, unknown>, text: ChartTextSettings): Record<string, unknown> {
  const defaults = DEFAULT_CHART_SETTINGS.text;
  let next = option;
  if (text.fontFamily !== defaults.fontFamily) next = paintFont(next, text.fontFamily);
  if (text.labelFontSize !== defaults.labelFontSize) next = paintLabelSize(next, text.labelFontSize);
  if (text.titleFontSize !== defaults.titleFontSize) next = paintTitleSize(next, text.titleFontSize);
  if (text.axisFontSize !== defaults.axisFontSize || text.labelFontSize !== defaults.labelFontSize) {
    next = paintAxisSize(next, text.axisFontSize);
  }
  if (text.legend !== defaults.legend) next = hideLegend(next);
  return next;
}

function applyTypes(
  option: Record<string, unknown>,
  typeId: string,
  variationId: string,
  settings: ChartSettings,
): Record<string, unknown> {
  let next = option;
  const stored = settings.types[typeId] ?? {};
  for (const control of categoryControls(typeId)) {
    if (control.lock.includes(variationId)) continue;
    const value = booleanOf(stored[control.id], control.defaultValue);
    if (value === control.defaultValue) continue;
    next = control.apply(next, value);
  }
  return next;
}

/**
 * The option with this browser's defaults written in.
 * A value that is still the built-in one is left as the chart builder wrote it.
 * A variation that locks a control is left as that variation wrote it.
 */
export function applyChartSettings(
  option: Record<string, unknown>,
  typeId: string,
  variationId: string,
  settings: ChartSettings,
): Record<string, unknown> {
  return applyColors(applyTypes(applyText(option, settings.text), typeId, variationId, settings), settings.colors);
}
