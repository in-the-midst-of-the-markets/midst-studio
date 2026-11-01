import { describe, expect, test } from "bun:test";
import { acceptAssistPlan, buildAssistMessages, parseAssistPlan, readAssistRequest } from "@/lib/ai/assist-plan";

const select = "SELECT month, revenue FROM orders LIMIT 200";

function request(overrides: Record<string, unknown> = {}) {
  return readAssistRequest({
    source: "openrouter",
    model: "openai/gpt-4o",
    apiKey: "key",
    question: "What changed?",
    schemaContext: "[]",
    databaseType: "postgres",
    history: [],
    ...overrides,
  });
}

describe("parseAssistPlan", () => {
  test("keeps prose that has no JSON object", () => {
    expect(parseAssistPlan("Revenue rose.")).toEqual({ explanation: "Revenue rose.", queries: [] });
  });

  test("reads a fenced JSON object and drops anything that is not a read", () => {
    const plan = parseAssistPlan(
      `\`\`\`json\n${JSON.stringify({
        explanation: "Revenue rose.",
        queries: [
          { title: "Revenue", sql: select, chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month" } },
          { title: "", sql: "DELETE FROM orders", chart: { type: "pie", x: "", y: [], caption: 1 } },
          { sql: "SELECT 1" },
          { title: "Extra", sql: "SELECT 2" },
          "nope",
          { sql: "" },
        ],
      })}\n\`\`\``,
    );
    expect(plan.explanation).toBe("Revenue rose.");
    expect(plan.queries).toHaveLength(3);
    expect(plan.queries[0]).toEqual({
      title: "Revenue",
      sql: select,
      connection: "",
      chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month" },
    });
    expect(plan.queries[1]?.title).toBe("Query");
    expect(plan.queries[1]?.chart).toBeNull();
  });

  test("drops a chart that does not name columns and keeps three queries", () => {
    const plan = parseAssistPlan(
      JSON.stringify({
        explanation: 4,
        queries: [
          {
            title: "A",
            sql: select,
            chart: { type: "line", x: "month", y: ["revenue", "cost", "tax", "fee", "extra"] },
          },
          { title: "B", sql: select, chart: { type: "nope", x: "month", y: ["revenue"] } },
          { title: "C", sql: select, chart: { type: "bar", x: " ", y: ["revenue"] } },
          { title: "D", sql: select, chart: { type: "bar", x: "month", y: [""] } },
          { title: "E", sql: select, chart: null },
        ],
      }),
    );
    expect(plan.explanation).toBe("");
    expect(plan.queries).toHaveLength(3);
    expect(plan.queries[0]?.chart?.y).toEqual(["revenue", "cost", "tax", "fee"]);
    expect(plan.queries[1]?.chart).toBeNull();
    expect(plan.queries[2]?.chart).toBeNull();

    const blanks = parseAssistPlan(
      JSON.stringify({
        queries: [
          { title: "D", sql: select, chart: { type: "bar", x: "month", y: [""] } },
          { title: "E", sql: select, chart: null },
        ],
      }),
    );
    expect(blanks.queries[0]?.chart).toBeNull();
    expect(blanks.queries[1]?.chart).toBeNull();
  });

  test("keeps a quote that the model escaped inside the JSON", () => {
    expect(parseAssistPlan('{"explanation":"say \\"hi\\"","queries":[]}').explanation).toBe('say "hi"');
  });

  test("treats an object that does not parse as prose", () => {
    expect(parseAssistPlan("{not json}").explanation).toBe("{not json}");
    expect(parseAssistPlan('{"explanation": "Hi"').queries).toEqual([]);
  });

  test("ignores a queries value that is not a list", () => {
    expect(parseAssistPlan('{"explanation":"Hi","queries":{}}').queries).toEqual([]);
  });

  test("keeps the connection a query names", () => {
    const named = parseAssistPlan(
      JSON.stringify({ queries: [{ title: "A", connection: "  Logs  ", sql: select, chart: null }] }),
    );
    expect(named.queries[0]?.connection).toBe("Logs");
    const numbered = parseAssistPlan(JSON.stringify({ queries: [{ connection: 4, sql: select }] }));
    expect(numbered.queries[0]?.connection).toBe("");
    const long = parseAssistPlan(JSON.stringify({ queries: [{ connection: "x".repeat(250), sql: select }] }));
    expect(long.queries[0]?.connection).toHaveLength(200);
  });
});

describe("acceptAssistPlan", () => {
  test("accepts text, an object, and anything else", () => {
    expect(acceptAssistPlan("Just text").explanation).toBe("Just text");
    expect(acceptAssistPlan({ explanation: "Hi", queries: [] }).explanation).toBe("Hi");
    expect(acceptAssistPlan(null)).toEqual({ explanation: "", queries: [] });
    expect(acceptAssistPlan(4)).toEqual({ explanation: "", queries: [] });
  });
});

describe("readAssistRequest", () => {
  test("accepts a complete question and fills optional fields", () => {
    const parsed = readAssistRequest({
      source: "fireworks",
      model: "accounts/acme/models/tuned",
      question: "  What changed?  ",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.question).toBe("What changed?");
    expect(parsed.value.apiKey).toBe("");
    expect(parsed.value.history).toEqual([]);
    expect(parsed.value.databaseType).toBe("");
  });

  test("trims a key and keeps earlier turns", () => {
    const parsed = request({ apiKey: "  secret  ", history: [{ question: "a", explanation: "b" }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.apiKey).toBe("secret");
    expect(parsed.value.history).toEqual([{ question: "a", explanation: "b" }]);
  });

  test.each([
    [{ source: "other" }, "Choose OpenRouter or Fireworks."],
    [{ model: "bad model" }, "Name the model to use."],
    [{ model: "" }, "Name the model to use."],
    [{ apiKey: 1 }, "The API key is not valid."],
    [{ apiKey: "line\nbreak" }, "The API key is not valid."],
    [{ question: "   " }, "Ask a question first."],
    [{ question: 1 }, "Ask a question first."],
    [{ schemaContext: 1 }, "The schema is not valid."],
    [{ databaseType: "Postgres" }, "The database type is not valid."],
    [{ databaseType: "post\ngres" }, "The database type is not valid."],
    [{ history: {} }, "The earlier conversation is not valid."],
    [{ history: [{ question: 1, explanation: "b" }] }, "The earlier conversation is not valid."],
    [{ history: new Array(7).fill({ question: "a", explanation: "b" }) }, "The earlier conversation is not valid."],
  ])("rejects %j", (overrides, error) => {
    const parsed = request(overrides);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(error);
  });

  test("rejects a question, a schema, and a turn that are too long", () => {
    expect(request({ question: "a".repeat(4001) }).ok).toBe(false);
    expect(request({ schemaContext: "a".repeat(30_001) }).ok).toBe(false);
    expect(request({ history: [{ question: "a".repeat(4001), explanation: "b" }] }).ok).toBe(false);
    expect(request({ apiKey: "a".repeat(501) }).ok).toBe(false);
  });
});

describe("buildAssistMessages", () => {
  test("names the engine and places the fenced blocks in the user turn", () => {
    const messages = buildAssistMessages({
      databaseType: "postgres",
      questionBlock: "FENCED-QUESTION",
      schemaBlock: "FENCED-SCHEMA",
      historyBlock: "FENCED-HISTORY",
    });
    expect(messages[0]?.content).toContain("postgres");
    expect(messages[0]?.content).not.toContain("FENCED-SCHEMA");
    expect(messages[1]?.content).toContain("FENCED-QUESTION");
    expect(messages[1]?.content).toContain("FENCED-SCHEMA");
    expect(messages[1]?.content).toContain("FENCED-HISTORY");
  });

  test("says SQL when no engine was named", () => {
    const messages = buildAssistMessages({
      databaseType: "",
      questionBlock: "q",
      schemaBlock: "s",
      historyBlock: "h",
    });
    expect(messages[0]?.content).toContain("The connected engine is SQL.");
    expect(messages[0]?.content).toContain("every connected database");
  });
});
