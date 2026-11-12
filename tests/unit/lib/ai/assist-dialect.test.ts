import { describe, expect, test } from "bun:test";
import { isAssistRead } from "@/lib/ai/assist-language";
import {
  assistAllowsSql,
  assistNativeRead,
  assistSampleSql,
  assistStatementRule,
  assistValueRule,
} from "@/lib/ai/assist-dialect";
import { parseAssistPlan } from "@/lib/ai/assist-plan";
import { buildEditorMessages } from "@/lib/ai/editor-prompt";
import { SAAS_PICKER_TYPES } from "@/lib/db/connection-form";

const KNN = `POST company_profiles/_search
{"query":{"knn":{"description_embedding":{"vector": {{radiators}}, "k": 10}}}}`;

describe("assistStatementRule", () => {
  test("names the request the editor runs, and the SQL subset of each connection", () => {
    expect(assistStatementRule("")).toBe("sql is one read-only statement for this engine.");
    expect(assistStatementRule("postgres")).toBe("sql is one read-only statement for this engine.");
    expect(assistStatementRule("neo4j")).toBe(
      "sql is one read-only Cypher statement for this engine. Do not write SQL.",
    );
    expect(assistStatementRule("opensearch")).toContain("The editor runs that request as written.");
    expect(assistStatementRule("opensearch")).toContain("Dynamic embeddings");
    expect(assistStatementRule("opensearch")).toContain("{{search:car}}");
    expect(assistStatementRule("opensearch")).toContain('{{embed "text"}}');
    expect(assistStatementRule("elasticsearch")).toContain("company_profiles/_search");
    expect(assistStatementRule("milvus")).toContain("Ignore the list of numbers");
    expect(assistStatementRule("milvus")).toContain("POST /v2/vectordb/");
    expect(assistStatementRule("qdrant")).toContain("A Qdrant request");
    expect(assistStatementRule("weaviate")).toContain("A Weaviate REST request");
    expect(assistStatementRule("weaviate")).toContain("Do not write SQL");
    expect(assistStatementRule("weaviate")).toContain("POST /v1/search/CompanyProfile/near-vector");
    expect(assistStatementRule("weaviate")).toContain("$certainty");
    expect(assistStatementRule("milvus")).toContain("Do not write SQL");
    expect(assistStatementRule("airtable")).toContain("one table");
    expect(assistStatementRule("hubspot")).toContain("one CRM object");
    expect(assistStatementRule("stripe")).toContain("Stripe Sigma");
    expect(assistStatementRule("clarity")).toContain("WHERE days = 1, 2, or 3");
    expect(assistStatementRule("googleanalytics")).toContain("NdaysAgo");
    expect(assistStatementRule("quickbooks")).toContain("one entity");
    expect(assistStatementRule("odoo")).toContain("one model");
    expect(assistStatementRule("shopify")).toContain("ShopifyQL");
    expect(assistStatementRule("shopify")).toContain("Do not write SELECT");
    expect(assistStatementRule("supabase")).toContain("Postgres");
    expect(assistStatementRule("redshift")).toContain("Amazon Redshift");
    expect(assistStatementRule("cockroach")).toContain("CockroachDB");
    expect(assistStatementRule("duckdb")).toContain("array_cosine_distance");
    expect(assistStatementRule("duckdb")).toContain("pagerank");
    expect(assistStatementRule("mixpanel")).toContain("Mixpanel");
    expect(assistStatementRule("paypal")).toContain("PayPal");
    expect(assistStatementRule("excel")).toContain("Excel");
    expect(assistStatementRule("googlesheets")).toContain("Google Sheets");
  });
});

describe("assistSampleSql", () => {
  test("describes the statement without quotes", () => {
    expect(assistSampleSql("postgres")).toBe("one read-only SELECT with LIMIT 200");
    expect(assistSampleSql("neo4j")).toBe("one read-only Cypher statement");
    expect(assistSampleSql("opensearch")).toBe(
      "POST index/_search then one JSON object, and the vector value is {{search:car}}",
    );
    expect(assistSampleSql("milvus")).toBe(
      "one read request in this engine's language, and the vector value is {{search:car}}",
    );
    expect(assistSampleSql("airtable")).toBe("one read-only SELECT with LIMIT 200");
    expect(assistSampleSql("shopify")).toBe("FROM sales SHOW total_sales");
    expect(assistSampleSql("redshift")).toBe("one read-only SELECT with LIMIT 200");
    expect(assistSampleSql("cockroach")).toBe("one read-only SELECT with LIMIT 200");
    expect(assistSampleSql("")).toBe("one read-only SELECT with LIMIT 200");
  });
});

describe("assistValueRule", () => {
  test("teaches chart filters to SQL and embeddings to a vector search", () => {
    expect(assistValueRule("postgres")).toContain("{{region:east|east,west,north}}");
    expect(assistValueRule("airtable")).toContain("total >= {{total:10}}");
    expect(assistValueRule("neo4j")).toContain("the studio draws the graph");
    expect(assistValueRule("opensearch")).toContain("Do not add a chart-filter placeholder");
    expect(assistValueRule("qdrant")).not.toContain("{{region:east|east,west,north}}");
    expect(assistValueRule("weaviate")).toContain("$certainty");
    expect(assistAllowsSql("postgres")).toBe(true);
    expect(assistAllowsSql("opensearch")).toBe(true);
    expect(assistAllowsSql("airtable")).toBe(true);
    expect(assistAllowsSql("weaviate")).toBe(false);
    expect(assistAllowsSql("milvus")).toBe(false);
    expect(assistAllowsSql("qdrant")).toBe(false);
    expect(assistAllowsSql("shopify")).toBe(false);
    expect(assistAllowsSql("redshift")).toBe(true);
    expect(assistAllowsSql("cockroach")).toBe(true);
    expect(assistAllowsSql("")).toBe(true);
    expect(assistValueRule("")).toContain("{{region:east|east,west,north}}");
  });
});

describe("assistNativeRead", () => {
  test("keeps a Dev Tools search, including the embedding token", () => {
    expect(assistNativeRead("opensearch", KNN)).toBe(true);
    expect(assistNativeRead("elasticsearch", KNN)).toBe(true);
    expect(assistNativeRead("opensearch", "GET company_profiles/_search")).toBe(true);
    expect(assistNativeRead("opensearch", "POST company_profiles/_count")).toBe(true);
    expect(
      assistNativeRead("opensearch", '# nearest\nPOST company_profiles/_search\n// kept\n{"query": {"match_all": {}}}'),
    ).toBe(true);
    expect(
      assistNativeRead("opensearch", 'POST company_profiles/_search\n{\n# inside\n"query": {"match_all": {}}\n}'),
    ).toBe(false);
    expect(assistNativeRead("opensearch", '\uFEFFPOST company_profiles/_search\n{"size": 1}')).toBe(true);
    expect(assistNativeRead("opensearch", "SELECT 1")).toBeNull();
    expect(assistNativeRead("opensearch", "")).toBeNull();
    expect(assistNativeRead("opensearch", "# only a comment")).toBeNull();
    expect(assistNativeRead("opensearch", "GET")).toBe(false);
    expect(assistNativeRead("opensearch", "POST company_profiles/_search\n{no")).toBe(false);
    expect(assistNativeRead("opensearch", "POST company_profiles/_search\n[1]")).toBe(false);
    expect(assistNativeRead("opensearch", "POST company_profiles/_search\nnull")).toBe(false);
    expect(assistNativeRead("opensearch", 'POST company_profiles/_update/1\n{"doc":{"a":1}}')).toBe(false);
    expect(assistNativeRead("opensearch", "DELETE company_profiles/_doc/1")).toBe(false);
    expect(assistNativeRead("postgres", KNN)).toBeNull();
    expect(assistNativeRead("nope", KNN)).toBeNull();
  });

  test("keeps a vector read and leaves SQL to the SQL gate", () => {
    const milvus = `POST /v2/vectordb/entities/search
{"collectionName":"docs","data":[{{cast iron radiators}}],"limit":5}`;
    expect(assistNativeRead("milvus", milvus)).toBe(true);
    expect(assistNativeRead("milvus", `POST entities/search\n{"collectionName":"docs","limit":5}`)).toBe(true);
    expect(assistNativeRead("milvus", "GET /v2/vectordb/entities/search")).toBe(false);
    expect(assistNativeRead("milvus", "POST /v2/vectordb/entities")).toBe(false);
    expect(assistNativeRead("milvus", "SELECT 1")).toBeNull();
    const qdrant = `POST /collections/docs/points/query?wait=true
{"query": {{cast iron}}, "limit": 5}`;
    expect(assistNativeRead("qdrant", qdrant)).toBe(true);
    expect(assistNativeRead("qdrant", "POST /collections/docs/points/nope")).toBe(false);
    expect(assistNativeRead("qdrant", "GET /collections/docs")).toBe(true);
    expect(assistNativeRead("qdrant", "\uFEFFPOST /collections/docs/points/count")).toBe(true);
    expect(assistNativeRead("qdrant", "# note\nPOST /collections/docs/points/count")).toBe(true);
    expect(assistNativeRead("qdrant", 'POST /collections/docs/points/count\n{\n# exact\n"exact": true\n}')).toBe(true);
    expect(assistNativeRead("qdrant", "POST /collections/docs/points/query\n[1]")).toBe(false);
    expect(assistNativeRead("qdrant", "POST /collections/docs/points/query\nnull")).toBe(false);
    expect(assistNativeRead("qdrant", "POST /collections/docs/points/query\n{no")).toBe(false);
    expect(assistNativeRead("milvus", "")).toBeNull();
    expect(assistNativeRead("milvus", "# only a comment")).toBeNull();
    expect(assistNativeRead("milvus", "GET")).toBe(false);
    const weaviate = `POST /v1/search/Article/near-vector
{"vector": {{cast iron radiators}}}`;
    expect(assistNativeRead("weaviate", weaviate)).toBe(true);
    expect(assistNativeRead("airtable", "SELECT 1")).toBeNull();
    expect(assistNativeRead("hubspot", "SELECT 1")).toBeNull();
    expect(assistNativeRead("stripe", "SELECT 1")).toBeNull();
    expect(assistNativeRead("clarity", "SELECT 1")).toBeNull();
    expect(assistNativeRead("googleanalytics", "SELECT 1")).toBeNull();
    expect(assistNativeRead("quickbooks", "SELECT 1")).toBeNull();
    expect(assistNativeRead("odoo", "SELECT 1")).toBeNull();
    expect(assistNativeRead("shopify", "FROM sales SHOW total_sales")).toBe(true);
    expect(assistNativeRead("shopify", "SELECT 1")).toBe(false);
    expect(assistNativeRead("shopify", "DELETE FROM sales")).toBe(false);
    expect(assistNativeRead("shopify", "FROM sales SHOW total_sales; FROM fees SHOW x")).toBe(false);
    expect(assistNativeRead("shopify", "")).toBe(false);
    expect(assistNativeRead("supabase", "SELECT 1")).toBeNull();
    expect(assistNativeRead("redshift", "SELECT 1")).toBeNull();
    expect(assistNativeRead("cockroach", "SELECT 1")).toBeNull();
  });
});

const IDE_ENGINES = [...SAAS_PICKER_TYPES, "airtable", "supabase", "redshift", "cockroach"] as const;
const GENERIC_RULE = "sql is one read-only statement for this engine.";

function readFor(type: string): string {
  return type === "shopify" ? "FROM sales SHOW total_sales" : "SELECT 1";
}

describe("the IDE chat", () => {
  test("keeps a read for every SaaS connector and the new SQL databases", () => {
    for (const type of IDE_ENGINES) {
      const rule = assistStatementRule(type);
      expect(rule).not.toBe(GENERIC_RULE);
      const sql = readFor(type);
      expect(isAssistRead(sql, type)).toBe(true);
      expect(isAssistRead("DELETE FROM t", type)).toBe(false);
      const prompt = buildEditorMessages({
        databaseType: type,
        questionBlock: "q",
        schemaBlock: "schema",
        historyBlock: "",
        editorBlock: "",
      });
      expect(prompt[0]?.content).toContain(`The connected engine is ${type}`);
      expect(prompt[0]?.content).toContain(rule);
      const plan = parseAssistPlan(
        JSON.stringify({
          explanation: "ok",
          queries: [{ title: "Query", connection: "c", sql, chart: null }],
        }),
        type,
      );
      expect(plan.queries).toEqual([expect.objectContaining({ sql })]);
    }
    expect(isAssistRead("SELECT 1", "shopify")).toBe(false);
  });
});
