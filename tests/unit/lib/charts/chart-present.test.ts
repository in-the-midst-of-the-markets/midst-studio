import { describe, expect, test } from "bun:test";
import { presentChartOption } from "@/lib/charts/chart-present";

const untitled = {
  legend: { top: 4 },
  grid: { top: 40 },
};

describe("presentChartOption", () => {
  test("draws a title from chart code and leaves an empty title off the plot", () => {
    const titled = presentChartOption(
      { title: { text: "By region", left: "center" }, legend: { top: 4 }, grid: { top: 40 } },
      untitled,
    );
    expect(titled.title).toEqual({ text: "By region", left: "center" });
    expect((titled.legend as { top: number }).top).toBe(28);
    expect((titled.grid as { top: number }).top).toBe(64);

    const named = presentChartOption({ title: "Revenue", legend: { top: 4, type: "scroll" } }, untitled);
    expect(named.title).toEqual({ text: "Revenue", left: "center", top: 0 });
    expect((named.legend as { type: string }).type).toBe("scroll");

    const placed = presentChartOption(
      { title: { text: "Kept" }, legend: { top: 12 }, grid: { top: "12%" } },
      { legend: { top: 4 }, grid: { top: "12%" } },
    );
    expect((placed.legend as { top: number }).top).toBe(12);
    expect((placed.grid as { top: number }).top).toBe(64);

    const customGrid = presentChartOption({ title: { text: "Kept" }, grid: { top: 80, left: 8 } }, untitled);
    expect((customGrid.grid as { top: number; left: number }).top).toBe(80);
    expect((customGrid.grid as { left: number }).left).toBe(8);

    const bare = presentChartOption({ title: { text: "Only" } }, untitled);
    expect(bare.legend).toBeUndefined();
    expect(bare.grid).toBeUndefined();

    const omitted = presentChartOption(
      { title: { text: "" }, legend: { top: 28 }, grid: { top: 64, left: 8 } },
      untitled,
    );
    expect(omitted.title).toBeUndefined();
    expect((omitted.legend as { top: number }).top).toBe(4);
    expect((omitted.grid as { top: number }).top).toBe(40);
  });

  test("wraps axis values and the tooltip, and keeps a formatter the code already set", () => {
    const format = (value: unknown) => `n${String(value)}`;
    const drawn = presentChartOption(
      {
        yAxis: [
          { axisLabel: { prefix: "$", suffix: " usd" } },
          { axisLabel: { prefix: 4, suffix: "%" } },
          { axisLabel: { formatter: format, prefix: "$" } },
          { name: "plain" },
          { axisLabel: { color: "red" } },
        ],
        xAxis: "category",
        radiusAxis: { axisLabel: { prefix: `${"a".repeat(40)}`, suffix: "" } },
        tooltip: { trigger: "axis", prefix: "<$", suffix: "%" },
      },
      untitled,
    );
    const axes = drawn.yAxis as { axisLabel?: { formatter?: (value: unknown) => string } }[];
    expect(axes[0]?.axisLabel?.formatter?.(12)).toBe("$12 usd");
    expect(axes[0]?.axisLabel?.formatter?.(true)).toBe("$ usd");
    expect(axes[0]?.axisLabel?.formatter?.([])).toBe("$ usd");
    expect(axes[1]?.axisLabel?.formatter?.(3)).toBe("3%");
    expect(axes[2]?.axisLabel?.formatter).toBe(format);
    expect(axes[3]?.axisLabel).toBeUndefined();
    expect(drawn.xAxis).toBe("category");
    const radius = drawn.radiusAxis as { axisLabel: { formatter: (value: unknown) => string } };
    expect(radius.axisLabel.formatter("v")).toBe(`${"a".repeat(32)}v`);

    const tooltip = drawn.tooltip as { formatter: (params: unknown) => string; trigger: string };
    expect(tooltip.trigger).toBe("axis");
    expect(tooltip.formatter({ seriesName: "A<b>", value: [1, 2], marker: "<i>" })).toBe("<i>A&lt;b&gt;: &lt;$2%");
    expect(tooltip.formatter({ value: `a&b>c"d'e` })).toBe("&lt;$a&amp;b&gt;c&quot;d&#39;e%");
    expect(tooltip.formatter([{ value: { value: 3 } }, null, { name: "n", value: "x" }])).toBe(
      "&lt;$3%<br/>n: &lt;$x%",
    );

    const written = presentChartOption({ tooltip: { formatter: "{b}: {c} usd", prefix: "$" } }, untitled);
    expect(presentChartOption({ tooltip: "axis" }, untitled).tooltip).toBe("axis");
    expect(presentChartOption({ tooltip: { trigger: "item" } }, untitled).tooltip).toEqual({ trigger: "item" });
    expect(written.tooltip).toEqual({ formatter: "{b}: {c} usd", prefix: "$" });

    const list = presentChartOption({ tooltip: [{ formatter: "{c}" }, { suffix: "%" }] }, untitled);
    const tips = list.tooltip as [{ formatter: string }, { formatter: (params: unknown) => string }];
    expect(tips[0].formatter).toBe("{c}");
    expect(tips[1].formatter({ value: 8 })).toBe("8%");

    expect(presentChartOption({ title: { text: "" } }, {}).tooltip).toBeUndefined();
  });
});
