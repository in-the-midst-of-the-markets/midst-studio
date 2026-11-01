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
  });

  test("bar variations stack and turn the category axis sideways", () => {
    const selection = { category: ["region"], values: ["total"] };
    const chart = (variationId: string) => draw({ typeId: "bar", variationId, rows, selection });
    expect(seriesOf(chart("stacked"))[0]?.stack).toBe("total");
    expect(part<{ type: string }>(chart("horizontal"), "xAxis").type).toBe("value");
    expect(part<{ type: string }>(chart("horizontal"), "yAxis").type).toBe("category");
    expect(seriesOf(chart("stacked-horizontal"))[0]?.stack).toBe("total");
    expect(part<{ type: string }>(chart("basic"), "xAxis").type).toBe("category");
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
