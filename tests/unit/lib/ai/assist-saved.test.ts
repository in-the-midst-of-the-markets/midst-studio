import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import {
  ASSIST_SAVED_LIST_CAP,
  assistSavedAsk,
  assistSavedForPrompt,
  assistSavedPicks,
  formatAssistSaved,
  readAssistSaved,
  toggleAssistSaved,
  type AssistSavedPick,
} from "@/lib/ai/assist-saved";
import type { SavedQuery } from "@/lib/types";

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

  test("keeps a long question inside the limit the assistant accepts", () => {
    const asked = assistSavedAsk("x".repeat(ASSIST_TEXT_CAP + 50), [{ name: "y".repeat(200) }]);
    expect(asked.display.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
    expect(asked.question.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
  });
});
