import { describe, expect, test } from "bun:test";
import { chartTheme } from "@/lib/charts/palette";
import { restampThemeChrome } from "@/lib/charts/theme-chrome";

const light = chartTheme("light");
const dark = chartTheme("dark");

describe("theme chrome on a saved chart", () => {
  test("light mode rewrites dark ink and dark grid lines, and leaves a chosen color", () => {
    const option = {
      color: ["#9546de"],
      textStyle: { color: " #FFFFFF ", fontSize: 12 },
      legend: { top: 4, textStyle: { color: "#ffffff" } },
      xAxis: { axisLabel: { color: "#666666" }, splitLine: { show: false } },
      yAxis: [null, { splitLine: { lineStyle: { color: "#222222" } }, axisLabel: { color: "#112233" } }],
      series: [{ itemStyle: { color: "#9546de" } }],
    };
    const painted = restampThemeChrome(option, light);
    expect(painted.color).toEqual(["#9546de"]);
    expect(painted.textStyle).toEqual({ color: light.ink, fontSize: 12 });
    expect((painted.legend as { textStyle: { color: string } }).textStyle.color).toBe(light.ink);
    expect((painted.xAxis as { axisLabel: { color: string } }).axisLabel.color).toBe(light.axis);
    expect((painted.xAxis as { splitLine: { show: boolean } }).splitLine).toEqual({ show: false });
    const axes = painted.yAxis as [null, { splitLine: { lineStyle: { color: string } }; axisLabel: { color: string } }];
    expect(axes[0]).toBeNull();
    expect(axes[1].splitLine.lineStyle.color).toBe(light.grid);
    expect(axes[1].axisLabel.color).toBe("#112233");
    expect(painted.series).toBe(option.series);
  });

  test("dark mode rewrites light ink and light grid lines", () => {
    const painted = restampThemeChrome(
      {
        textStyle: { color: "#333333" },
        legend: { textStyle: { color: "#333333" } },
        yAxis: {
          axisLabel: { color: "#52525b" },
          axisLine: { lineStyle: { color: "#e4e4e7" } },
          splitLine: { lineStyle: { color: "#e4e4e7" } },
        },
      },
      dark,
    );
    expect((painted.textStyle as { color: string }).color).toBe(dark.ink);
    expect((painted.legend as { textStyle: { color: string } }).textStyle.color).toBe(dark.ink);
    const axis = painted.yAxis as {
      axisLabel: { color: string };
      axisLine: { lineStyle: { color: string } };
      splitLine: { lineStyle: { color: string } };
    };
    expect(axis.axisLabel.color).toBe(dark.axis);
    expect(axis.axisLine.lineStyle.color).toBe(dark.grid);
    expect(axis.splitLine.lineStyle.color).toBe(dark.grid);
  });

  test("chrome already in this theme, and a chart with nothing to retint, stays put", () => {
    const themed = {
      textStyle: { color: light.ink },
      legend: { top: 4 },
      xAxis: null,
      yAxis: "value",
    };
    expect(restampThemeChrome(themed, light).textStyle).toBe(themed.textStyle);
    expect(restampThemeChrome(themed, light).legend).toBe(themed.legend);
    expect(restampThemeChrome(themed, light).xAxis).toBeNull();
    expect(restampThemeChrome(themed, light).yAxis).toBe("value");

    const bare = { color: ["#9546de"] };
    expect(restampThemeChrome(bare, light)).toBe(bare);

    const custom = {
      legend: { textStyle: "#ffffff" },
      yAxis: { splitLine: { lineStyle: { color: "#112233", width: 1 } }, axisLine: { show: true } },
    };
    const left = restampThemeChrome(custom, light);
    expect(left.legend).toEqual(custom.legend);
    expect(left.yAxis).toBe(custom.yAxis);
  });
});
