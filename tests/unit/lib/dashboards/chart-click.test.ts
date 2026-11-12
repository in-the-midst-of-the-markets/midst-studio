import { describe, expect, test } from "bun:test";
import { applyQueryFilters } from "@/lib/charts/query-filters";
import {
  applyChartClicks,
  chartClickFields,
  chartClickIds,
  chartClickPoint,
  chartClickText,
  chartClickValues,
  clickColumnChoices,
  clickFilterId,
  drilldownDashboard,
  mergeClickValues,
  nextChartClick,
  publishedClickFilters,
} from "@/lib/dashboards/chart-click";

const chart = {
  name: "Test",
  xAxis: "Dim",
  yAxis: ["Amount"],
  selection: { category: ["Dim"], values: ["Amount"] },
};

describe("chart click filters", () => {
  test("builds Test-Dim from the chart name and the column", () => {
    expect(clickFilterId("Test", "Dim")).toBe("Test-Dim");
    expect(clickFilterId(" Monthly Sales ", " region ")).toBe("MonthlySales-region");
    expect(clickFilterId("my_chart", "dim_1")).toBe("my_chart-dim_1");
    expect(clickFilterId("Test-Dim", "a-b")).toBe("TestDim-ab");
    expect(clickFilterId("", "Dim")).toBeNull();
    expect(clickFilterId("Test", " ")).toBeNull();
    expect(clickFilterId("2024", "Dim")).toBeNull();
    expect(clickFilterId("A".repeat(30), "B".repeat(20))).toBeNull();
  });

  test("reads the stored column, then the shelf, then the saved axes", () => {
    expect(chartClickFields(chart)).toEqual({ dimension: "Dim", metric: "Amount" });
    expect(chartClickFields({ ...chart, click: { dimension: "City", metric: "Tax" } })).toEqual({
      dimension: "City",
      metric: "Tax",
    });
    expect(chartClickFields({ ...chart, click: { dimension: "  ", metric: "" } })).toEqual({
      dimension: "Dim",
      metric: "Amount",
    });
    expect(chartClickFields({ name: "Test", xAxis: " Dim ", yAxis: ["", "Amount"] })).toEqual({
      dimension: "Dim",
      metric: "Amount",
    });
    expect(chartClickFields({ name: "Test", xAxis: " ", yAxis: [" "], selection: { x: ["X"], y: ["Y"] } })).toEqual({
      dimension: "X",
      metric: "Y",
    });
    expect(chartClickFields({ name: "Test", xAxis: "", yAxis: [] })).toEqual({ dimension: "", metric: "" });
    expect(chartClickFields({ name: "Test" })).toEqual({ dimension: "", metric: "" });
    expect(chartClickIds("Test", { dimension: "Dim", metric: "" })).toEqual({
      dimension: "Test-Dim",
      metric: null,
    });
  });

  test("reads a series click and ignores a legend click", () => {
    expect(chartClickPoint(null)).toBeNull();
    expect(chartClickPoint("click")).toBeNull();
    expect(chartClickPoint({ componentType: "legend", name: "Amount" })).toBeNull();
    expect(chartClickPoint({ componentType: "series", name: "East", value: 12 })).toEqual({
      name: "East",
      value: 12,
    });
    expect(chartClickPoint({ name: 4, data: "East" })).toEqual({ name: "", value: "East" });
    expect(chartClickPoint({ componentType: "series", name: "East" })).toEqual({ name: "East", value: undefined });
  });

  test("keeps the clicked dimension and metric as filter text", () => {
    expect(chartClickText(" East\n}")).toBe("East");
    expect(chartClickText(`x${"|".repeat(5)}`)).toBe("x");
    expect(chartClickText("z".repeat(250))).toHaveLength(200);
    expect(chartClickText(12)).toBe("12");
    expect(chartClickText(Number.POSITIVE_INFINITY)).toBe("");
    expect(chartClickText(true)).toBe("true");
    expect(chartClickText(false)).toBe("false");
    expect(chartClickText({ value: 1 })).toBe("");
    expect(chartClickValues({ name: "East", value: 12 })).toEqual({ dimension: "East", metric: "12" });
    expect(chartClickValues({ name: "", value: [1, 2] })).toEqual({ dimension: "1", metric: "2" });
    expect(chartClickValues({ name: "East", value: [1, { nope: true }, 9] })).toEqual({
      dimension: "East",
      metric: "9",
    });
    expect(chartClickValues({ name: "East", value: { value: 4 } })).toEqual({ dimension: "East", metric: "4" });
    expect(chartClickValues({ name: "", value: { value: [3, 8] } })).toEqual({ dimension: "3", metric: "8" });
    expect(chartClickValues({ name: "East", value: { value: { value: 3 } } })).toEqual({
      dimension: "East",
      metric: "",
    });
    expect(chartClickValues({ name: "", value: [{}, ""] })).toEqual({ dimension: "", metric: "" });
  });

  test("stores both ids and publishes the one the chart is set to", () => {
    const ids = chartClickIds("Test", { dimension: "Dim", metric: "Amount" });
    const current = {};
    expect(mergeClickValues(current, { dimension: null, metric: null }, { dimension: "East", metric: "12" })).toBe(
      current,
    );
    expect(mergeClickValues(current, ids, { dimension: "", metric: "" })).toBe(current);
    const stored = mergeClickValues(current, ids, { dimension: "East", metric: "12" });
    expect(stored).toEqual({ "Test-Dim": "East", "Test-Amount": "12" });
    expect(
      mergeClickValues(stored, { dimension: ids.dimension, metric: null }, { dimension: "West", metric: "" }),
    ).toEqual({
      "Test-Dim": "West",
      "Test-Amount": "12",
    });
    expect(publishedClickFilters([chart], stored)).toEqual([{ name: "Test-Dim", value: "East" }]);
    expect(publishedClickFilters([{ ...chart, click: { publish: "metric" } }], stored)).toEqual([
      { name: "Test-Amount", value: "12" },
    ]);
    expect(publishedClickFilters([chart, { ...chart, name: "Test" }], stored)).toEqual([
      { name: "Test-Dim", value: "East" },
    ]);
    expect(publishedClickFilters([{ ...chart, name: "2024" }], stored)).toEqual([]);
    expect(publishedClickFilters([chart], { "Test-Dim": "  " })).toEqual([]);
    const sql = "SELECT * FROM t WHERE dim = {{Test-Dim}} AND amount >= {{Test-Amount:0}}";
    expect(applyChartClicks(sql, [{ name: "Test-Dim", value: "East" }])).toBe(
      "SELECT * FROM t WHERE dim = {{Test-Dim:East}} AND amount >= {{Test-Amount:0}}",
    );
    expect(applyQueryFilters(applyChartClicks(sql, publishedClickFilters([chart], stored)))).toBe(
      "SELECT * FROM t WHERE dim = 'East' AND amount >= 0",
    );
    expect(applyChartClicks("SELECT 1", [{ name: "Test-Dim", value: "East" }])).toBe("SELECT 1");
  });

  test("keeps a click setup only when it says something", () => {
    expect(nextChartClick(undefined, { dimension: " City " })).toEqual({ dimension: "City" });
    expect(nextChartClick({ dimension: "City" }, { dimension: " " })).toBeUndefined();
    expect(nextChartClick(undefined, { publish: "metric", dashboardId: " other " })).toEqual({
      publish: "metric",
      dashboardId: "other",
    });
    expect(
      nextChartClick({ publish: "metric", dashboardId: "other" }, { publish: "dimension", dashboardId: "" }),
    ).toBeUndefined();
    expect(nextChartClick({ metric: "Amount" }, { publish: "dimension" })).toEqual({ metric: "Amount" });
  });

  test("opens another dashboard and stays when the target is this one or unknown", () => {
    expect(drilldownDashboard("sales", "detail", ["sales", "detail"])).toBe("detail");
    expect(drilldownDashboard("sales", " sales ", ["sales"])).toBeNull();
    expect(drilldownDashboard("sales", "", ["sales"])).toBeNull();
    expect(drilldownDashboard("sales", "missing", ["sales"])).toBeNull();
    expect(drilldownDashboard("sales", undefined, ["sales"])).toBeNull();
  });

  test("offers each column once, including the current choice", () => {
    expect(clickColumnChoices(["Dim", "Amount", "Dim"], "Dim", "")).toEqual(["Dim", "Amount"]);
    expect(clickColumnChoices([], " City ", " ")).toEqual(["City"]);
    expect(clickColumnChoices([], "", "")).toEqual([]);
  });
});
