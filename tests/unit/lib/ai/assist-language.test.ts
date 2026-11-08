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

  test("keeps a search request the editor runs and drops it on SQL engines", () => {
    const search = `POST company_profiles/_search
{"query":{"knn":{"description_embedding":{"vector": {{radiators}}, "k": 10}}}}`;
    expect(isAssistRead(search, "opensearch")).toBe(true);
    expect(isAssistRead(search, "elasticsearch")).toBe(true);
    expect(isAssistRead("SELECT 1", "opensearch")).toBe(true);
    expect(isAssistRead(search, "postgres")).toBe(false);
    expect(isAssistRead('POST company_profiles/_update/1\n{"doc":{"name":"Ada"}}', "opensearch")).toBe(false);
    expect(isAssistRead("DELETE company_profiles/_doc/1", "opensearch")).toBe(false);
    const sql = "SELECT symbol FROM CompanyProfile NEAR VECTOR ({{dirtbike}}) ON $vector:name LIMIT 5";
    const near = `POST /v1/search/CompanyProfile/near-vector
{"vector": {{dirtbike}}, "targetVector": "name", "limit": 5, "returnMetadata": ["certainty"]}`;
    expect(isAssistRead(sql, "weaviate")).toBe(false);
    expect(isAssistRead(near, "weaviate")).toBe(true);
    expect(isAssistRead("SELECT 1", "milvus")).toBe(false);
    expect(isAssistRead("SELECT 1", "qdrant")).toBe(false);
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
    const search = `POST company_profiles/_search
{"query":{"knn":{"description_embedding":{"vector": {{radiators}}, "k": 10}}}}`;
    expect(assistRunnableStatement(search, "opensearch")).toBe(search);
    expect(assistRunnableStatement(search, "postgres")).toBeNull();
    expect(assistRunnableStatement("SELECT region FROM t WHERE region = {{region:east}}", "opensearch")).toBe(
      "SELECT region FROM t WHERE region = 'east'",
    );
    const near = `POST /v1/search/CompanyProfile/near-vector
{"vector": {{dirtbike}}, "targetVector": "name", "limit": 5, "returnMetadata": ["certainty"]}`;
    expect(assistRunnableStatement(near, "weaviate")).toBe(near);
    expect(
      assistRunnableStatement(
        "SELECT symbol FROM CompanyProfile NEAR VECTOR ({{dirtbike}}) ON $vector:name LIMIT 5",
        "weaviate",
      ),
    ).toBeNull();
  });
});
