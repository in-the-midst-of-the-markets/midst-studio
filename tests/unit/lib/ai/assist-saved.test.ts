import { describe, expect, test } from "bun:test";
import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import { assistSavedAsk, assistSavedPicks, toggleAssistSaved } from "@/lib/ai/assist-saved";
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

  test("asks to chart the attached queries and to keep researching", () => {
    const plain = assistSavedAsk("What changed?", []);
    expect(plain).toEqual({ display: "What changed?", question: "What changed?" });
    const asked = assistSavedAsk("  ", [{ name: "Orders" }, { name: " People " }, { name: " " }]);
    expect(asked.display).toBe("Analyze these saved queries.\n\nOrders, People");
    expect(asked.question).toContain(asked.display);
    expect(asked.question).toContain("Chart each saved query when a chart fits");
    expect(asked.question).toContain("run more queries when they would expand the research");
    const typed = assistSavedAsk("What stands out?", [{ name: "Orders" }]);
    expect(typed.display.startsWith("What stands out?")).toBe(true);
    expect(typed.display).toContain("Orders");
  });

  test("keeps a long question inside the limit the assistant accepts", () => {
    const asked = assistSavedAsk("x".repeat(ASSIST_TEXT_CAP + 50), [{ name: "y".repeat(200) }]);
    expect(asked.display.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
    expect(asked.question.length).toBeLessThanOrEqual(ASSIST_TEXT_CAP);
  });
});
