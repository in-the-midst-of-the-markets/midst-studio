import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import {
  ASSIST_SAVED_LIST_CAP,
  assistSavedAsk,
  assistSavedForPrompt,
  assistSavedChart,
  assistSavedPicks,
  formatAssistSaved,
  readAssistSaved,
  toggleAssistSaved,
  type AssistSavedPick,
} from "@/lib/ai/assist-saved";
import type { SavedQuery } from "@/lib/types";

function chartPick(name: string, sql: string, connectionType = "postgres"): AssistSavedPick {
  return { id: name, name, sql, connectionId: "c1", connectionType };
}

function query(patch: Partial<SavedQuery> & Pick<SavedQuery, "id" | "name" | "query">): SavedQuery {
  return {
    connectionType: "postgres",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...patch,
  };
}

describe("assist saved queries", () => {
  test("offers a named statement and skips a blank one", () => {
    const picks = assistSavedPicks([
      query({ id: "q1", name: " Orders ", query: " SELECT 1 " }),
      query({ id: "q2", name: "   ", query: "SELECT 2" }),
      query({ id: "q3", name: "Empty", query: "  " }),
    ]);
    expect(picks).toEqual([
      { id: "q1", name: "Orders", sql: "SELECT 1", connectionId: null, connectionType: "postgres" },
      { id: "q2", name: "Saved query", sql: "SELECT 2", connectionId: null, connectionType: "postgres" },
    ]);
  });

  test("lists the most recently saved query first", () => {
    const picks = assistSavedPicks([
      query({
        id: "old",
        name: "Older",
        query: "SELECT 1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      query({
        id: "fresh",
        name: "Newer",
        query: "SELECT 2",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
      query({
        id: "tied",
        name: "Tied",
        query: "SELECT 3",
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
      query({
        id: "created",
        name: "Created later",
        query: "SELECT 4",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date(Number.NaN),
      }),
      query({
        id: "blank",
        name: "Blank",
        query: "  ",
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
      query({
        id: "undated",
        name: "Undated",
        query: "SELECT 5",
        createdAt: undefined as unknown as Date,
        updatedAt: undefined as unknown as Date,
      }),
    ]);
    expect(picks.map((pick) => pick.name)).toEqual(["Newer", "Tied", "Created later", "Older", "Undated"]);
  });

  test("keeps the connection a query was saved from", () => {
    const [pick] = assistSavedPicks([
      query({ id: "q1", name: "Orders", query: "SELECT 1", connectionId: "c1", connectionType: "mysql" }),
    ]);
    expect(pick).toMatchObject({ connectionId: "c1", connectionType: "mysql" });
  });

  test("adds a query and removes it on the next choice", () => {
    const pick = { id: "q1", name: "Orders", sql: "SELECT 1", connectionId: "c1", connectionType: "postgres" };
    const other = { ...pick, id: "q2", name: "People" };
    const added = toggleAssistSaved([], pick);
    expect(toggleAssistSaved(added, other).map((item) => item.name)).toEqual(["Orders", "People"]);
    expect(toggleAssistSaved(added, pick)).toEqual([]);
  });

  test("asks the model to explain the attached queries", () => {
    const plain = assistSavedAsk("What changed?", []);
    expect(plain).toEqual({ display: "What changed?", question: "What changed?" });
    const asked = assistSavedAsk("  ", [{ name: "Orders" }, { name: " People " }, { name: " " }]);
    expect(asked.display).toBe("Analyze these saved queries.\n\nOrders, People");
    expect(asked.question).toContain(asked.display);
    expect(asked.question).toContain("Explain what these saved queries show.");
    const typed = assistSavedAsk("What stands out?", [{ name: "Orders" }]);
    expect(typed.display.startsWith("What stands out?")).toBe(true);
    expect(typed.display).toContain("Orders");
  });

  test("checks the saved catalog and keeps it inside the prompt", () => {
    const pick = (id: string, sql = "SELECT 1", name = id): AssistSavedPick => ({
      id,
      name,
      sql,
      connectionId: id === "gone" ? "missing" : "c1",
      connectionType: "postgres",
    });
    const connections = [{ id: "c1", name: `  ${"N".repeat(210)}  ` }];
    const listed = assistSavedForPrompt(
      [
        pick("blank", "  "),
        pick("orders", "  SELECT revenue FROM orders  ", "  Monthly revenue  "),
        pick("gone", "SELECT 2", "   "),
        ...Array.from({ length: 20 }, (_, index) => pick(`q${index}`, `SELECT ${index}`)),
      ],
      connections,
    );
    expect(listed).toHaveLength(ASSIST_SAVED_LIST_CAP);
    expect(listed[0]).toEqual({
      name: "Monthly revenue",
      connection: "N".repeat(200),
      sql: "SELECT revenue FROM orders",
    });
    expect(listed[1]).toEqual({ name: "Saved query", connection: "", sql: "SELECT 2" });
    const longSql = assistSavedForPrompt([pick("long", `SELECT ${"1".repeat(2_100)}`, "L")], connections);
    expect(longSql[0]?.sql).toHaveLength(2_000);

    expect(formatAssistSaved([])).toBe("(none)");
    expect(formatAssistSaved(listed.slice(0, 1))).toBe(
      `Monthly revenue | ${"N".repeat(200)}\nSELECT revenue FROM orders`,
    );

    expect(readAssistSaved(undefined)).toEqual({ ok: true, value: [] });
    expect(readAssistSaved(null)).toEqual({ ok: true, value: [] });
    expect(readAssistSaved("no")).toEqual({ ok: false, error: "The saved queries are not valid." });
    expect(readAssistSaved(Array.from({ length: ASSIST_SAVED_LIST_CAP + 1 }, () => ({ sql: "SELECT 1" })))).toEqual({
      ok: false,
      error: "The saved queries are too long.",
    });
    const twos = "2".repeat(2_100);
    const read = readAssistSaved([
      null,
      "skip",
      { sql: "  " },
      { sql: 1 },
      { sql: `  SELECT ${twos}  `, name: ` ${"R".repeat(130)} `, connection: 4 },
      { sql: "SELECT 3", name: "   ", connection: " Orders " },
      { sql: "SELECT 4", name: 1, connection: "Logs" },
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual([
      { name: "R".repeat(120), connection: "", sql: `SELECT ${twos}`.slice(0, 2_000) },
      { name: "Saved query", connection: "Orders", sql: "SELECT 3" },
      { name: "Saved query", connection: "Logs", sql: "SELECT 4" },
    ]);
  });

  test("builds the chart a question asks for from the saved query it names", () => {
    const near = (body: string) => `POST /v1/search/CompanyProfile/near-vector\n${body}`;
    const question =
      "Create a bar chart using the distance column as the values and create a search box to decide the vector query weave_test";
    const saved = near(
      '{"vector": {{dirtbike}}, "targetVector": "name", "limit": 5, "returnProperties": ["symbol"], "returnMetadata": ["certainty"]}',
    );
    const chart = assistSavedChart(question, [
      { id: "short", name: "a", sql: "SELECT 1", connectionId: null, connectionType: "postgres" },
      { id: "weave", name: "weave", sql: "SELECT 1", connectionId: "c1", connectionType: "postgres" },
      { id: "q", name: "weave_test", sql: saved, connectionId: "c1", connectionType: "weaviate" },
    ]);
    expect(chart?.title).toBe("weave_test");
    expect(chart?.connectionId).toBe("c1");
    expect(chart?.chart).toEqual({ type: "bar", x: "symbol", y: ["$distance"] });
    expect(chart?.sql).toContain("{{search:dirtbike}}");
    expect(chart?.sql).toContain('"certainty", "distance"');

    const listed = assistSavedChart("Make a line chart of Orders", [
      { id: "orders", name: "Orders", sql: "SELECT 1", connectionId: null, connectionType: "postgres" },
    ]);
    expect(listed?.chart.type).toBe("line");
    expect(listed?.sql).toBe("SELECT 1");

    expect(
      assistSavedChart("Create an area chart of revenue", [
        { id: "orders", name: "Orders", sql: "SELECT 1", connectionId: null, connectionType: "postgres" },
      ]),
    ).toBeNull();
    expect(assistSavedChart("What is weave_test?", [chartPick("weave_test", saved)])).toBeNull();

    const arrayBody = near('{"vector": [0.2, 0.4], "returnMetadata": []}');
    const arrayChart = assistSavedChart(
      "Create a scatter chart using the distance column as the values and a search box for weave_test",
      [chartPick("weave_test", arrayBody, "weaviate")],
    );
    expect(arrayChart?.chart.type).toBe("scatter");
    expect(arrayChart?.sql).toContain("{{search:query}}");
    expect(arrayChart?.sql).toContain('"returnMetadata": ["distance"]');

    const textBody = near('{"vector": "car"}');
    expect(
      assistSavedChart("Create a stacked bar chart and a search box for weave_test", [
        chartPick("weave_test", textBody, "weaviate"),
      ])?.sql,
    ).toContain("{{search:query}}");

    const numbered = near('{"vector": 0.5, "returnMetadata": ["distance"]}');
    const numberedChart = assistSavedChart(
      "Create a bar chart using the certainty column as the values and a search box for weave_test",
      [chartPick("weave_test", numbered, "weaviate")],
    );
    expect(numberedChart?.chart.y).toEqual(["$certainty"]);
    expect(numberedChart?.sql).toContain("{{search:query}}");
    expect(numberedChart?.sql).toContain('"distance"');

    const labeled = near('{"vector": {{search:car}}, "returnProperties": ["symbol"]}');
    const labeledChart = assistSavedChart(question, [chartPick("weave_test", labeled, "weaviate")]);
    expect(labeledChart?.sql).toContain("{{search:car}}");
    expect(labeledChart?.sql).toContain('"returnMetadata": ["distance"]');
    expect(labeledChart?.chart.x).toBe("symbol");

    expect(
      assistSavedChart("Create a chart of weave_test", [
        chartPick("weave_test", "POST /v1/search/C/near-vector", "weaviate"),
      ])?.chart,
    ).toEqual({ type: "bar", x: "category", y: ["value"] });
    expect(
      assistSavedChart("Create a chart and a search box for weave_test", [
        chartPick("weave_test", 'POST /v1/search/C/near-vector\n{"vector": {{', "weaviate"),
      ])?.sql,
    ).toContain('{"vector": {{');
    expect(
      assistSavedChart("Create a chart and a search box for weave_test", [
        chartPick("weave_test", 'POST /v1/search/C/near-vector\n{"vector": [0.2', "weaviate"),
      ])?.sql,
    ).toContain("[0.2");
    expect(
      assistSavedChart("Create a chart and a search box for weave_test", [
        chartPick("weave_test", 'POST /v1/search/C/near-vector\n{"vector": "car', "weaviate"),
      ])?.sql,
    ).toContain('"car');
    expect(
      assistSavedChart("Create a bar chart using the distance column as the values and a search box for weave_test", [
        chartPick("weave_test", near('{"vector": true}'), "weaviate"),
      ])?.sql,
    ).toContain('"vector": true');
  });

  test("keeps a long question inside the limit the assistant accepts", () => {
    const asked = assistSavedAsk("x".repeat(ASSIST_TEXT_CAP + 50), [{ name: "y".repeat(200) }]);
    expect(asked.display.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
    expect(asked.question.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
  });
});
