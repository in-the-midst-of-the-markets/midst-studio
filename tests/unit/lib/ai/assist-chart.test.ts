import { describe, expect, test } from "bun:test";
import {
  assistChoiceForVariation,
  nextAssistChoice,
  suggestAssistChart,
  titleAfterEdit,
  titleForQuery,
  type AssistChartChoice,
} from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import { classifyColumns } from "@/lib/charts/echarts-catalog";
import type { QueryResult } from "@/lib/types";

const bar: AssistChart = { type: "bar", x: "month", y: ["revenue"], caption: "by month", color: null };

function result(fields: string[], rows: Record<string, unknown>[]): QueryResult {
  return { fields, rows, rowCount: rows.length, executionTime: 1 };
}

const revenue = result(
  ["month", "revenue"],
  [
    { month: "Jan", revenue: 10 },
    { month: "Feb", revenue: 12 },
  ],
);

describe("suggestAssistChart", () => {
  test("draws a month series and skips rows with nothing to plot", () => {
    expect(suggestAssistChart(revenue)?.typeId).toBe("line");
    expect(suggestAssistChart(result(["month"], []))).toBeNull();
    expect(suggestAssistChart(result(["note"], [{ note: "a" }]))).toBeNull();
  });
});

describe("nextAssistChoice", () => {
  test("opens a month series as a line even when the model said bar", () => {
    const choice = nextAssistChoice(bar, revenue, null);
    expect(choice).toEqual({
      typeId: "line",
      variationId: "basic",
      selection: { category: ["month"], values: ["revenue"] },
    });
  });

  test("keeps a category comparison as a bar and a chosen bar on screen", () => {
    const regions = result(
      ["region", "revenue"],
      [
        { region: "East", revenue: 10 },
        { region: "West", revenue: 4 },
      ],
    );
    expect(nextAssistChoice({ ...bar, x: "region" }, regions, null)).toEqual({
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["region"], values: ["revenue"] },
    });
    const previous: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["month"], values: ["revenue"] },
    };
    expect(nextAssistChoice(bar, revenue, previous)?.typeId).toBe("bar");
  });

  test("keeps a chosen dimension when the edited query still returns it", () => {
    const previous: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["month"], values: ["revenue"] },
    };
    const again = result(["month", "revenue"], [{ month: "Mar", revenue: 4 }]);
    expect(nextAssistChoice(bar, again, previous)?.selection.category).toEqual(["month"]);
  });

  test("returns to the model's columns when the current choice no longer fits", () => {
    const previous: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["gone"], values: ["also-gone"] },
    };
    expect(nextAssistChoice(bar, revenue, previous)?.selection).toEqual({
      category: ["month"],
      values: ["revenue"],
    });
  });

  test("replaces a dimension the edited query no longer returns", () => {
    const previous: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["month"], values: ["revenue"] },
    };
    const choice = nextAssistChoice(bar, result(["region", "cost"], [{ region: "East", cost: 3 }]), previous);
    expect(choice?.selection.category).toEqual(["region"]);
    expect(choice?.selection.values).toEqual(["cost"]);
  });

  test("draws nothing for an empty result or a result with no metric", () => {
    expect(nextAssistChoice(bar, null, null)).toBeNull();
    expect(nextAssistChoice(bar, result(["month"], []), null)).toBeNull();
    expect(nextAssistChoice(null, result(["month"], [{ month: "Jan" }]), null)).toBeNull();
    const textOnly = result(["month", "note"], [{ month: "Jan", note: "a" }]);
    const previous: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["gone"], values: ["also-gone"] },
    };
    expect(nextAssistChoice({ ...bar, x: "missing", y: ["nope"] }, textOnly, previous)).toBeNull();
  });

  test("picks a line, a bar, a scatter, or a gauge from the columns that remain", () => {
    const missed = { ...bar, x: "missing", y: ["nope"] };
    expect(nextAssistChoice(missed, revenue, null)?.typeId).toBe("line");
    const regions = result(
      ["region", "revenue"],
      [
        { region: "East", revenue: 10 },
        { region: "West", revenue: 4 },
      ],
    );
    expect(nextAssistChoice(missed, regions, null)?.typeId).toBe("bar");
    const points = result(
      ["price", "quantity"],
      [
        { price: 2, quantity: 5 },
        { price: 4, quantity: 1 },
      ],
    );
    expect(nextAssistChoice(missed, points, null)).toEqual({
      typeId: "scatter",
      variationId: "basic",
      selection: { x: ["price"], y: ["quantity"], series: [] },
    });
    expect(nextAssistChoice({ ...bar, x: "price", y: ["quantity"] }, points, null)?.typeId).toBe("scatter");
    const dated = result(
      ["when", "revenue"],
      [
        { when: "2024-01-02", revenue: 10 },
        { when: new Date("2024-02-01T00:00:00Z"), revenue: 12 },
      ],
    );
    expect(nextAssistChoice(missed, dated, null)?.typeId).toBe("line");
    const only = result(["revenue"], [{ revenue: 10 }, { revenue: 12 }]);
    expect(nextAssistChoice(missed, only, null)?.typeId).toBe("gauge");
    const blank = result(
      ["note", "revenue"],
      [
        { note: null, revenue: 1 },
        { note: null, revenue: 2 },
      ],
    );
    expect(nextAssistChoice(missed, blank, null)?.typeId).toBe("bar");
    expect(nextAssistChoice({ ...bar, type: "stacked-bar", x: "month" }, revenue, null)).toMatchObject({
      typeId: "bar",
      variationId: "stacked",
    });
    expect(nextAssistChoice({ ...bar, type: "area" }, revenue, null)?.variationId).toBe("area");
  });
});

describe("assistChoiceForVariation", () => {
  const columns = classifyColumns(revenue.fields, revenue.rows);

  test("opens a variation on the columns this result has", () => {
    expect(assistChoiceForVariation("line", "area", columns)).toEqual({
      typeId: "line",
      variationId: "area",
      selection: { category: ["month"], values: ["revenue"] },
    });
    expect(assistChoiceForVariation("gauge", "basic", columns)?.selection.value).toEqual(["revenue"]);
  });

  test("ignores a type or variation that is not in the catalog", () => {
    expect(assistChoiceForVariation("not-a-chart", "basic", columns)).toBeNull();
    expect(assistChoiceForVariation("line", "missing", columns)).toBeNull();
  });
});

describe("titleForQuery", () => {
  test("names the metric by the first column", () => {
    expect(titleForQuery("SELECT month, revenue FROM orders LIMIT 200")).toBe("revenue by month");
    expect(titleForQuery("-- note\nSELECT region, sum(cost) AS spend FROM sales")).toBe("spend by region");
    expect(titleForQuery("SELECT month, revenue, sum(cost) total FROM t")).toBe("revenue, total by month");
    expect(titleForQuery('SELECT * FROM public."Orders"')).toBe("Orders");
    expect(titleForQuery("SELECT DISTINCT TOP 10 month, orders.revenue FROM t")).toBe("revenue by month");
    expect(titleForQuery("SELECT /* hidden */ month, revenue FROM t")).toBe("revenue by month");
    expect(titleForQuery("SELECT month FROM")).toBe("month");
  });

  test("keeps one selected value, a star, and a statement that is not a query", () => {
    expect(titleForQuery("select count(*) from orders")).toBe("count(*)");
    expect(titleForQuery("SELECT *")).toBe("*");
    expect(titleForQuery("SELECT")).toBe("SELECT");
    expect(titleForQuery("SELECT FROM orders")).toBe("SELECT FROM orders");
    expect(titleForQuery("WITH c AS (SELECT secret FROM hidden) SELECT month, revenue FROM c")).toBe(
      "revenue by month",
    );
    expect(titleForQuery("DELETE FROM orders")).toBe("DELETE FROM orders");
    expect(titleForQuery("   ")).toBe("Query");
    expect(titleForQuery("SELECT /* unfinished")).toBe("SELECT");
    expect(titleForQuery(`SELECT ${"revenue".repeat(40)}, month FROM t`)).toHaveLength(120);
  });

  test("keeps the title when a filter or its value changes", () => {
    const post =
      'POST /v1/search/CompanyProfile/near-vector { "vector": {{search:query}}, "targetVector": "name", "limit": 5, "returnProperties": ["symbol"] }';
    const searched = post.replace("{{search:query}}", "{{search:design}}");
    const filtered = `${searched} WHERE symbol = {{symbol:ACME}}`;
    expect(titleAfterEdit("weave_test", post, searched)).toBe("weave_test");
    expect(titleAfterEdit("weave_test", post, filtered)).toBe("weave_test");
    expect(titleAfterEdit("Revenue", "SELECT month, revenue FROM orders", "SELECT region, cost FROM sales")).toBe(
      "cost by region",
    );
  });
});
