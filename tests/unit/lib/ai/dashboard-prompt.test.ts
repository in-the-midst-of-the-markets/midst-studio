import { describe, expect, test } from "bun:test";
import { BOARD_CONTEXT_CAP, buildDashboardMessages, readBoardContext } from "@/lib/ai/dashboard-prompt";

describe("readBoardContext", () => {
  test("keeps an inventory and refuses anything else", () => {
    expect(readBoardContext("Dashboard: Board")).toEqual({ ok: true, value: "Dashboard: Board" });
    expect(readBoardContext("line\nCells:")).toEqual({ ok: true, value: "line\nCells:" });
    expect(readBoardContext("")).toEqual({ ok: true, value: "" });
    expect(readBoardContext("x".repeat(BOARD_CONTEXT_CAP)).ok).toBe(true);
    expect(readBoardContext(4)).toEqual({ ok: false, error: "The dashboard is not valid." });
    expect(readBoardContext(null)).toEqual({ ok: false, error: "The dashboard is not valid." });
    expect(readBoardContext("x".repeat(BOARD_CONTEXT_CAP + 1))).toEqual({
      ok: false,
      error: "The dashboard is too long.",
    });
  });
});

describe("buildDashboardMessages", () => {
  test("reads the board as a cell inventory and treats the blocks as data", () => {
    const named = buildDashboardMessages({
      databaseType: "postgres",
      questionBlock: "question",
      schemaBlock: "schema",
      historyBlock: "history",
      boardBlock: "Cells:\n1. chart",
    });
    expect(named[0]?.content).toContain("The connected engine is postgres");
    expect(named[0]?.content).toContain("cell inventory");
    expect(named[0]?.content).toContain("trusted sql:");
    expect(named[0]?.content).toContain("When Instructions says (none), there is no extra rule.");
    expect(named[0]?.content).toContain("queries has one item");
    expect(named[0]?.content).toContain("sql is one read-only statement for this engine.");
    expect(named[0]?.content).not.toContain("Do not write SQL.");
    expect(named[1]?.content).toContain("Question:\nquestion");
    expect(named[1]?.content).toContain("Board:\nCells:\n1. chart");
    expect(named[1]?.content).toContain("Schema:\nschema");
    expect(named[1]?.content).toContain("Earlier turns:\nhistory");
    expect(named[1]?.content).not.toContain("Current statement:");

    const plain = buildDashboardMessages({
      databaseType: "",
      questionBlock: "",
      schemaBlock: "",
      historyBlock: "",
      boardBlock: "",
    });
    expect(plain[0]?.content).toContain("The connected engine is SQL");

    const graph = buildDashboardMessages({
      databaseType: "neo4j",
      questionBlock: "question",
      schemaBlock: "schema",
      historyBlock: "history",
      boardBlock: "",
    });
    expect(graph[0]?.content).toContain("The connected engine is neo4j");
    expect(graph[0]?.content).toContain("sql is one read-only Cypher statement for this engine. Do not write SQL.");
    expect(graph[0]?.content).not.toContain("one read-only statement for this engine.");
  });
});
