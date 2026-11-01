import { describe, expect, test } from "bun:test";
import { chartTheme, type ChartTheme } from "@/lib/charts/palette";
import {
  buildChartOption,
  chartLabel,
  pointSize,
  watchChartSize,
  WORLD_MAP_NAME,
  type BuiltChart,
  type ChartBuildInput,
} from "@/lib/charts/echarts-option";

const theme = chartTheme("light");

function draw(
  input: Partial<ChartBuildInput> & Pick<ChartBuildInput, "typeId" | "variationId" | "rows" | "selection">,
): BuiltChart | null {
  return buildChartOption({ theme, ...input });
}

function must(chart: BuiltChart | null): BuiltChart {
  if (chart === null) throw new Error("expected a chart");
  return chart;
}

function seriesOf(chart: BuiltChart | null): Record<string, unknown>[] {
  const series = must(chart).option.series;
  return Array.isArray(series) ? (series as Record<string, unknown>[]) : [];
}

function part<T>(chart: BuiltChart | null, key: string): T {
  return must(chart).option[key] as T;
}

const emptyTheme: ChartTheme = { series: [], grid: "#111", axis: "#222", ink: "#fff", exportBackground: "#000" };

describe("labels", () => {
  test("formats each kind of cell, and a mask replaces the raw value", () => {
    expect(chartLabel("east", "region", () => "masked")).toBe("masked");
    expect(chartLabel(null, "region")).toBe("(null)");
    expect(chartLabel(undefined, "region")).toBe("(null)");
    expect(chartLabel("east", "region")).toBe("east");
    expect(chartLabel(12, "region")).toBe("12");
    expect(chartLabel(Number.NaN, "region")).toBe("NaN");
    expect(chartLabel(new Date("2026-01-02T00:00:00.000Z"), "region")).toBe("2026-01-02T00:00:00.000Z");
    expect(chartLabel(new Date("not-a-date"), "region")).toBe("Invalid Date");
    expect(chartLabel({ a: 1 }, "region")).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(chartLabel(circular, "region")).toBe("[object Object]");
    expect(chartLabel(true, "region")).toBe("true");
  });

  test("sizes a bubble from its third value", () => {
    expect(pointSize([0, 0, 0])).toBe(6);
    expect(pointSize([0, 0, 100])).toBe(40);
    expect(pointSize([0, 0, 10000])).toBe(48);
    expect(pointSize([1, 2])).toBe(6);
    expect(pointSize(9)).toBe(12);
    expect(pointSize("x")).toBe(6);
  });
});

describe("line and bar", () => {
  const rows = [
    { region: "east", total: 1, units: "2" },
    { region: "east", total: null, units: "nope" },
    { region: "west", total: Number.POSITIVE_INFINITY, units: 3 },
  ];

  test("leaves a non-finite cell as a gap and sums the finite ones", () => {
    const chart = draw({
      typeId: "line",
      variationId: "basic",
      rows,
      selection: { category: ["region"], values: ["total", "units"] },
    });
    expect(seriesOf(chart).map((series) => series.data)).toEqual([
      [1, null],
      [2, 3],
    ]);
    expect(draw({ typeId: "line", variationId: "basic", rows, selection: { values: ["total"] } })).toBeNull();
    expect(
      draw({ typeId: "line", variationId: "basic", rows, selection: { category: ["region"], values: [] } }),
    ).toBeNull();
    expect(draw({ typeId: "nope", variationId: "basic", rows, selection: {} })).toBeNull();
    expect(
      draw({ typeId: "line", variationId: "nope", rows, selection: { category: ["region"], values: ["total"] } }),
    ).toBeNull();
  });

  test("each line variation sets its own series flags", () => {
    const selection = { category: ["region"], values: ["total"] };
    const flags = (variationId: string) => seriesOf(draw({ typeId: "line", variationId, rows, selection }))[0];
    expect(flags("basic")?.smooth).toBeUndefined();
    expect(flags("smooth")?.smooth).toBe(true);
    expect(flags("step")?.step).toBe("end");
    expect(flags("area")?.areaStyle).toEqual({});
    expect(flags("stacked")?.stack).toBe("total");
    const stackedArea = flags("stacked-area");
    expect(stackedArea?.stack).toBe("total");
    expect(stackedArea?.areaStyle).toEqual({});
    expect(flags("smooth-area")?.smooth).toBe(true);
    expect(flags("smooth-area")?.areaStyle).toEqual({});
    expect(flags("dashed")?.lineStyle).toEqual({ type: "dashed" });
    expect(flags("marker")?.symbolSize).toBe(8);
  });

  test("a title is title.text and makes room under the legend", () => {
    const chart = draw({
      typeId: "bar",
      variationId: "basic",
      rows,
      selection: { category: ["region"], values: ["total"] },
      title: "Revenue",
    });
    expect(part<{ text: string }>(chart, "title").text).toBe("Revenue");
    expect(part<{ top: number }>(chart, "legend").top).toBe(28);
    expect(part<{ top: number }>(chart, "grid").top).toBeGreaterThanOrEqual(64);
    const untitled = draw({
      typeId: "bar",
      variationId: "basic",
      rows,
      selection: { category: ["region"], values: ["total"] },
    });
    expect(part<{ text: string }>(untitled, "title").text).toBe("");
    expect(part<{ top: number }>(untitled, "legend").top).toBe(4);
  });

  test("bar variations stack and turn the category axis sideways", () => {
    const selection = { category: ["region"], values: ["total"] };
    const chart = (variationId: string) => draw({ typeId: "bar", variationId, rows, selection });
    expect(seriesOf(chart("stacked"))[0]?.stack).toBe("total");
    expect(part<{ type: string }>(chart("horizontal"), "xAxis").type).toBe("value");
    expect(part<{ type: string }>(chart("horizontal"), "yAxis").type).toBe("category");
    expect(seriesOf(chart("stacked-horizontal"))[0]?.stack).toBe("total");
    expect(part<{ type: string }>(chart("basic"), "xAxis").type).toBe("category");
    expect(seriesOf(chart("rounded"))[0]?.itemStyle).toEqual({ borderRadius: [4, 4, 0, 0] });
    expect(seriesOf(chart("background"))[0]?.showBackground).toBe(true);
    const shares = draw({
      typeId: "bar",
      variationId: "percent",
      rows: [
        { region: "east", total: 2, blank: null },
        { region: "zero", total: 0, blank: 0 },
        { region: "gap", total: null, blank: 5 },
      ],
      selection: { category: ["region"], values: ["total", "blank"] },
    });
    expect(seriesOf(shares).map((series) => series.data)).toEqual([
      [100, null, null],
      [null, null, 100],
    ]);
    expect(seriesOf(shares)[0]?.stack).toBe("total");
  });

  test("says when categories or metrics were cut, and masks a dimension", () => {
    const many = Array.from({ length: 3 }, (_, index) => ({ region: `r${index}`, a: index, b: index }));
    const chart = draw({
      typeId: "bar",
      variationId: "basic",
      rows: many,
      selection: { category: ["region"], values: ["a", "b"] },
      categoryCap: 1,
      seriesCap: 1,
      mask: () => "hidden",
    });
    expect(chart?.notes).toEqual(["Showing the first 1 of 3 categories.", "Showing the first 1 of 2 metrics."]);
    expect(part<{ data: string[] }>(chart, "xAxis").data).toEqual(["hidden"]);
  });

  test("uses the dark theme when none is passed", () => {
    const chart = buildChartOption({
      typeId: "line",
      variationId: "basic",
      rows: [{ region: "east", total: 1 }],
      selection: { category: ["region"], values: ["total"] },
    });
    expect(chart?.option.color).toEqual([...chartTheme("dark").series]);
  });

  test("puts a requested colour first and drops that colour from the rest of the palette", () => {
    const rows = [{ region: "east", total: 1 }];
    const selection = { category: ["region"], values: ["total"] };
    const painted = buildChartOption({
      typeId: "line",
      variationId: "basic",
      rows,
      selection,
      color: "#E66767",
    });
    const palette = chartTheme("dark").series.filter((item) => item.toLowerCase() !== "#e66767");
    expect(painted?.option.color).toEqual(["#E66767", ...palette]);
    const blank = buildChartOption({ typeId: "line", variationId: "basic", rows, selection, color: "" });
    expect(blank?.option.color).toEqual([...chartTheme("dark").series]);
    const absent = buildChartOption({ typeId: "line", variationId: "basic", rows, selection, color: null });
    expect(absent?.option.color).toEqual([...chartTheme("dark").series]);
  });
});

describe("scatter and geo", () => {
  test("skips a point that is not finite and can split by a series column", () => {
    const rows = [
      { x: 1, y: 2, kind: "a" },
      { x: "nope", y: 3, kind: "a" },
      { x: 4, y: null, kind: "b" },
    ];
    expect(draw({ typeId: "scatter", variationId: "basic", rows, selection: { y: ["y"] } })).toBeNull();
    expect(
      draw({ typeId: "scatter", variationId: "basic", rows: [{ x: "nope", y: 1 }], selection: { x: ["x"], y: ["y"] } }),
    ).toBeNull();
    const chart = draw({
      typeId: "scatter",
      variationId: "basic",
      rows,
      selection: { x: ["x"], y: ["y"], series: ["kind"] },
    });
    expect(seriesOf(chart)).toEqual([{ name: "a", type: "scatter", data: [[1, 2]] }]);
  });

  test("a bubble needs a finite size, and a cap says what was left out", () => {
    const rows = [
      { x: 1, y: 2, size: 9 },
      { x: 2, y: 3, size: null },
      { x: 3, y: 4, size: 16 },
    ];
    const chart = draw({
      typeId: "scatter",
      variationId: "bubble",
      rows,
      selection: { x: ["x"], y: ["y"], size: ["size"] },
      categoryCap: 1,
    });
    const series = seriesOf(chart);
    expect(series[0]?.data).toEqual([[1, 2, 9]]);
    expect(chart?.notes[0]).toContain("1 points are not drawn");
    expect(typeof series[0]?.symbolSize).toBe("function");
    const dropped = draw({
      typeId: "scatter",
      variationId: "basic",
      rows: [
        { x: 1, y: 1, kind: "a" },
        { x: 2, y: 2, kind: "b" },
      ],
      selection: { x: ["x"], y: ["y"], series: ["kind"] },
      seriesCap: 1,
    });
    expect(dropped?.notes[0]).toBe("Showing the first 1 of 2 series.");
    const ripple = draw({
      typeId: "scatter",
      variationId: "ripple",
      rows: [{ x: 1, y: 2 }],
      selection: { x: ["x"], y: ["y"] },
    });
    expect(seriesOf(ripple)[0]?.type).toBe("effectScatter");
    const diamond = draw({
      typeId: "scatter",
      variationId: "diamond",
      rows: [{ x: 1, y: 2 }],
      selection: { x: ["x"], y: ["y"] },
    });
    expect(seriesOf(diamond)[0]?.symbol).toBe("diamond");
    const connected = draw({
      typeId: "scatter",
      variationId: "connected",
      rows: [{ x: 1, y: 2 }],
      selection: { x: ["x"], y: ["y"] },
    });
    expect(seriesOf(connected).map((series) => series.type)).toEqual(["scatter", "line"]);
  });

  test("plots longitude and latitude, and bubbles skip a row without a value", () => {
    const rows = [
      { lon: 1, lat: 2, value: 3 },
      { lon: "x", lat: 2, value: 4 },
      { lon: 5, lat: 6, value: null },
    ];
    expect(draw({ typeId: "geo", variationId: "points", rows, selection: { latitude: ["lat"] } })).toBeNull();
    expect(
      draw({
        typeId: "geo",
        variationId: "points",
        rows: [{ lon: "x", lat: "y" }],
        selection: { longitude: ["lon"], latitude: ["lat"] },
      }),
    ).toBeNull();
    const points = draw({
      typeId: "geo",
      variationId: "points",
      rows,
      selection: { longitude: ["lon"], latitude: ["lat"], value: ["value"] },
      categoryCap: 1,
    });
    expect(part<{ map: string }>(points, "geo").map).toBe(WORLD_MAP_NAME);
    expect(seriesOf(points)[0]?.data).toEqual([{ name: "3", value: [1, 2, 3] }]);
    expect(points?.notes[0]).toContain("of 2 points");
    const bare = draw({
      typeId: "geo",
      variationId: "points",
      rows: [{ lon: 1, lat: 2 }],
      selection: { longitude: ["lon"], latitude: ["lat"] },
    });
    expect(seriesOf(bare)[0]?.data).toEqual([{ name: "", value: [1, 2] }]);
    const bubbles = draw({
      typeId: "geo",
      variationId: "bubbles",
      rows,
      selection: { longitude: ["lon"], latitude: ["lat"], value: ["value"] },
    });
    expect(seriesOf(bubbles)[0]?.data).toEqual([{ name: "3", value: [1, 2, 3] }]);
    expect(seriesOf(bubbles)[0]?.symbolSize).toBe(pointSize);
    expect(
      draw({
        typeId: "geo",
        variationId: "heat",
        rows: [{ lon: 1, lat: 2, value: null }],
        selection: { longitude: ["lon"], latitude: ["lat"], value: ["value"] },
      }),
    ).toBeNull();
    const heat = draw({
      typeId: "geo",
      variationId: "heat",
      rows,
      selection: { longitude: ["lon"], latitude: ["lat"], value: ["value"] },
      theme: emptyTheme,
    });
    expect(seriesOf(heat)[0]?.type).toBe("heatmap");
    expect(part<{ min: number }>(heat, "visualMap").min).toBe(3);
    const ripple = draw({
      typeId: "geo",
      variationId: "ripple",
      rows: [{ lon: 1, lat: 2 }],
      selection: { longitude: ["lon"], latitude: ["lat"] },
    });
    expect(seriesOf(ripple)[0]?.type).toBe("effectScatter");
    const labeled = draw({
      typeId: "geo",
      variationId: "labeled",
      rows: [{ lon: 1, lat: 2 }],
      selection: { longitude: ["lon"], latitude: ["lat"] },
    });
    expect(seriesOf(labeled)[0]?.label).toEqual({ show: true, color: theme.ink });
  });
});

describe("candlestick, radar and box plot", () => {
  test("builds a candle from the first open, last close and the extremes", () => {
    const rows = [
      { day: "mon", open: 1, close: 2, low: 0, high: 3 },
      { day: "mon", open: 9, close: 4, low: null, high: 8 },
      { day: "tue", open: null, close: 1, low: 1, high: 1 },
      { day: "wed", open: 2, close: 3, low: 1, high: 4 },
    ];
    const selection = { time: ["day"], open: ["open"], close: ["close"], low: ["low"], high: ["high"] };
    expect(draw({ typeId: "candlestick", variationId: "basic", rows, selection: { time: ["day"] } })).toBeNull();
    expect(
      draw({
        typeId: "candlestick",
        variationId: "basic",
        rows: [{ day: "tue", open: null, close: 1, low: 1, high: 1 }],
        selection,
      }),
    ).toBeNull();
    const chart = draw({ typeId: "candlestick", variationId: "average", rows, selection, categoryCap: 2 });
    expect(seriesOf(chart)[0]?.data).toEqual([[1, 4, 0, 8]]);
    expect(seriesOf(chart)[1]?.data).toEqual([4]);
    expect(chart?.notes[0]).toContain("of 3 categories");
    const plain = draw({ typeId: "candlestick", variationId: "basic", rows: rows.slice(0, 2), selection });
    expect(seriesOf(plain)).toHaveLength(1);
    expect(draw({ typeId: "candlestick", variationId: "volume", rows, selection })).toBeNull();
    const withVolume = draw({
      typeId: "candlestick",
      variationId: "average-volume",
      rows: [
        { day: "mon", open: 1, close: 2, low: 0, high: 3, volume: null },
        { day: "tue", open: 2, close: 3, low: 1, high: 4, volume: 6 },
      ],
      selection: { ...selection, volume: ["volume"] },
    });
    expect(seriesOf(withVolume).map((series) => series.type)).toEqual(["candlestick", "line", "bar"]);
    expect(seriesOf(withVolume)[2]?.data).toEqual([0, 6]);
    const themed = draw({ typeId: "candlestick", variationId: "themed", rows: rows.slice(0, 1), selection });
    expect(seriesOf(themed)[0]?.itemStyle).toEqual({
      color: theme.series[0],
      color0: theme.series[1],
      borderColor: theme.series[0],
      borderColor0: theme.series[1],
    });
    const bare = draw({
      typeId: "candlestick",
      variationId: "themed",
      rows: rows.slice(0, 1),
      selection,
      theme: emptyTheme,
    });
    expect(seriesOf(bare)[0]?.itemStyle).toEqual({
      color: "#fff",
      color0: "#222",
      borderColor: "#fff",
      borderColor0: "#222",
    });
  });

  test("radar uses zero for a missing spoke and can fill the shape", () => {
    expect(draw({ typeId: "radar", variationId: "basic", rows: [], selection: { axes: [] } })).toBeNull();
    const rows = [
      { kind: "a", total: 2, units: null },
      { kind: "b", total: null, units: null },
    ];
    const chart = draw({
      typeId: "radar",
      variationId: "filled",
      rows,
      selection: { axes: ["total", "units"], series: ["kind"] },
    });
    expect(seriesOf(chart)[0]?.areaStyle).toEqual({});
    const spoke = seriesOf(chart)[0]?.data as { value: number[] }[] | undefined;
    expect(spoke?.[0]?.value).toEqual([2, 0]);
    expect(part<{ indicator: { max: number }[] }>(chart, "radar").indicator[1]?.max).toBe(1);
    const capped = draw({
      typeId: "radar",
      variationId: "basic",
      rows,
      selection: { axes: ["total"], series: ["kind"] },
      seriesCap: 1,
    });
    expect(capped?.notes[0]).toBe("Showing the first 1 of 2 series.");
    expect(seriesOf(capped)[0]?.areaStyle).toBeUndefined();
    const all = draw({ typeId: "radar", variationId: "basic", rows, selection: { axes: ["total"] } });
    const allData = seriesOf(all)[0]?.data as { name: string }[] | undefined;
    expect(allData?.[0]?.name).toBe("All");
    const round = draw({
      typeId: "radar",
      variationId: "circular-filled",
      rows,
      selection: { axes: ["total"] },
    });
    expect(part<{ shape: string }>(round, "radar").shape).toBe("circle");
    expect(seriesOf(round)[0]?.areaStyle).toEqual({});
    const outline = draw({ typeId: "radar", variationId: "circular", rows, selection: { axes: ["total"] } });
    expect(seriesOf(outline)[0]?.areaStyle).toBeUndefined();
    const symbols = draw({ typeId: "radar", variationId: "symbols", rows, selection: { axes: ["total"] } });
    expect(seriesOf(symbols)[0]?.symbolSize).toBe(6);
  });

  test("box plot uses the five-number summary and can lie on its side", () => {
    expect(draw({ typeId: "boxplot", variationId: "vertical", rows: [], selection: { group: ["g"] } })).toBeNull();
    const rows = [
      { g: "a", v: 1 },
      { g: "a", v: 3 },
      { g: "b", v: null },
      { g: "c", v: 4 },
      { g: "d", v: 8 },
    ];
    expect(
      draw({
        typeId: "boxplot",
        variationId: "vertical",
        rows: [{ g: "b", v: null }],
        selection: { group: ["g"], values: ["v"] },
      }),
    ).toBeNull();
    const chart = draw({
      typeId: "boxplot",
      variationId: "horizontal",
      rows,
      selection: { group: ["g"], values: ["v"] },
      categoryCap: 2,
    });
    expect(part<{ type: string }>(chart, "yAxis").type).toBe("category");
    expect(seriesOf(chart)[0]?.data).toEqual([
      [1, 1.5, 2, 2.5, 3],
      [4, 4, 4, 4, 4],
    ]);
    expect(chart?.notes[0]).toContain("of 4 categories");
    const upright = draw({
      typeId: "boxplot",
      variationId: "vertical",
      rows: rows.slice(0, 2),
      selection: { group: ["g"], values: ["v"] },
    });
    expect(part<{ type: string }>(upright, "xAxis").type).toBe("category");
    expect(upright?.notes).toEqual([]);
    const marked = draw({
      typeId: "boxplot",
      variationId: "outliers",
      rows: [
        { g: "a", v: 1 },
        { g: "a", v: 2 },
        { g: "a", v: 3 },
        { g: "a", v: 4 },
        { g: "a", v: 100 },
        { g: "b", v: 1 },
        { g: "b", v: 2 },
      ],
      selection: { group: ["g"], values: ["v"] },
    });
    expect(seriesOf(marked)[1]?.data).toEqual([[0, 100]]);
    const sideways = draw({
      typeId: "boxplot",
      variationId: "outliers-horizontal",
      rows: [
        { g: "a", v: 1 },
        { g: "a", v: 2 },
        { g: "a", v: 3 },
        { g: "a", v: 4 },
        { g: "a", v: 100 },
      ],
      selection: { group: ["g"], values: ["v"] },
    });
    expect(part<{ type: string }>(sideways, "yAxis").type).toBe("category");
    expect(seriesOf(sideways)[1]?.data).toEqual([[100, 0]]);
    const points = draw({
      typeId: "boxplot",
      variationId: "points",
      rows: rows.slice(0, 2),
      selection: { group: ["g"], values: ["v"] },
    });
    expect(seriesOf(points)[1]?.data).toEqual([
      [0, 1],
      [0, 3],
    ]);
  });
});

describe("heatmap, graph and treemap", () => {
  test("sums a cell and stops at the axis cap", () => {
    const rows = [
      { x: "a", y: "p", n: 1 },
      { x: "a", y: "p", n: 2 },
      { x: "a", y: "q", n: null },
      { x: "b", y: "p", n: 4 },
    ];
    expect(draw({ typeId: "heatmap", variationId: "grid", rows, selection: { x: ["x"] } })).toBeNull();
    expect(
      draw({
        typeId: "heatmap",
        variationId: "grid",
        rows: [{ x: "a", y: "p", n: null }],
        selection: { x: ["x"], y: ["y"], value: ["n"] },
      }),
    ).toBeNull();
    const chart = draw({
      typeId: "heatmap",
      variationId: "labeled",
      rows,
      selection: { x: ["x"], y: ["y"], value: ["n"] },
      heatmapCap: 1,
      theme: emptyTheme,
    });
    expect(seriesOf(chart)[0]?.data).toEqual([[0, 0, 3]]);
    expect(seriesOf(chart)[0]?.label).toEqual({ show: true, color: "#fff" });
    expect(part<{ inRange: { color: string[] } }>(chart, "visualMap").inRange.color[1]).toBe("#fff");
    expect(chart?.notes[0]).toContain("outside that grid");
    const yCap = draw({
      typeId: "heatmap",
      variationId: "grid",
      rows: [
        { x: "a", y: "p", n: 1 },
        { x: "a", y: "q", n: 2 },
      ],
      selection: { x: ["x"], y: ["y"], value: ["n"] },
      heatmapCap: 1,
    });
    expect(seriesOf(yCap)[0]?.data).toEqual([[0, 0, 1]]);
    const pieces = draw({
      typeId: "heatmap",
      variationId: "labeled-pieces",
      rows: [{ x: "a", y: "p", n: 1 }],
      selection: { x: ["x"], y: ["y"], value: ["n"] },
    });
    expect(part<{ type: string }>(pieces, "visualMap").type).toBe("piecewise");
    expect(seriesOf(pieces)[0]?.label).toEqual({ show: true, color: theme.ink });
    const diverging = draw({
      typeId: "heatmap",
      variationId: "diverging",
      rows: [{ x: "a", y: "p", n: 1 }],
      selection: { x: ["x"], y: ["y"], value: ["n"] },
      theme: emptyTheme,
    });
    expect(part<{ inRange: { color: string[] } }>(diverging, "visualMap").inRange.color).toEqual([
      "#222",
      "#111",
      "#fff",
    ]);
    const warm = draw({
      typeId: "heatmap",
      variationId: "pieces",
      rows: [{ x: "a", y: "p", n: 1 }],
      selection: { x: ["x"], y: ["y"], value: ["n"] },
    });
    expect(part<{ inRange: { color: string[] } }>(warm, "visualMap").inRange.color[1]).toBe(theme.series[0]);
  });

  test("links two different nodes and can lay them out in a circle", () => {
    const rows = [
      { source: "a", target: "a", weight: 1 },
      { source: "a", target: "b", weight: 2 },
      { source: "b", target: "c", weight: null },
    ];
    expect(draw({ typeId: "graph", variationId: "force", rows, selection: { source: ["source"] } })).toBeNull();
    expect(
      draw({
        typeId: "graph",
        variationId: "force",
        rows: [{ source: "a", target: "a" }],
        selection: { source: ["source"], target: ["target"] },
      }),
    ).toBeNull();
    const chart = draw({
      typeId: "graph",
      variationId: "circular",
      rows,
      selection: { source: ["source"], target: ["target"], weight: ["weight"] },
      nodeCap: 2,
    });
    expect(seriesOf(chart)[0]?.layout).toBe("circular");
    expect(seriesOf(chart)[0]?.links).toEqual([{ source: "a", target: "b", value: 2 }]);
    expect(chart?.notes[0]).toContain("1 links are not drawn");
    const force = draw({
      typeId: "graph",
      variationId: "force",
      rows: [{ source: "a", target: "b" }],
      selection: { source: ["source"], target: ["target"] },
    });
    expect(seriesOf(force)[0]?.layout).toBe("force");
    expect(seriesOf(force)[0]?.links).toEqual([{ source: "a", target: "b" }]);
    const curved = draw({
      typeId: "graph",
      variationId: "curved",
      rows: [{ source: "a", target: "b" }],
      selection: { source: ["source"], target: ["target"] },
    });
    expect(seriesOf(curved)[0]?.lineStyle).toEqual({ curveness: 0.3 });
    const arrows = draw({
      typeId: "graph",
      variationId: "arrows",
      rows: [{ source: "a", target: "b" }],
      selection: { source: ["source"], target: ["target"] },
    });
    expect(seriesOf(arrows)[0]?.edgeSymbol).toEqual(["none", "arrow"]);
    const labeled = draw({
      typeId: "graph",
      variationId: "labeled",
      rows: [{ source: "a", target: "b" }],
      selection: { source: ["source"], target: ["target"] },
    });
    expect(seriesOf(labeled)[0]?.edgeLabel).toEqual({ show: true, color: theme.ink });
  });

  test("nests a treemap under a parent and skips a size that is not positive", () => {
    const rows = [
      { name: "a", size: 2, parent: "root" },
      { name: "a", size: 3, parent: "root" },
      { name: "b", size: 0, parent: "root" },
      { name: "c", size: 4, parent: "other" },
    ];
    expect(draw({ typeId: "treemap", variationId: "basic", rows, selection: { name: ["name"] } })).toBeNull();
    expect(
      draw({
        typeId: "treemap",
        variationId: "basic",
        rows: [{ name: "b", size: 0 }],
        selection: { name: ["name"], size: ["size"] },
      }),
    ).toBeNull();
    const chart = draw({
      typeId: "treemap",
      variationId: "values",
      rows,
      selection: { name: ["name"], size: ["size"], parent: ["parent"] },
      categoryCap: 1,
    });
    expect(seriesOf(chart)[0]?.data).toEqual([{ name: "root", children: [{ name: "a", value: 5 }] }]);
    const label = seriesOf(chart)[0]?.label as { formatter?: string } | undefined;
    expect(label?.formatter).toBe("{b}\n{c}");
    expect(chart?.notes[0]).toContain("of 2 categories");
    const flat = draw({
      typeId: "treemap",
      variationId: "basic",
      rows,
      selection: { name: ["name"], size: ["size"] },
    });
    expect(seriesOf(flat)[0]?.data).toEqual([
      { name: "a", value: 5 },
      { name: "c", value: 4 },
    ]);
    const depth = draw({
      typeId: "treemap",
      variationId: "depth",
      rows,
      selection: { name: ["name"], size: ["size"] },
    });
    expect(seriesOf(depth)[0]?.leafDepth).toBe(1);
    const plainTiles = draw({
      typeId: "treemap",
      variationId: "plain",
      rows,
      selection: { name: ["name"], size: ["size"] },
    });
    expect(seriesOf(plainTiles)[0]?.breadcrumb).toEqual({ show: false });
    const padded = draw({
      typeId: "treemap",
      variationId: "padded",
      rows,
      selection: { name: ["name"], size: ["size"] },
    });
    expect(seriesOf(padded)[0]?.itemStyle).toEqual({ gapWidth: 4 });
  });
});

describe("sankey, funnel and gauge", () => {
  test("sums a repeated link and stands the diagram up", () => {
    const rows = [
      { source: "a", target: "a", value: 5 },
      { source: "a", target: "b", value: 2 },
      { source: "a", target: "b", value: 3 },
      { source: "b", target: "c", value: 0 },
      { source: "c", target: "d", value: 1 },
    ];
    expect(draw({ typeId: "sankey", variationId: "horizontal", rows, selection: { source: ["source"] } })).toBeNull();
    expect(
      draw({
        typeId: "sankey",
        variationId: "horizontal",
        rows: [{ source: "a", target: "a", value: 1 }],
        selection: { source: ["source"], target: ["target"], value: ["value"] },
      }),
    ).toBeNull();
    const chart = draw({
      typeId: "sankey",
      variationId: "vertical",
      rows,
      selection: { source: ["source"], target: ["target"], value: ["value"] },
      nodeCap: 2,
    });
    expect(seriesOf(chart)[0]?.orient).toBe("vertical");
    expect(seriesOf(chart)[0]?.links).toEqual([{ source: "a", target: "b", value: 5 }]);
    expect(chart?.notes[0]).toContain("not drawn");
    const flat = draw({
      typeId: "sankey",
      variationId: "horizontal",
      rows: rows.slice(0, 3),
      selection: { source: ["source"], target: ["target"], value: ["value"] },
    });
    expect(seriesOf(flat)[0]?.orient).toBe("horizontal");
    const gradient = draw({
      typeId: "sankey",
      variationId: "gradient",
      rows: rows.slice(0, 3),
      selection: { source: ["source"], target: ["target"], value: ["value"] },
    });
    expect(seriesOf(gradient)[0]?.lineStyle).toEqual({ color: "gradient" });
    const valued = draw({
      typeId: "sankey",
      variationId: "values",
      rows: [
        { source: "a", target: "b", value: 2 },
        { source: "a", target: "c", value: 3 },
      ],
      selection: { source: ["source"], target: ["target"], value: ["value"] },
    });
    expect(seriesOf(valued)[0]?.data).toEqual([
      { name: "a", value: 5 },
      { name: "b", value: 0 },
      { name: "c", value: 0 },
    ]);
    expect((seriesOf(valued)[0]?.label as { formatter?: string }).formatter).toBe("{b}\n{c}");
    const left = draw({
      typeId: "sankey",
      variationId: "left",
      rows: rows.slice(0, 3),
      selection: { source: ["source"], target: ["target"], value: ["value"] },
    });
    expect(seriesOf(left)[0]?.nodeAlign).toBe("left");
  });

  test("orders a funnel down and a pyramid up", () => {
    const rows = [
      { stage: "lead", value: 1 },
      { stage: "lead", value: 1 },
      { stage: "sale", value: 5 },
      { stage: "none", value: 0 },
    ];
    expect(draw({ typeId: "funnel", variationId: "funnel", rows, selection: { stage: ["stage"] } })).toBeNull();
    expect(
      draw({
        typeId: "funnel",
        variationId: "funnel",
        rows: [{ stage: "none", value: 0 }],
        selection: { stage: ["stage"], value: ["value"] },
      }),
    ).toBeNull();
    const funnel = draw({
      typeId: "funnel",
      variationId: "funnel",
      rows,
      selection: { stage: ["stage"], value: ["value"] },
      categoryCap: 1,
    });
    expect(seriesOf(funnel)[0]?.data).toEqual([{ name: "sale", value: 5 }]);
    expect(seriesOf(funnel)[0]?.sort).toBe("descending");
    expect(funnel?.notes[0]).toContain("of 2 categories");
    const pyramid = draw({
      typeId: "funnel",
      variationId: "pyramid",
      rows,
      selection: { stage: ["stage"], value: ["value"] },
    });
    expect(seriesOf(pyramid)[0]?.data).toEqual([
      { name: "lead", value: 2 },
      { name: "sale", value: 5 },
    ]);
    expect(seriesOf(pyramid)[0]?.sort).toBe("ascending");
    const left = draw({
      typeId: "funnel",
      variationId: "left",
      rows,
      selection: { stage: ["stage"], value: ["value"] },
    });
    expect(seriesOf(left)[0]?.funnelAlign).toBe("left");
    const right = draw({
      typeId: "funnel",
      variationId: "right",
      rows,
      selection: { stage: ["stage"], value: ["value"] },
    });
    expect(seriesOf(right)[0]?.funnelAlign).toBe("right");
    const percent = draw({
      typeId: "funnel",
      variationId: "percent",
      rows,
      selection: { stage: ["stage"], value: ["value"] },
    });
    expect((seriesOf(percent)[0]?.label as { formatter?: string }).formatter).toBe("{b}\n{d}%");
  });

  test("sums a gauge and offers a progress mark and a grade band", () => {
    const rows = [{ value: 1 }, { value: "2" }, { value: null }];
    expect(draw({ typeId: "gauge", variationId: "basic", rows, selection: {} })).toBeNull();
    expect(
      draw({ typeId: "gauge", variationId: "basic", rows: [{ value: null }], selection: { value: ["value"] } }),
    ).toBeNull();
    const basic = draw({ typeId: "gauge", variationId: "basic", rows, selection: { value: ["value"] } });
    expect(seriesOf(basic)[0]?.data).toEqual([{ name: "value", value: 3 }]);
    expect(seriesOf(basic)[0]?.progress).toBeUndefined();
    const progress = draw({ typeId: "gauge", variationId: "progress", rows, selection: { value: ["value"] } });
    expect(seriesOf(progress)[0]?.progress).toEqual({ show: true });
    const grade = draw({
      typeId: "gauge",
      variationId: "grade",
      rows,
      selection: { value: ["value"] },
      theme: emptyTheme,
    });
    expect(seriesOf(grade)[0]?.axisLine).toEqual({
      lineStyle: {
        color: [
          [0.3, "#fff"],
          [0.7, "#fff"],
          [1, "#fff"],
        ],
      },
    });
    const ring = draw({ typeId: "gauge", variationId: "ring", rows, selection: { value: ["value"] } });
    expect(seriesOf(ring)[0]?.startAngle).toBe(90);
    expect(seriesOf(ring)[0]?.endAngle).toBe(-270);
    const stage = draw({
      typeId: "gauge",
      variationId: "stage",
      rows,
      selection: { value: ["value"] },
      theme: emptyTheme,
    });
    expect(seriesOf(stage)[0]?.axisLine).toEqual({
      lineStyle: {
        color: [
          [0.2, "#fff"],
          [0.4, "#fff"],
          [0.6, "#fff"],
          [0.8, "#fff"],
          [1, "#fff"],
        ],
      },
    });
  });
});

describe("pie", () => {
  const rows = [
    { name: "east", total: 1 },
    { name: "east", total: 1 },
    { name: "west", total: 0 },
    { name: "south", total: null },
    { name: "north", total: 4 },
  ];
  const selection = { name: ["name"], value: ["total"] };

  test("sums a slice and skips a size that is not positive", () => {
    expect(draw({ typeId: "pie", variationId: "basic", rows, selection: { name: ["name"] } })).toBeNull();
    expect(
      draw({
        typeId: "pie",
        variationId: "basic",
        rows: [{ name: "west", total: 0 }],
        selection,
      }),
    ).toBeNull();
    const chart = draw({ typeId: "pie", variationId: "basic", rows, selection, categoryCap: 1 });
    expect(seriesOf(chart)[0]?.data).toEqual([{ name: "east", value: 2 }]);
    expect(seriesOf(chart)[0]?.radius).toBe("70%");
    expect(chart?.notes[0]).toContain("of 2 categories");
  });

  test("each pie option changes the series", () => {
    const chart = (variationId: string) => seriesOf(draw({ typeId: "pie", variationId, rows, selection }))[0];
    expect(chart("donut")?.radius).toEqual(["42%", "70%"]);
    expect(chart("rose")?.roseType).toBe("radius");
    expect(chart("rose")?.radius).toEqual(["8%", "70%"]);
    expect(chart("nightingale")?.roseType).toBe("area");
    expect(chart("half")?.startAngle).toBe(180);
    expect(chart("half")?.radius).toEqual(["40%", "70%"]);
    expect((chart("labeled")?.label as { formatter?: string }).formatter).toBe("{b}\n{d}%");
  });
});

describe("resize", () => {
  test("does nothing where the browser has no observer, and disconnects one where it does", () => {
    const original = globalThis.ResizeObserver;
    // The assignment is the test's stand-in for a browser that has no observer.
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const element = {} as Element;
    expect(watchChartSize(element, () => {})()).toBeUndefined();
    let resized = 0;
    let disconnected = 0;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {
        disconnected += 1;
      }
      constructor(callback: () => void) {
        callback();
      }
    } as unknown as typeof ResizeObserver;
    const stop = watchChartSize(element, () => {
      resized += 1;
    });
    stop();
    expect(resized).toBe(1);
    expect(disconnected).toBe(1);
    globalThis.ResizeObserver = original;
  });
});

describe("awkward category values", () => {
  test("groups a value JSON cannot stringify, and one it stringifies as nothing", () => {
    const box: Record<string, unknown> = {};
    box.self = box;
    const rows = [
      { region: box, total: 1 },
      { region: () => 1, total: 2 },
      { region: Symbol("s"), total: 3 },
    ];
    const chart = draw({
      typeId: "bar",
      variationId: "basic",
      rows,
      selection: { category: ["region"], values: ["total"] },
    });
    expect(part<{ data: string[] }>(chart, "xAxis").data).toHaveLength(3);
  });
});
