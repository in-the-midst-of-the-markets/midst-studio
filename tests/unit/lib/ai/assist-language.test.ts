import { describe, expect, test } from "bun:test";
import { assistRunnableStatement, assistStatementLanguage, isAssistRead } from "@/lib/ai/assist-language";

const MATCH = "MATCH (n) WHERE n.name = 'Ada' RETURN n LIMIT 5";

describe("assistStatementLanguage", () => {
  test("names a known engine and ignores one this chat has not heard of", () => {
    expect(assistStatementLanguage("neo4j")).toBe("cypher");
    expect(assistStatementLanguage("postgres")).toBe("sql");
    expect(assistStatementLanguage("databend")).toBeNull();
    expect(assistStatementLanguage("")).toBeNull();
    expect(assistStatementLanguage("nope")).toBeNull();
  });
});

describe("isAssistRead", () => {
  test("keeps a Cypher read and drops SQL and writes on Neo4j", () => {
    expect(isAssistRead(MATCH, "neo4j")).toBe(true);
    expect(isAssistRead("SHOW DATABASES", "neo4j")).toBe(true);
    expect(isAssistRead("MATCH (n) RETURN n // a note", "neo4j")).toBe(true);
    expect(isAssistRead("SELECT 1", "neo4j")).toBe(false);
    expect(isAssistRead("  EXPLAIN SELECT 1", "neo4j")).toBe(false);
    expect(isAssistRead("CREATE (n) RETURN n", "neo4j")).toBe(false);
    expect(isAssistRead("MATCH (n) RETURN n; MATCH (m) RETURN m", "neo4j")).toBe(false);
    expect(isAssistRead("MATCH (n) WHERE n.name = $name RETURN n", "neo4j")).toBe(false);
  });

  test("keeps a SQL read on every other engine", () => {
    expect(isAssistRead("SELECT 1", "postgres")).toBe(true);
    expect(isAssistRead("SELECT 1", "")).toBe(true);
    expect(isAssistRead("SELECT 1", "databend")).toBe(true);
    expect(isAssistRead("SELECT 1", "nope")).toBe(true);
    expect(isAssistRead(MATCH, "postgres")).toBe(false);
    expect(isAssistRead("DELETE FROM orders", "postgres")).toBe(false);
  });
});

describe("assistRunnableStatement", () => {
  test("fills a SQL placeholder and leaves Cypher as written", () => {
    expect(assistRunnableStatement("SELECT 1", "postgres")).toBe("SELECT 1");
    expect(assistRunnableStatement("DELETE FROM orders", "postgres")).toBeNull();
    expect(assistRunnableStatement("SELECT region FROM t WHERE region = {{region:east}}", "postgres")).toBe(
      "SELECT region FROM t WHERE region = 'east'",
    );
    expect(assistRunnableStatement(MATCH, "neo4j")).toBe(MATCH);
    expect(assistRunnableStatement("CREATE (n)", "neo4j")).toBeNull();
    expect(assistRunnableStatement("SELECT 1", "neo4j")).toBeNull();
  });
});
