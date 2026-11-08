import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import {
  ASSIST_RESULT_CAP,
  buildAssistReadingMessages,
  explanationWithResults,
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
    pass: "final",
    results: [],
    ...overrides,
  });
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
    expect(kept?.rows[0]).toEqual(["a b", '{"nested":true}', "false", "", "", "", "", ""]);
    expect(kept?.rows[1]?.[0]).toBe("Jan");
    expect(kept?.rows[1]?.[1]).toBe("10");
    expect(kept?.rows[1]?.[2]).toBe("true");
    expect(kept?.rows[1]?.[3]).toBe("");
    expect(kept?.rows).toHaveLength(12);
    expect(kept?.rows.some((row) => row[0] === "row-10")).toBe(false);
    expect(kept?.rowCount).toBe(1_000_000);
    expect(kept?.error).toBeNull();
  });

  test("refuses a list past the result cap and skips a result with no statement", () => {
    expect(readAssistResults("no").ok).toBe(false);
    expect(readAssistResults(Array.from({ length: ASSIST_RESULT_CAP + 1 }, () => 1))).toEqual({
      ok: false,
      error: "The query results are not valid.",
    });
    const full = readAssistResults(
      Array.from({ length: ASSIST_RESULT_CAP }, (_, index) => ({ sql: `SELECT ${index}` })),
    );
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value).toHaveLength(ASSIST_RESULT_CAP);
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

  test("reads a node, a relationship, a path, and a list", () => {
    const ada = { "~graph": "node", elementId: "4:ada", labels: ["Person"], properties: { name: "Ada" } };
    const bare = { "~graph": "node", elementId: "4:bare", labels: ["City"], properties: {} };
    const unlabeled = { "~graph": "node", elementId: "4:x", labels: [], properties: { name: "X" } };
    const knows = {
      "~graph": "relationship",
      elementId: "5:knows",
      type: "KNOWS",
      startNodeElementId: "4:ada",
      endNodeElementId: "4:bare",
      properties: { since: 2010, extra: { nested: true }, a: "1", b: "2", c: "3", d: "4" },
    };
    const plain = {
      "~graph": "relationship",
      elementId: "5:plain",
      type: "LIVES_IN",
      startNodeElementId: "4:ada",
      endNodeElementId: "4:bare",
      properties: {},
    };
    const path = {
      "~graph": "path",
      nodes: ["nope", ada],
      relationships: ["nope", plain],
    };
    const linked = { "~graph": "path", nodes: [ada, bare], relationships: [plain] };
    const emptyPath = { "~graph": "path", nodes: [], relationships: [] };
    const read = readAssistResults([
      {
        sql: "MATCH (n) RETURN n",
        fields: ["n", "r", "p", "linked", "tags", "odd", "empty"],
        rows: [
          {
            n: ada,
            r: knows,
            p: path,
            linked,
            tags: ["east", "west"],
            odd: { n: BigInt(1) },
            empty: emptyPath,
          },
        ],
      },
      {
        sql: "MATCH (n) RETURN n",
        fields: ["bare", "open"],
        rows: [{ bare, open: unlabeled }],
      },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value[0]?.rows[0]?.[0]).toBe("(:Person Ada)");
    expect(read.value[0]?.rows[0]?.[1]).toBe("[:KNOWS since: 2010, a: 1, b: 2]");
    expect(read.value[0]?.rows[0]?.[2]).toBe("(:Person Ada)-LIVES_IN->");
    expect(read.value[0]?.rows[0]?.[3]).toBe("(:Person Ada)-LIVES_IN->(:City)");
    expect(read.value[0]?.rows[0]?.[4]).toBe("east, west");
    expect(read.value[0]?.rows[0]?.[5]).toBe("");
    expect(read.value[0]?.rows[0]?.[6]).toBe("path");
    expect(read.value[1]?.rows[0]?.[0]).toBe("(:City)");
    expect(read.value[1]?.rows[0]?.[1]).toBe("(:X)");
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
    expect(request({ pass: "follow" })).toEqual({ ok: false, error: "The reading is not valid." });
    const kept = request({ results: [{ sql: select, rowCount: 2, rows: [{}, {}] }] });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.pass).toBe("final");
    expect(kept.value.results[0]?.rowCount).toBe(2);
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
    const capped = explanationWithResults("e".repeat(ASSIST_TEXT_CAP - 10), [
      { title: "Revenue", sql: select, fields: ["revenue"], rows: [["10"]], rowCount: 1, error: null },
    ]);
    expect(capped).toHaveLength(ASSIST_TEXT_CAP);
    expect(capped.startsWith("e".repeat(ASSIST_TEXT_CAP - 10))).toBe(true);
  });
});

describe("buildAssistReadingMessages", () => {
  test("writes the analysis and plans no further query", () => {
    const final = buildAssistReadingMessages({
      databaseType: "",
      questionBlock: "FENCED-QUESTION",
      schemaBlock: "FENCED-SCHEMA",
      historyBlock: "FENCED-HISTORY",
      resultsBlock: "RESULT-TOKEN",
    });
    expect(final[0]?.content).toContain("The connected engine is SQL.");
    expect(final[0]?.content).toContain("Do not plan another query.");
    expect(final[0]?.content).not.toContain("RESULT-TOKEN");
    expect(final[1]?.content).toContain("RESULT-TOKEN");
    expect(final[1]?.content).toContain("FENCED-QUESTION");

    expect(final[0]?.content).toContain("queries is empty.");
    expect(final[0]?.content).toContain("explanation is Markdown the person reads");
    expect(final[0]?.content).not.toContain("several paragraphs");
    expect(final[0]?.content).not.toContain("One sentence is too short");
    expect(final[0]?.content).toContain("The words inside the sample explanation are a description of the field.");
    expect(final[0]?.content).toContain("Separate paragraphs with a blank line.");
    expect(final[0]?.content).not.toContain("East led");
    expect(final[0]?.content).not.toContain("augment these query results");
    expect(final[1]?.content).toContain("Results:\nRESULT-TOKEN");

    const plain = buildAssistReadingMessages({
      databaseType: "postgres",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
      resultsBlock: "r",
    });
    expect(plain[0]?.content).toContain("The connected engine is postgres.");
    expect(plain[0]?.content).not.toContain("You can search the web.");

    const graph = buildAssistReadingMessages({
      databaseType: "neo4j",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
      resultsBlock: "r",
    });
    expect(graph[0]?.content).toContain("Cite those names.");
    expect(graph[0]?.content).toContain("(:Label name)");
    expect(graph[0]?.content).not.toContain("Add a query only for a number the rows do not already show.");

    const searched = buildAssistReadingMessages({
      databaseType: "postgres",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
      resultsBlock: "r",
      webSearch: true,
    });
    expect(searched[0]?.content).toContain("You can search the web.");
    expect(searched[0]?.content).toContain("augment these query results");
    expect(searched[0]?.content).toContain("The message you return is still one JSON object.");

    const search = buildAssistReadingMessages({
      databaseType: "opensearch",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
      resultsBlock: "r",
    });
    expect(search[0]?.content).not.toContain("The editor runs that request as written.");
    expect(search[0]?.content).toContain("Do not plan another query.");
  });
});
