import { describe, expect, test } from "bun:test";
import { buildEditorMessages, EDITOR_SQL_CAP, readEditorSql } from "@/lib/ai/editor-prompt";

describe("readEditorSql", () => {
  test("keeps a statement and refuses anything else", () => {
    expect(readEditorSql("SELECT 1")).toEqual({ ok: true, value: "SELECT 1" });
    expect(readEditorSql("")).toEqual({ ok: true, value: "" });
    expect(readEditorSql("x".repeat(EDITOR_SQL_CAP)).ok).toBe(true);
    expect(readEditorSql(4)).toEqual({ ok: false, error: "The current query is not valid." });
    expect(readEditorSql(null)).toEqual({ ok: false, error: "The current query is not valid." });
    expect(readEditorSql("x".repeat(EDITOR_SQL_CAP + 1))).toEqual({
      ok: false,
      error: "The current query is too long.",
    });
  });
});

describe("buildEditorMessages", () => {
  test("names the engine and treats the fenced blocks as data", () => {
    const named = buildEditorMessages({
      databaseType: "postgres",
      questionBlock: "question",
      schemaBlock: "schema",
      historyBlock: "history",
      editorBlock: "SELECT 1",
    });
    expect(named[0]?.content).toContain("The connected engine is postgres");
    expect(named[0]?.content).toContain("queries has one item");
    expect(named[0]?.content).toContain("a description of the field");
    expect(named[1]?.content).toContain("Current statement:\nSELECT 1");
    expect(named[1]?.content).toContain("Question:\nquestion");
    expect(named[1]?.content).toContain("Schema:\nschema");
    expect(named[1]?.content).toContain("Earlier turns:\nhistory");

    const plain = buildEditorMessages({
      databaseType: "",
      questionBlock: "",
      schemaBlock: "",
      historyBlock: "",
      editorBlock: "",
    });
    expect(plain[0]?.content).toContain("The connected engine is SQL");
  });
});
