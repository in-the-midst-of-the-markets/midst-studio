import { describe, expect, test } from "bun:test";
import {
  chartChoiceFromSpec,
  classifyColumns,
  defaultSelection,
  ECHART_TYPES,
  echartType,
  isChartNumber,
  isMetricColumn,
  pruneSelection,
  seedChartChoice,
  selectionFromSpec,
  selectionReady,
  slotsFor,
  toggleSlot,
  type ClassifiedColumns,
} from "@/lib/charts/echarts-catalog";

const columns: ClassifiedColumns = {
  dimensions: ["region", "total", "units", "size"],
  metrics: ["total", "units", "size"],
};

describe("the type list", () => {
  test("names the thirteen chart types and nothing else", () => {
    expect(ECHART_TYPES.map((type) => type.label)).toEqual([
      "Line",
      "Bar",
      "Scatter",
      "Geo",
      "Candlestick",
      "Radar",
      "Box Plot",
      "Heatmap",
      "Graph",
      "Treemap",
      "Sankey",
      "Funnel",
      "Gauge",
    ]);
    expect(echartType("line")?.label).toBe("Line");
    expect(echartType("missing")).toBeNull();
    for (const type of ECHART_TYPES) expect(type.variations.length).toBeGreaterThan(0);
  });

  test("a variation can require an optional shelf and can add one", () => {
    const points = slotsFor("geo", "points");
    const bubbles = slotsFor("geo", "bubbles");
    expect(points?.find((slot) => slot.id === "value")?.required).toBe(false);
    expect(bubbles?.find((slot) => slot.id === "value")?.required).toBe(true);
    expect(slotsFor("scatter", "bubble")?.map((slot) => slot.id)).toEqual(["x", "y", "series", "size"]);
    expect(slotsFor("line", "nope")).toBeNull();
    expect(slotsFor("nope", "basic")).toBeNull();
  });
});

describe("column classification", () => {
  test("a finite number and numeric text count, and blanks and non-finite values do not", () => {
    expect(isChartNumber(1)).toBe(true);
    expect(isChartNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isChartNumber(" 12 ")).toBe(true);
    expect(isChartNumber("")).toBe(false);
    expect(isChartNumber("  ")).toBe(false);
    expect(isChartNumber("NaN")).toBe(false);
    expect(isChartNumber(null)).toBe(false);
  });

  test("a metric needs more than 80% of its filled cells to be finite numbers", () => {
    expect(isMetricColumn([null, undefined])).toBe(false);
    expect(isMetricColumn([1, 2, 3, 4, "x"])).toBe(false);
    expect(isMetricColumn([1, 2, 3, 4, 5, "x"])).toBe(true);
  });

  test("every result field is a dimension, and a withheld column is not a metric", () => {
    const rows = [
      { region: "east", total: 1, salary: 10, extra: 9 },
      { region: "west", total: 2, salary: 20 },
    ];
    expect(classifyColumns(["region", "total", "salary"], rows, new Set(["salary"]))).toEqual({
      dimensions: ["region", "total", "salary"],
      metrics: ["total"],
    });
  });
});

describe("shelves", () => {
  test("starts from the first unused columns, and leaves optional shelves empty", () => {
    expect(defaultSelection("missing", "basic", columns)).toEqual({});
    expect(defaultSelection("line", "basic", columns)).toEqual({ category: ["region"], values: ["total"] });
    expect(defaultSelection("radar", "basic", columns).axes).toEqual(["total", "units", "size"]);
    expect(defaultSelection("radar", "basic", columns).series).toEqual([]);
    expect(defaultSelection("scatter", "bubble", columns).size).toEqual(["size"]);
    const two = { dimensions: ["a", "b"], metrics: ["a", "b"] };
    expect(defaultSelection("scatter", "bubble", two).size).toEqual([]);
  });

  test("drops a column the result does not offer", () => {
    expect(pruneSelection("missing", "basic", columns, { category: ["region"] })).toEqual({});
    expect(pruneSelection("line", "basic", columns, { category: ["region", "nope"], values: ["total"] })).toEqual({
      category: ["region"],
      values: ["total"],
    });
  });

  test("selects, replaces and clears only a column that shelf can use", () => {
    const start = defaultSelection("line", "basic", columns);
    expect(toggleSlot("line", "missing", columns, start, "category", "region")).toBe(start);
    expect(toggleSlot("line", "basic", columns, start, "nope", "region")).toBe(start);
    expect(toggleSlot("line", "basic", columns, start, "category", "nope")).toBe(start);
    expect(toggleSlot("line", "basic", columns, start, "values", "units").values).toEqual(["total", "units"]);
    expect(
      toggleSlot("line", "basic", columns, { ...start, values: ["total", "units"] }, "values", "total").values,
    ).toEqual(["units"]);
    expect(toggleSlot("line", "basic", columns, start, "category", "total").category).toEqual(["total"]);
    expect(toggleSlot("line", "basic", columns, start, "category", "region").category).toEqual([]);
  });

  test("is ready only when every required shelf has a column", () => {
    expect(selectionReady("missing", "basic", {})).toBe(false);
    expect(selectionReady("line", "basic", { category: ["region"], values: [] })).toBe(false);
    expect(selectionReady("line", "basic", defaultSelection("line", "basic", columns))).toBe(true);
  });
});

describe("a composed answer", () => {
  test("maps the chart types this tab can draw", () => {
    expect(chartChoiceFromSpec(null)).toBeNull();
    expect(chartChoiceFromSpec({ type: "pie" })).toBeNull();
    expect(chartChoiceFromSpec({ type: "stacked-bar" })).toEqual({ typeId: "bar", variationId: "stacked" });
    expect(chartChoiceFromSpec({ type: "area" })).toEqual({ typeId: "line", variationId: "area" });
    expect(chartChoiceFromSpec({ type: "line" })).toEqual({ typeId: "line", variationId: "basic" });
    expect(chartChoiceFromSpec({ type: "scatter" })).toEqual({ typeId: "scatter", variationId: "basic" });
    expect(chartChoiceFromSpec({ type: "bar" })).toEqual({ typeId: "bar", variationId: "basic" });
  });

  test("keeps the shelves only when the named columns are in the result", () => {
    const spec = { x: "total", y: ["units", "missing"] };
    expect(selectionFromSpec("scatter", { x: "total", y: [] }, columns)).toBeNull();
    expect(selectionFromSpec("scatter", { x: "region", y: ["units"] }, columns)).toBeNull();
    expect(selectionFromSpec("scatter", { x: "total", y: ["region"] }, columns)).toBeNull();
    expect(selectionFromSpec("scatter", spec, columns)).toEqual({ x: ["total"], y: ["units"], series: [] });
    expect(selectionFromSpec("funnel", spec, columns)).toBeNull();
    expect(selectionFromSpec("line", { x: "missing", y: ["units"] }, columns)).toBeNull();
    expect(selectionFromSpec("line", { x: "region", y: ["missing"] }, columns)).toBeNull();
    expect(selectionFromSpec("bar", spec, columns)).toEqual({ category: ["total"], values: ["units"] });
  });

  test("opens nothing when the answer does not fit these columns", () => {
    expect(seedChartChoice(null, columns)).toEqual({ typeId: null, variationId: null, selection: {} });
    expect(seedChartChoice({ type: "pie", x: "region", y: ["total"] }, columns)).toEqual({
      typeId: null,
      variationId: null,
      selection: {},
    });
    expect(seedChartChoice({ type: "bar", x: "missing", y: ["total"] }, columns)).toEqual({
      typeId: null,
      variationId: null,
      selection: {},
    });
    expect(seedChartChoice({ type: "stacked-bar", x: "region", y: ["total"] }, columns)).toEqual({
      typeId: "bar",
      variationId: "stacked",
      selection: { category: ["region"], values: ["total"] },
    });
  });
});
