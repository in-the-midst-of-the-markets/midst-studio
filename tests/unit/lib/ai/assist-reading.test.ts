import { describe, expect, test } from "bun:test";
import type { AssistQueryPlan } from "@/lib/ai/assist-plan";
import {
  buildAssistReadingMessages,
  explanationWithResults,
  followUpQuery,
  formatAssistResults,
  readAssistReading,
  readAssistResults,
} from "@/lib/ai/assist-reading";

const select = "SELECT month, revenue FROM orders";

function request(overrides: Record<string, unknown> = {}) {
  return readAssistReading({
    source: "openrouter",
    model: "openai/gpt-4o",
    apiKey: "key",
    question: "What changed?",
    schemaContext: "[]",
    databaseType: "postgres",
    history: [],
    pass: "follow",
    results: [],
    ...overrides,
  });
}

function plan(sql: string): AssistQueryPlan {
  return { title: "Query", sql, connection: "", chart: null };
}

describe("readAssistResults", () => {
  test("keeps a short table and drops a row or field that is not usable", () => {
    const fields = ["month", " month ", "  ", 4, "revenue", "flag", "extra", "e", "f", "g", "h", "i"];
    const rows = [
      null,
      ["not", "a", "row"],
      "nope",
      { month: "  a   b  ", revenue: { nested: true }, flag: false },
      { month: "Jan", revenue: 10, flag: true },
      ...Array.from({ length: 11 }, (_, index) => ({ month: `row-${index}` })),
    ];
    const read = readAssistResults([
      {
        title: "  Revenue   by   month  ",
        sql: `  ${select}  `,
        fields,
        rows,
        rowCount: 1_000_000,
        error: "   ",
      },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const kept = read.value[0];
    expect(kept?.title).toBe("Revenue by month");
    expect(kept?.sql).toBe(select);
    expect(kept?.fields).toEqual(["month", "revenue", "flag", "extra", "e", "f", "g", "h"]);
    expect(kept?.rows[0]).toEqual(["a b", "", "false", "", "", "", "", ""]);
    expect(kept?.rows[1]?.[0]).toBe("Jan");
    expect(kept?.rows[1]?.[1]).toBe("10");
    expect(kept?.rows[1]?.[2]).toBe("true");
    expect(kept?.rows[1]?.[3]).toBe("");
    expect(kept?.rows).toHaveLength(12);
    expect(kept?.rows.some((row) => row[0] === "row-10")).toBe(false);
    expect(kept?.rowCount).toBe(1_000_000);
    expect(kept?.error).toBeNull();
  });

  test("refuses a list that is not four results and skips a result with no statement", () => {
    expect(readAssistResults("no").ok).toBe(false);
    expect(readAssistResults([1, 2, 3, 4, 5])).toEqual({ ok: false, error: "The query results are not valid." });
    const read = readAssistResults([
      null,
      [],
      { sql: "   " },
      { sql: select, title: 4, error: 4, fields: "month", rows: "no", rowCount: "3" },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toHaveLength(1);
    expect(read.value[0]).toMatchObject({ title: "Query", fields: [], rows: [], rowCount: 0, error: null });
    const failed = readAssistResults([
      { title: "Failed", sql: select, fields: [], rows: [{ secret: "SECRET" }], error: "  denied  " },
    ]);
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value[0]).toMatchObject({ title: "Failed", error: "denied", rowCount: 1 });
  });

  test("uses the shown rows when the count is not an integer in range", () => {
    const counted = (rowCount: unknown) => {
      const read = readAssistResults([{ sql: select, fields: ["month"], rows: [{ month: "Jan" }], rowCount }]);
      return read.ok ? read.value[0]?.rowCount : null;
    };
    expect(counted(1.5)).toBe(1);
    expect(counted(-1)).toBe(1);
    expect(counted(1_000_001)).toBe(1);
    expect(counted(0)).toBe(1);
    expect(counted(5)).toBe(5);
  });
});

describe("readAssistReading", () => {
  test("requires a pass and a result list, then keeps both", () => {
    expect(request({ model: "" })).toEqual({ ok: false, error: "Name the model to use." });
    expect(request({ pass: "no" })).toEqual({ ok: false, error: "The reading is not valid." });
    expect(request({ pass: undefined })).toEqual({ ok: false, error: "The reading is not valid." });
    expect(request({ results: "no" })).toEqual({ ok: false, error: "The query results are not valid." });
    const follow = request({ results: [{ sql: select, rowCount: 2, rows: [{}, {}] }] });
    expect(follow.ok).toBe(true);
    if (!follow.ok) return;
    expect(follow.value.pass).toBe("follow");
    expect(follow.value.results[0]?.rowCount).toBe(2);
    const final = request({ pass: "final", results: [] });
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.pass).toBe("final");
    expect(final.value.results).toEqual([]);
  });
});

describe("formatAssistResults", () => {
  test("renders a table, and only the head when the rows cannot be shown", () => {
    expect(formatAssistResults([])).toBe("");
    const failed = formatAssistResults([
      {
        title: "Failed",
        sql: select,
        fields: ["month"],
        rows: [["SECRET"]],
        rowCount: 1,
        error: "denied",
      },
    ]);
    expect(failed).toBe(`Failed | ${select} | denied`);
    expect(failed).not.toContain("SECRET");

    const noFields = formatAssistResults([
      { title: "Bare", sql: "SELECT 1", fields: [], rows: [["SECRET"]], rowCount: 1, error: null },
    ]);
    expect(noFields).toBe("Bare | SELECT 1 | 1 row");

    const noRows = formatAssistResults([
      { title: "Empty", sql: "SELECT 1", fields: ["region"], rows: [], rowCount: 0, error: null },
    ]);
    expect(noRows).toBe("Empty | SELECT 1 | 0 rows");

    const longSql = `S${"x".repeat(400)}`;
    const shown = formatAssistResults([
      {
        title: "Long",
        sql: longSql,
        fields: ["month", "revenue"],
        rows: [
          ["Jan", "10"],
          ["Feb", "12"],
        ],
        rowCount: 2,
        error: null,
      },
    ]);
    expect(shown).toContain(`Long | ${longSql.slice(0, 300)} | 2 rows`);
    expect(shown).not.toContain("x".repeat(300));
    expect(shown).toContain("month | revenue");
    expect(shown).toContain("Jan | 10");
    expect(shown).toContain("Feb | 12");

    const omitted = formatAssistResults([
      { title: "More", sql: "SELECT 1", fields: ["n"], rows: [["1"]], rowCount: 5, error: null },
    ]);
    expect(omitted).toContain("5 rows");
    expect(omitted).toContain("4 more rows were left out.");
  });
});

describe("explanationWithResults", () => {
  test("appends the rows and stays inside the turn cap", () => {
    expect(explanationWithResults("Revenue rose.", [])).toBe("Revenue rose.");
    const noted = explanationWithResults("Revenue rose.", [
      { title: "Revenue", sql: select, fields: ["revenue"], rows: [["10"]], rowCount: 1, error: null },
    ]);
    expect(noted).toContain("Revenue rose.\nResults:\n");
    expect(noted).toContain("10");
    const capped = explanationWithResults("e".repeat(3990), [
      { title: "Revenue", sql: select, fields: ["revenue"], rows: [["10"]], rowCount: 1, error: null },
    ]);
    expect(capped).toHaveLength(4000);
    expect(capped.startsWith("e".repeat(3990))).toBe(true);
  });
});

describe("followUpQuery", () => {
  test("returns the first statement that has not already run", () => {
    const other = "SELECT region, revenue FROM orders";
    expect(followUpQuery([plan(select), plan(other)], [select])).toEqual(plan(other));
    expect(followUpQuery([plan(`${select} LIMIT 50`)], [select])).toBeNull();
    expect(followUpQuery([], [select])).toBeNull();
  });
});

describe("buildAssistReadingMessages", () => {
  test("asks for one charted query, then for the analysis and no further query", () => {
    const follow = buildAssistReadingMessages({
      pass: "follow",
      databaseType: "postgres",
      questionBlock: "FENCED-QUESTION",
      schemaBlock: "FENCED-SCHEMA",
      historyBlock: "FENCED-HISTORY",
      resultsBlock: "RESULT-TOKEN",
    });
    expect(follow[0]?.content).toContain("The connected engine is postgres.");
    expect(follow[0]?.content).toContain("The chart is required.");
    expect(follow[0]?.content).not.toContain("Do not plan another query.");
    expect(follow[0]?.content).not.toContain("RESULT-TOKEN");
    expect(follow[1]?.content).toContain("RESULT-TOKEN");
    expect(follow[1]?.content).toContain("FENCED-QUESTION");

    const final = buildAssistReadingMessages({
      pass: "final",
      databaseType: "",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
      resultsBlock: "r",
    });
    expect(final[0]?.content).toContain("The connected engine is SQL.");
    expect(final[0]?.content).toContain("queries is empty.");
    expect(final[0]?.content).toContain("Do not plan another query.");
    expect(final[1]?.content).toContain("Results:\nr");
  });
});
