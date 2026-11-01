import { describe, expect, test } from "bun:test";
import { applyChartTitle, chartTitleText } from "@/lib/charts/chart-title";

describe("chart title", () => {
  test("reads title text and nothing else", () => {
    expect(chartTitleText(null)).toBe("");
    expect(chartTitleText(undefined)).toBe("");
    expect(chartTitleText({ title: "Revenue" })).toBe("Revenue");
    expect(chartTitleText({ title: { text: "Revenue" } })).toBe("Revenue");
    expect(chartTitleText({ title: { text: 4 } })).toBe("");
    expect(chartTitleText({ title: [] })).toBe("");
    expect(chartTitleText({ title: null })).toBe("");
    expect(chartTitleText({})).toBe("");
  });

  test("an empty title is stored and does not move the legend", () => {
    const option = { legend: { top: 4 }, grid: { top: 40 }, textStyle: { color: "#111" } };
    const next = applyChartTitle(option, "");
    expect(next.title).toMatchObject({ text: "", textStyle: { color: "#111", fontSize: 14 } });
    expect(next.legend).toEqual({ top: 4 });
    expect(next.grid).toEqual({ top: 40 });
  });

  test("a title makes room and keeps a grid that is already low enough", () => {
    const next = applyChartTitle(
      { legend: { top: 4, type: "scroll" }, grid: { top: 80 }, textStyle: { color: "" } },
      "Revenue",
    );
    expect(next.legend).toEqual({ top: 28, type: "scroll" });
    expect(next.grid).toEqual({ top: 80 });
    expect((next.title as { textStyle: { color?: string } }).textStyle.color).toBeUndefined();
  });

  test("a title without a legend or a numeric grid top still draws", () => {
    const next = applyChartTitle({ grid: { top: "12%" }, legend: [], textStyle: [] }, "Revenue");
    expect(next.legend).toEqual([]);
    expect(next.grid).toEqual({ top: 64 });
    expect(applyChartTitle({ textStyle: null }, "Revenue").legend).toBeUndefined();
    expect(applyChartTitle({}, "Revenue").grid).toBeUndefined();
  });
});
