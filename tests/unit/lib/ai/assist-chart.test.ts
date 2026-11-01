import { describe, expect, test } from "bun:test";
import { nextAssistChoice, type AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import type { QueryResult } from "@/lib/types";

const bar: AssistChart = { type: "bar", x: "month", y: ["revenue"], caption: "by month" };

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

describe("nextAssistChoice", () => {
  test("keeps the model's dimension and metrics", () => {
    const choice = nextAssistChoice(bar, revenue, null);
    expect(choice).toEqual({
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["month"], values: ["revenue"] },
    });
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

  test("uses a bar when the model's columns are gone and the result still has a metric", () => {
    const choice = nextAssistChoice({ ...bar, x: "missing", y: ["nope"] }, revenue, null);
    expect(choice?.typeId).toBe("bar");
    expect(choice?.selection.values).toEqual(["revenue"]);
  });
});
