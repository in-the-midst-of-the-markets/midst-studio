import { describe, expect, test } from "bun:test";
import { chartSourceKey, formatChartCode, parseChartCode } from "@/lib/charts/chart-code";

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

  test("the same shelves are the same source, and a new variation is not", () => {
    const selection = { category: ["month"], values: ["revenue"] };
    expect(chartSourceKey("line", "basic", selection)).toBe(chartSourceKey("line", "basic", { ...selection }));
    expect(chartSourceKey("line", "basic", selection)).not.toBe(chartSourceKey("line", "smooth", selection));
    expect(chartSourceKey(null, null, null)).toBe("[null,null,null]");
  });
});
