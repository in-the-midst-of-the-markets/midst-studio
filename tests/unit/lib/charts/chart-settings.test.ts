import "../../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { ECHART_TYPES } from "@/lib/charts/echarts-catalog";
import { buildChartOption } from "@/lib/charts/echarts-option";
import { optionForSavedChart } from "@/lib/charts/saved-chart-run";
import { chartTheme } from "@/lib/charts/palette";
import {
  CHART_FONTS,
  DEFAULT_CHART_SETTINGS,
  applyChartSettings,
  chartCategories,
  normalizeChartSettings,
  readChartSettings,
  subscribeChartSettings,
  writeChartSettings,
  type ChartSettings,
} from "@/lib/charts/chart-settings";
import type { QueryResult } from "@/lib/types";

afterEach(() => {
  localStorage.clear();
});

function tuned(
  typeId: string,
  controlId: string,
  value: boolean,
  text: Partial<ChartSettings["text"]> = {},
): ChartSettings {
  const current = DEFAULT_CHART_SETTINGS.types[typeId] ?? {};
  return {
    text: { ...DEFAULT_CHART_SETTINGS.text, ...text },
    types: {
      ...DEFAULT_CHART_SETTINGS.types,
      [typeId]: { ...current, [controlId]: value },
    },
  };
}

function optionOf(
  typeId: string,
  variationId: string,
  rows: Record<string, unknown>[],
  selection: Record<string, string[]>,
  settings?: ChartSettings,
) {
  const built = buildChartOption({ typeId, variationId, rows, selection, settings });
  if (built === null) throw new Error(`expected ${typeId} ${variationId}`);
  return built.option;
}

function seriesAt(option: Record<string, unknown>, index = 0): Record<string, unknown> {
  const series = option.series;
  if (Array.isArray(series)) return series[index] as Record<string, unknown>;
  return series as Record<string, unknown>;
}

describe("chart settings", () => {
  test("lists every chart type in picker order", () => {
    expect(chartCategories().map((category) => [category.id, category.label])).toEqual(
      ECHART_TYPES.map((type) => [type.id, type.label]),
    );
    expect(
      chartCategories()
        .find((category) => category.id === "graph")
        ?.controls.map((control) => control.id),
    ).toEqual(["labels", "edgeLabels"]);
    expect(DEFAULT_CHART_SETTINGS.text.fontFamily).toBe(CHART_FONTS[0]?.id);
    expect(DEFAULT_CHART_SETTINGS.types.graph?.labels).toBe(false);
    expect(DEFAULT_CHART_SETTINGS.types.bar?.gridlines).toBe(true);
  });

  test("keeps a usable copy and drops anything that is not a setting", () => {
    expect(normalizeChartSettings(null)).toBe(DEFAULT_CHART_SETTINGS);
    expect(normalizeChartSettings([])).toBe(DEFAULT_CHART_SETTINGS);
    expect(normalizeChartSettings({ text: "no", types: null })).toBe(DEFAULT_CHART_SETTINGS);
    expect(
      normalizeChartSettings({
        text: {
          fontFamily: "Comic Sans",
          titleFontSize: 7,
          axisFontSize: 12.5,
          labelFontSize: "12",
          legend: "yes",
        },
        types: { line: "no", missing: { labels: false }, graph: { labels: true, extra: false } },
      }),
    ).toEqual(tuned("graph", "labels", true));
    expect(normalizeChartSettings({ types: { bar: { gridlines: false } } }).types.bar?.gridlines).toBe(false);
  });

  test("reads and writes the browser copy, and ignores a write the browser refuses", () => {
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
    writeChartSettings(tuned("graph", "labels", true));
    expect(readChartSettings().types.graph?.labels).toBe(true);
    localStorage.setItem("libredb_chart_settings", "not json");
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
    localStorage.setItem("libredb_chart_settings", "null");
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
    const heard: number[] = [];
    const stop = subscribeChartSettings(() => {
      heard.push(heard.length);
    });
    writeChartSettings(tuned("bar", "gridlines", false));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "libredb_chart_settings" }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "other" }));
    stop();
    writeChartSettings(tuned("pie", "labels", false));
    expect(heard).toEqual([0, 1, 2]);
    expect(readChartSettings().types.pie?.labels).toBe(false);
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("full");
    };
    writeChartSettings(tuned("graph", "labels", true));
    localStorage.setItem = original;
    expect(readChartSettings().types.pie?.labels).toBe(false);
  });

  test("default settings leave the builder's option alone", () => {
    const rows = [{ region: "east", total: 2 }];
    const selection = { category: ["region"], values: ["total"] };
    const plain = optionOf("bar", "basic", rows, selection);
    const same = optionOf("bar", "basic", rows, selection, DEFAULT_CHART_SETTINGS);
    expect(same).toEqual(plain);
    const again = applyChartSettings(plain, "missing", "basic", DEFAULT_CHART_SETTINGS);
    expect(again).toBe(plain);
  });

  test("turns off the common marks and keeps a variation that chose otherwise", () => {
    const rows = [
      {
        source: "a",
        target: "b",
        weight: 1,
        region: "east",
        total: 2,
        x: 1,
        y: 2,
        name: "a",
        size: 3,
        stage: "one",
        value: 4,
        lon: 1,
        lat: 2,
        time: "t",
        open: 1,
        close: 2,
        low: 1,
        high: 3,
        group: "g",
      },
    ];
    const graph = optionOf(
      "graph",
      "force",
      rows,
      { source: ["source"], target: ["target"] },
      tuned("graph", "labels", true),
    );
    expect(seriesAt(graph).label).toMatchObject({ show: true });
    const edges = optionOf(
      "graph",
      "force",
      rows,
      { source: ["source"], target: ["target"] },
      tuned("graph", "edgeLabels", true),
    );
    expect(seriesAt(edges).edgeLabel).toEqual({ show: true });
    const lockedEdges = optionOf(
      "graph",
      "labeled",
      rows,
      { source: ["source"], target: ["target"] },
      tuned("graph", "edgeLabels", false),
    );
    expect(seriesAt(lockedEdges).edgeLabel).toEqual({ show: true, color: chartTheme("dark").ink });
    const bar = optionOf(
      "bar",
      "basic",
      rows,
      { category: ["region"], values: ["total"] },
      tuned("bar", "gridlines", false),
    );
    expect((bar.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
    const line = optionOf(
      "line",
      "basic",
      rows,
      { category: ["region"], values: ["total"] },
      tuned("line", "symbols", false),
    );
    expect(seriesAt(line).showSymbol).toBe(false);
    const marked = optionOf(
      "line",
      "marker",
      rows,
      { category: ["region"], values: ["total"] },
      tuned("line", "symbols", false),
    );
    expect(seriesAt(marked).showSymbol).toBe(true);
    const pie = optionOf("pie", "basic", rows, { name: ["name"], value: ["size"] }, tuned("pie", "labels", false));
    expect(seriesAt(pie).label).toMatchObject({ show: false });
    const labeledPie = optionOf(
      "pie",
      "labeled",
      rows,
      { name: ["name"], value: ["size"] },
      tuned("pie", "labels", false),
    );
    expect((seriesAt(labeledPie).label as { show?: boolean }).show).toBeUndefined();
    const scatter = optionOf("scatter", "basic", rows, { x: ["x"], y: ["y"] }, tuned("scatter", "gridlines", false));
    expect((scatter.xAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
    const geo = optionOf(
      "geo",
      "points",
      rows,
      { longitude: ["lon"], latitude: ["lat"] },
      tuned("geo", "labels", true),
    );
    expect(seriesAt(geo).label).toMatchObject({ show: true });
    const labeledGeo = optionOf(
      "geo",
      "labeled",
      rows,
      { longitude: ["lon"], latitude: ["lat"] },
      tuned("geo", "labels", false),
    );
    expect(seriesAt(labeledGeo).label).toMatchObject({ show: true });
    const candles = optionOf(
      "candlestick",
      "basic",
      rows,
      { time: ["time"], open: ["open"], close: ["close"], low: ["low"], high: ["high"] },
      tuned("candlestick", "gridlines", false),
    );
    expect((candles.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
    const radar = optionOf("radar", "basic", rows, { axes: ["total", "size"] }, tuned("radar", "labels", false));
    expect((radar.radar as { axisName: { show: boolean } }).axisName.show).toBe(false);
    const boxes = optionOf(
      "boxplot",
      "vertical",
      rows,
      { group: ["group"], values: ["total"] },
      tuned("boxplot", "gridlines", false),
    );
    expect((boxes.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
    const heat = optionOf(
      "heatmap",
      "grid",
      rows,
      { x: ["region"], y: ["name"], value: ["total"] },
      tuned("heatmap", "labels", true),
    );
    expect(seriesAt(heat).label).toMatchObject({ show: true });
    const labeledHeat = optionOf(
      "heatmap",
      "labeled-pieces",
      rows,
      { x: ["region"], y: ["name"], value: ["total"] },
      tuned("heatmap", "labels", false),
    );
    expect(seriesAt(labeledHeat).label).toMatchObject({ show: true });
    const tiles = optionOf(
      "treemap",
      "basic",
      rows,
      { name: ["name"], size: ["size"] },
      tuned("treemap", "labels", false),
    );
    expect(seriesAt(tiles).label).toMatchObject({ show: false });
    const crumbs = optionOf(
      "treemap",
      "basic",
      rows,
      { name: ["name"], size: ["size"] },
      tuned("treemap", "breadcrumb", false),
    );
    expect(seriesAt(crumbs).breadcrumb).toEqual({ show: false });
    const plainTiles = optionOf(
      "treemap",
      "plain",
      rows,
      { name: ["name"], size: ["size"] },
      tuned("treemap", "breadcrumb", true),
    );
    expect(seriesAt(plainTiles).breadcrumb).toEqual({ show: false });
    const sankey = optionOf(
      "sankey",
      "horizontal",
      rows,
      { source: ["source"], target: ["target"], value: ["weight"] },
      tuned("sankey", "labels", false),
    );
    expect(seriesAt(sankey).label).toMatchObject({ show: false });
    const funnel = optionOf(
      "funnel",
      "funnel",
      rows,
      { stage: ["stage"], value: ["value"] },
      tuned("funnel", "labels", false),
    );
    expect(seriesAt(funnel).label).toMatchObject({ show: false });
    const gauge = optionOf("gauge", "basic", rows, { value: ["value"] }, tuned("gauge", "pointer", false));
    expect(seriesAt(gauge).pointer).toEqual({ show: false });
    const quiet = optionOf("gauge", "basic", rows, { value: ["value"] }, tuned("gauge", "labels", false));
    expect(seriesAt(quiet).detail).toMatchObject({ show: false });
    const ring = optionOf("gauge", "ring", rows, { value: ["value"] }, tuned("gauge", "pointer", false));
    expect(seriesAt(ring).pointer).toMatchObject({ show: false });
    const saved = optionForSavedChart(
      { typeId: "bar", variationId: "basic", selection: { category: ["region"], values: ["total"] } },
      { rows, fields: ["region", "total"], rowCount: 1, executionTime: 1 },
      chartTheme("dark"),
      tuned("bar", "gridlines", false),
    );
    if (saved === null) throw new Error("expected a saved chart");
    expect((saved.option.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
  });

  test("sets the font and the sizes, and leaves a second pass unchanged", () => {
    const rows = [{ region: "east", total: 2 }];
    const selection = { category: ["region"], values: ["total"] };
    const styled = optionOf(
      "bar",
      "basic",
      rows,
      selection,
      tuned("bar", "gridlines", true, {
        fontFamily: "Georgia, serif",
        titleFontSize: 20,
        axisFontSize: 16,
        labelFontSize: 18,
        legend: false,
      }),
    );
    expect(styled.textStyle).toMatchObject({ fontFamily: "Georgia, serif", fontSize: 18 });
    expect((styled.title as { textStyle: { fontSize: number; fontFamily: string } }).textStyle).toMatchObject({
      fontSize: 20,
      fontFamily: "Georgia, serif",
    });
    expect((styled.legend as { show: boolean }).show).toBe(false);
    expect((styled.yAxis as { axisLabel: { fontSize: number; fontFamily: string } }).axisLabel).toMatchObject({
      fontSize: 16,
      fontFamily: "Georgia, serif",
    });
    const twice = applyChartSettings(
      styled,
      "bar",
      "basic",
      tuned("bar", "gridlines", true, {
        fontFamily: "Georgia, serif",
        titleFontSize: 20,
        axisFontSize: 16,
        labelFontSize: 18,
        legend: false,
      }),
    );
    expect(twice).toBe(styled);
    const shaped: Record<string, unknown> = {
      textStyle: [],
      title: "Revenue",
      legend: [],
      radar: { axisName: { color: "#111" } },
      xAxis: [{ axisLabel: { color: "#111" } }, null],
      yAxis: "no",
      series: [{ label: { show: false } }, { type: "bar" }, null],
    };
    const painted = applyChartSettings(
      shaped,
      "line",
      "basic",
      tuned("line", "symbols", false, { fontFamily: "Georgia, serif" }),
    );
    expect(painted).not.toBe(shaped);
    expect(painted.textStyle).toEqual({ fontFamily: "Georgia, serif" });
    expect(painted.title).toBe("Revenue");
    expect((painted.legend as { textStyle?: unknown }).textStyle).toBeUndefined();
    expect((painted.series as { showSymbol?: boolean }[])[1]?.showSymbol).toBeUndefined();
    const hidden = applyChartSettings(
      { legend: { show: false }, series: { type: "line", showSymbol: false }, radar: "no" },
      "line",
      "basic",
      tuned("line", "symbols", false, { legend: false }),
    );
    expect(hidden).toEqual({ legend: { show: false }, series: { type: "line", showSymbol: false }, radar: "no" });
    const grid = applyChartSettings(
      { xAxis: [{ splitLine: { show: false } }, "skip"], series: 1 },
      "bar",
      "basic",
      tuned("bar", "gridlines", false),
    );
    expect(grid).toEqual({ xAxis: [{ splitLine: { show: false } }, "skip"], series: 1 });
    const bare = applyChartSettings({ series: 1 }, "bar", "basic", tuned("bar", "gridlines", true, { legend: false }));
    expect(bare.legend).toEqual({ show: false });
    const unnamed = applyChartSettings({ radar: {} }, "radar", "basic", tuned("radar", "labels", false));
    expect((unnamed.radar as { axisName: { show: boolean } }).axisName.show).toBe(false);
    const onlySize = optionOf(
      "radar",
      "basic",
      [{ total: 1, size: 2 }],
      { axes: ["total", "size"] },
      tuned("radar", "labels", true, { axisFontSize: 16 }),
    );
    expect((onlySize.radar as { axisName: { fontSize: number } }).axisName.fontSize).toBe(16);
  });
});
