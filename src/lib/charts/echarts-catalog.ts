/**
 * The ECharts types the Charts tab offers, and which result columns each one can use.
 *
 * The tab shows the type names first. A type then shows its own variations, and only
 * the variation the user picks is drawn. A shelf lists columns of the result on screen.
 * A metric is a column whose filled cells are finite numbers.
 */

export type SlotKind = "dimension" | "metric";

export interface ChartSlot {
  readonly id: string;
  readonly label: string;
  readonly kind: SlotKind;
  readonly many: boolean;
  readonly required: boolean;
  /** How many columns to preselect. `0` leaves an optional shelf empty. */
  readonly preset: number | "all";
}

export interface ChartVariation {
  readonly id: string;
  readonly label: string;
  /** Slot ids that are optional on the type and required for this variation. */
  readonly require?: readonly string[];
  /** Shelves this variation adds. */
  readonly slots?: readonly ChartSlot[];
}

export interface EChartType {
  readonly id: string;
  readonly label: string;
  readonly slots: readonly ChartSlot[];
  readonly variations: readonly ChartVariation[];
}

const one = (id: string, label: string, kind: SlotKind, required = true): ChartSlot => ({
  id,
  label,
  kind,
  many: false,
  required,
  preset: required ? 1 : 0,
});

const many = (id: string, label: string, preset: number | "all"): ChartSlot => ({
  id,
  label,
  kind: "metric",
  many: true,
  required: true,
  preset,
});

const volumeSlot = one("volume", "Volume", "metric");

/** The types the tab shows. Order is the order of the type grid. */
export const ECHART_TYPES: readonly EChartType[] = [
  {
    id: "line",
    label: "Line",
    slots: [one("category", "Dimension", "dimension"), many("values", "Metrics", 1)],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "smooth", label: "Smooth" },
      { id: "step", label: "Step" },
      { id: "area", label: "Area" },
      { id: "smooth-area", label: "Smooth area" },
      { id: "stacked", label: "Stacked" },
      { id: "stacked-area", label: "Stacked area" },
      { id: "dashed", label: "Dashed" },
      { id: "marker", label: "Marker" },
    ],
  },
  {
    id: "bar",
    label: "Bar",
    slots: [one("category", "Dimension", "dimension"), many("values", "Metrics", 1)],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "stacked", label: "Stacked" },
      { id: "horizontal", label: "Horizontal" },
      { id: "stacked-horizontal", label: "Stacked horizontal" },
      { id: "rounded", label: "Rounded" },
      { id: "background", label: "Background" },
      { id: "percent", label: "100% stacked" },
    ],
  },
  {
    id: "waterfall",
    label: "Waterfall",
    slots: [one("category", "Dimension", "dimension"), one("value", "Value", "metric")],
    variations: [
      { id: "change", label: "Change" },
      { id: "balance", label: "Balance" },
      { id: "horizontal", label: "Horizontal" },
      { id: "total", label: "With total" },
      { id: "labeled", label: "Labeled" },
    ],
  },
  {
    id: "pie",
    label: "Pie",
    slots: [one("name", "Dimension", "dimension"), one("value", "Metric", "metric")],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "donut", label: "Donut" },
      { id: "rose", label: "Rose" },
      { id: "nightingale", label: "Nightingale" },
      { id: "half", label: "Half" },
      { id: "labeled", label: "Labeled" },
    ],
  },
  {
    id: "scatter",
    label: "Scatter",
    slots: [one("x", "X", "metric"), one("y", "Y", "metric"), one("series", "Series", "dimension", false)],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "bubble", label: "Bubble", slots: [one("size", "Size", "metric")] },
      { id: "ripple", label: "Ripple" },
      { id: "connected", label: "Connected" },
      { id: "diamond", label: "Diamond" },
    ],
  },
  {
    id: "geo",
    label: "Geo",
    slots: [
      one("longitude", "Longitude", "metric"),
      one("latitude", "Latitude", "metric"),
      one("value", "Value", "metric", false),
    ],
    variations: [
      { id: "points", label: "Points" },
      { id: "bubbles", label: "Bubbles", require: ["value"] },
      { id: "ripple", label: "Ripple" },
      { id: "heat", label: "Heat", require: ["value"] },
      { id: "labeled", label: "Labeled" },
    ],
  },
  {
    id: "candlestick",
    label: "Candlestick",
    slots: [
      one("time", "Dimension", "dimension"),
      one("open", "Open", "metric"),
      one("close", "Close", "metric"),
      one("low", "Low", "metric"),
      one("high", "High", "metric"),
    ],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "average", label: "Moving average" },
      { id: "volume", label: "Volume", slots: [volumeSlot] },
      { id: "average-volume", label: "Average and volume", slots: [volumeSlot] },
      { id: "themed", label: "Themed" },
    ],
  },
  {
    id: "radar",
    label: "Radar",
    slots: [many("axes", "Metrics", "all"), one("series", "Series", "dimension", false)],
    variations: [
      { id: "basic", label: "Outline" },
      { id: "filled", label: "Filled" },
      { id: "circular", label: "Circular" },
      { id: "circular-filled", label: "Circular filled" },
      { id: "symbols", label: "Symbols" },
    ],
  },
  {
    id: "boxplot",
    label: "Box Plot",
    slots: [one("group", "Dimension", "dimension"), one("values", "Metric", "metric")],
    variations: [
      { id: "vertical", label: "Vertical" },
      { id: "horizontal", label: "Horizontal" },
      { id: "outliers", label: "Outliers" },
      { id: "outliers-horizontal", label: "Outliers horizontal" },
      { id: "points", label: "Points" },
    ],
  },
  {
    id: "heatmap",
    label: "Heatmap",
    slots: [one("x", "X", "dimension"), one("y", "Y", "dimension"), one("value", "Metric", "metric")],
    variations: [
      { id: "grid", label: "Grid" },
      { id: "labeled", label: "Labeled" },
      { id: "pieces", label: "Pieces" },
      { id: "labeled-pieces", label: "Labeled pieces" },
      { id: "diverging", label: "Diverging" },
    ],
  },
  {
    id: "graph",
    label: "Graph",
    slots: [
      one("source", "Source", "dimension"),
      one("target", "Target", "dimension"),
      one("weight", "Weight", "metric", false),
      one("size", "Node size", "metric", false),
    ],
    variations: [
      { id: "force", label: "Force" },
      { id: "circular", label: "Circular" },
      { id: "curved", label: "Curved" },
      { id: "arrows", label: "Arrows" },
      { id: "labeled", label: "Edge labels" },
    ],
  },
  {
    id: "treemap",
    label: "Treemap",
    slots: [
      one("name", "Dimension", "dimension"),
      one("size", "Size", "metric"),
      one("parent", "Parent", "dimension", false),
    ],
    variations: [
      { id: "basic", label: "Tiles" },
      { id: "values", label: "With values" },
      { id: "depth", label: "One level" },
      { id: "plain", label: "No breadcrumb" },
      { id: "padded", label: "Padded" },
    ],
  },
  {
    id: "sankey",
    label: "Sankey",
    slots: [
      one("source", "Source", "dimension"),
      one("target", "Target", "dimension"),
      one("value", "Value", "metric"),
    ],
    variations: [
      { id: "horizontal", label: "Horizontal" },
      { id: "vertical", label: "Vertical" },
      { id: "gradient", label: "Gradient" },
      { id: "values", label: "With values" },
      { id: "left", label: "Left aligned" },
    ],
  },
  {
    id: "funnel",
    label: "Funnel",
    slots: [one("stage", "Dimension", "dimension"), one("value", "Metric", "metric")],
    variations: [
      { id: "funnel", label: "Funnel" },
      { id: "pyramid", label: "Pyramid" },
      { id: "left", label: "Left" },
      { id: "right", label: "Right" },
      { id: "percent", label: "Percent" },
    ],
  },
  {
    id: "gauge",
    label: "Gauge",
    slots: [one("value", "Metric", "metric")],
    variations: [
      { id: "basic", label: "Basic" },
      { id: "progress", label: "Progress" },
      { id: "grade", label: "Grade" },
      { id: "ring", label: "Ring" },
      { id: "stage", label: "Stage" },
    ],
  },
];

export function echartType(id: string): EChartType | null {
  return ECHART_TYPES.find((type) => type.id === id) ?? null;
}

/** The shelves a variation shows, or null when the type or variation is not one of these. */
export function slotsFor(typeId: string, variationId: string): readonly ChartSlot[] | null {
  const type = echartType(typeId);
  const variation = type?.variations.find((item) => item.id === variationId);
  if (type === null || variation === undefined) return null;
  const required = new Set(variation.require ?? []);
  const base = type.slots.map((slot) => {
    if (!required.has(slot.id) || slot.required) return slot;
    return {
      id: slot.id,
      label: slot.label,
      kind: slot.kind,
      many: slot.many,
      required: true,
      preset: 1,
    };
  });
  return [...base, ...(variation.slots ?? [])];
}

export interface ClassifiedColumns {
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
}

export type SlotSelection = Record<string, readonly string[]>;

/** A filled cell that can be plotted: a finite number, or text that parses as one. */
export function isChartNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

/**
 * A column is a metric when more than 80% of its filled cells are finite numbers.
 * An empty column is not a metric. `NaN`, `Infinity` and blank text are not numbers.
 */
export function isMetricColumn(values: readonly unknown[]): boolean {
  const filled = values.filter((value) => value !== null && value !== undefined);
  if (filled.length === 0) return false;
  let numeric = 0;
  for (const value of filled) if (isChartNumber(value)) numeric += 1;
  return numeric > filled.length * 0.8;
}

/** Dimensions are every result column. Metrics are the numeric ones, minus any the mask withholds. */
export function classifyColumns(
  fields: readonly string[],
  rows: readonly Record<string, unknown>[],
  withheld: ReadonlySet<string> = new Set(),
): ClassifiedColumns {
  const metrics = fields.filter((field) => !withheld.has(field) && isMetricColumn(rows.map((row) => row[field])));
  return { dimensions: [...fields], metrics };
}

function poolFor(slot: ChartSlot, columns: ClassifiedColumns): readonly string[] {
  return slot.kind === "metric" ? columns.metrics : columns.dimensions;
}

/** The first columns of the result that can fill this variation. Optional shelves start empty. */
export function defaultSelection(typeId: string, variationId: string, columns: ClassifiedColumns): SlotSelection {
  const slots = slotsFor(typeId, variationId);
  if (slots === null) return {};
  const used = new Set<string>();
  const selection: Record<string, string[]> = {};
  for (const slot of slots) {
    const available = poolFor(slot, columns).filter((name) => !used.has(name));
    const count = !slot.required ? 0 : slot.many ? (slot.preset === "all" ? available.length : slot.preset) : 1;
    const chosen = available.slice(0, count);
    for (const name of chosen) used.add(name);
    selection[slot.id] = chosen;
  }
  return selection;
}

/** Drops a column the current result does not offer for that shelf. */
export function pruneSelection(
  typeId: string,
  variationId: string,
  columns: ClassifiedColumns,
  selection: SlotSelection,
): SlotSelection {
  const slots = slotsFor(typeId, variationId);
  if (slots === null) return {};
  const next: Record<string, string[]> = {};
  for (const slot of slots) {
    const allowed = new Set(poolFor(slot, columns));
    next[slot.id] = (selection[slot.id] ?? []).filter((name) => allowed.has(name));
  }
  return next;
}

/**
 * Selects or clears one result column on a shelf.
 * A name that shelf cannot use is ignored, so a caller cannot plot a column the result lacks.
 */
export function toggleSlot(
  typeId: string,
  variationId: string,
  columns: ClassifiedColumns,
  selection: SlotSelection,
  slotId: string,
  name: string,
): SlotSelection {
  const slot = slotsFor(typeId, variationId)?.find((item) => item.id === slotId);
  if (slot === undefined) return selection;
  if (!new Set(poolFor(slot, columns)).has(name)) return selection;
  const current = selection[slotId] ?? [];
  const next = slot.many
    ? current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name]
    : current.length === 1 && current[0] === name
      ? []
      : [name];
  return { ...selection, [slotId]: next };
}

export function selectionReady(typeId: string, variationId: string, selection: SlotSelection): boolean {
  const slots = slotsFor(typeId, variationId);
  if (slots === null) return false;
  return slots.every((slot) => !slot.required || (selection[slot.id]?.length ?? 0) > 0);
}

const SPEC_CHOICES: Record<string, { typeId: string; variationId: string }> = {
  bar: { typeId: "bar", variationId: "basic" },
  "stacked-bar": { typeId: "bar", variationId: "stacked" },
  line: { typeId: "line", variationId: "basic" },
  area: { typeId: "line", variationId: "area" },
  pie: { typeId: "pie", variationId: "basic" },
  scatter: { typeId: "scatter", variationId: "basic" },
};

/** The type and variation a composed answer maps onto, or null when it is not one of these. */
export function chartChoiceFromSpec(
  spec: { readonly type: string } | null,
): { typeId: string; variationId: string } | null {
  if (spec === null) return null;
  return SPEC_CHOICES[spec.type] ?? null;
}

/**
 * Shelves for a composed answer, when every column it names is still in this result.
 * A pie uses `x` as the slice names and the first `y` as the size.
 * A line or bar uses `x` as the dimension and `y` as the metrics.
 */
export function selectionFromSpec(
  typeId: string,
  spec: { readonly x: string; readonly y: readonly string[] },
  columns: ClassifiedColumns,
): SlotSelection | null {
  if (typeId === "scatter") {
    const y = spec.y[0];
    if (y === undefined || !columns.metrics.includes(spec.x) || !columns.metrics.includes(y)) return null;
    return { x: [spec.x], y: [y], series: [] };
  }
  if (typeId === "pie") {
    const y = spec.y[0];
    if (y === undefined || !columns.dimensions.includes(spec.x) || !columns.metrics.includes(y)) return null;
    return { name: [spec.x], value: [y] };
  }
  if (typeId !== "line" && typeId !== "bar") return null;
  if (!columns.dimensions.includes(spec.x)) return null;
  const values = spec.y.filter((name) => columns.metrics.includes(name));
  if (values.length === 0) return null;
  return { category: [spec.x], values };
}

export interface ChartChoice {
  readonly typeId: string | null;
  readonly variationId: string | null;
  readonly selection: SlotSelection;
}

/** The type, variation and shelves a composed answer opens, or an empty choice when it does not fit. */
export function seedChartChoice(
  spec: { readonly type: string; readonly x: string; readonly y: readonly string[] } | null,
  columns: ClassifiedColumns,
): ChartChoice {
  const mapped = chartChoiceFromSpec(spec);
  if (mapped === null || spec === null) return { typeId: null, variationId: null, selection: {} };
  const selection = selectionFromSpec(mapped.typeId, spec, columns);
  if (selection === null) return { typeId: null, variationId: null, selection: {} };
  return { typeId: mapped.typeId, variationId: mapped.variationId, selection };
}
