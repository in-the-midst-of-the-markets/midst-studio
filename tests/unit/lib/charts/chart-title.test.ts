import { describe, expect, test } from "bun:test";
import { applyChartTitle, chartTitleStyle, chartTitleText, omitDrawnChartTitle } from "@/lib/charts/chart-title";

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

  test("title textStyle sets the heading's font, color, and weight", () => {
    expect(chartTitleStyle(null)).toEqual({});
    expect(chartTitleStyle(undefined)).toEqual({});
    expect(chartTitleStyle({ title: "Revenue" })).toEqual({});
    expect(chartTitleStyle({ title: { textStyle: [] } })).toEqual({});
    expect(chartTitleStyle({ title: { text: "Revenue" } })).toEqual({});
    expect(
      chartTitleStyle({
        title: {
          textStyle: {
            fontSize: 0,
            fontWeight: Number.NaN,
            color: "  ",
            fontFamily: "",
            fontStyle: "bold",
          },
        },
      }),
    ).toEqual({});
    expect(
      chartTitleStyle({
        title: {
          textStyle: {
            fontSize: 32,
            fontWeight: 700,
            color: "#112233",
            fontFamily: "Georgia",
            fontStyle: "italic",
          },
        },
      }),
    ).toEqual({
      fontSize: 32,
      fontWeight: 700,
      color: "#112233",
      fontFamily: "Georgia",
      fontStyle: "italic",
    });
    expect(chartTitleStyle({ title: { textStyle: { fontWeight: " bold ", fontStyle: "oblique" } } })).toEqual({
      fontWeight: " bold ",
      fontStyle: "oblique",
    });
    expect(chartTitleStyle({ title: { textStyle: { fontStyle: "normal" } } }).fontStyle).toBe("normal");
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

  test("a dashboard plot drops its inner title and takes back that room", () => {
    const untitled = { legend: { top: 4, type: "scroll" }, grid: { top: 40, left: 16 } };
    const drawn = omitDrawnChartTitle(
      {
        title: { text: "Daily_Active_Users by date" },
        legend: { top: 28, type: "scroll" },
        grid: { top: 64, left: 16 },
      },
      untitled,
    );
    expect(drawn.title).toBeUndefined();
    expect(drawn.legend).toEqual({ top: 4, type: "scroll" });
    expect(drawn.grid).toEqual({ top: 40, left: 16 });
    expect(omitDrawnChartTitle({ title: { text: "A" }, legend: [], grid: "full" }, {})).toEqual({
      legend: [],
      grid: "full",
    });
    expect(omitDrawnChartTitle({ legend: { type: "scroll" }, grid: { left: 8 } }, { legend: {}, grid: {} })).toEqual({
      legend: { type: "scroll" },
      grid: { left: 8 },
    });
  });

  test("a title without a legend or a numeric grid top still draws", () => {
    const next = applyChartTitle({ grid: { top: "12%" }, legend: [], textStyle: [] }, "Revenue");
    expect(next.legend).toEqual([]);
    expect(next.grid).toEqual({ top: 64 });
    expect(applyChartTitle({ textStyle: null }, "Revenue").legend).toBeUndefined();
    expect(applyChartTitle({}, "Revenue").grid).toBeUndefined();
  });
});
