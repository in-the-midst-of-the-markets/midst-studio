import { describe, expect, test } from "bun:test";
import {
  applyChartValues,
  chartSourceKey,
  formatChartCode,
  parseChartCode,
  stripChartValues,
} from "@/lib/charts/chart-code";

describe("chart code", () => {
  test("pretty-prints an option and drops a function", () => {
    const option = { series: [{ type: "bar" }], size: () => 4 };
    expect(formatChartCode(option)).toBe('{\n  "series": [\n    {\n      "type": "bar"\n    }\n  ]\n}');
  });

  test("a circular option is empty text", () => {
    const option: Record<string, unknown> = { series: [] };
    option.self = option;
    expect(formatChartCode(option)).toBe("");
  });

  test("parses an object and rejects everything else", () => {
    expect(parseChartCode('{"series":[]}')).toEqual({ ok: true, option: { series: [] } });
    expect(parseChartCode("{")).toEqual({ ok: false, error: "Chart code is not valid JSON." });
    for (const text of ["null", "[]", "1", '"bar"']) {
      expect(parseChartCode(text)).toEqual({ ok: false, error: "Chart code must be a JSON object." });
    }
  });

  test("chart code keeps the look and leaves the query's values out", () => {
    const generated = {
      legend: { top: 4 },
      xAxis: { type: "category", data: ["Jan"] },
      series: [{ type: "bar", data: [10], links: [{ source: "a" }], itemStyle: { color: "blue" } }],
      radar: { indicator: [{ name: "revenue", max: 10 }], shape: "circle" },
    };
    expect(stripChartValues(generated)).toEqual({
      legend: { top: 4 },
      xAxis: { type: "category" },
      series: [{ type: "bar", itemStyle: { color: "blue" } }],
      radar: { shape: "circle" },
    });
    expect(stripChartValues({ palette: ["#fff"] }).palette).toEqual(["#fff"]);

    const edited = {
      title: { text: "Edited" },
      series: [{ itemStyle: { color: "red" }, data: [1] }, { name: "extra" }],
      filters: { revenue: { control: "slider" } },
    };
    const merged = applyChartValues(edited, generated);
    expect(merged.title).toEqual({ text: "Edited" });
    expect(merged.legend).toBeUndefined();
    expect(merged.filters).toEqual({ revenue: { control: "slider" } });
    expect(merged.xAxis).toEqual({ type: "category", data: ["Jan"] });
    expect(merged.radar).toEqual({ indicator: [{ name: "revenue", max: 10 }], shape: "circle" });
    const series = merged.series as {
      data?: number[];
      itemStyle?: { color: string };
      name?: string;
      links?: unknown;
    }[];
    expect(series[0]).toMatchObject({ data: [10], itemStyle: { color: "red" }, links: [{ source: "a" }] });
    expect(series[0]?.data).not.toBe(generated.series[0]?.data);
    expect(series[1]).toEqual({ name: "extra" });

    const replaced = applyChartValues({ series: { type: "bar" } }, { series: [{ data: [3] }, { data: [4] }] });
    expect(replaced.series).toEqual([{ data: [3] }, { data: [4] }]);
    expect(applyChartValues({ xAxis: null }, generated).xAxis).toBeNull();

    const circular: Record<string, unknown> = { data: [] };
    circular.self = circular;
    const looped = applyChartValues({}, { series: [circular] });
    expect((looped.series as unknown[])[0]).toBe(circular);

    const symbolSize = () => 8;
    const withMark = applyChartValues(
      { series: [{ itemStyle: { color: "red" } }] },
      { series: [{ data: [1], symbolSize }] },
    );
    expect((withMark.series as { symbolSize: unknown }[])[0]?.symbolSize).toBe(symbolSize);
    const sized = applyChartValues({ series: [{ symbolSize: 12 }] }, { series: [{ data: [1], symbolSize }] });
    expect((sized.series as { symbolSize: number }[])[0]?.symbolSize).toBe(12);
  });

  test("the same shelves are the same source, and a new variation is not", () => {
    const selection = { category: ["month"], values: ["revenue"] };
    expect(chartSourceKey("line", "basic", selection)).toBe(chartSourceKey("line", "basic", { ...selection }));
    expect(chartSourceKey("line", "basic", selection)).not.toBe(chartSourceKey("line", "smooth", selection));
    expect(chartSourceKey(null, null, null)).toBe("[null,null,null]");
  });
});
