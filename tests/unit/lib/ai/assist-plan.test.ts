import { describe, expect, test } from "bun:test";
import { queryIdentity } from "@/lib/charts/query-filters";
import {
  acceptAssistPlan,
  buildAssistMessages,
  explanationWithEdits,
  parseAssistPlan,
  assistChartColor,
  questionOnlyRecolors,
  recolorsFromQuestion,
  requestedChartColor,
  splitAssistFollowUp,
  readAssistRequest,
  type AssistQueryPlan,
} from "@/lib/ai/assist-plan";

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
      chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month", color: null },
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

  test("keeps a colour the model named and drops one it invented", () => {
    const plan = parseAssistPlan(
      JSON.stringify({
        queries: [
          { title: "A", sql: select, chart: { type: "bar", x: "month", y: [" revenue "], color: " Purple " } },
          { title: "B", sql: "SELECT 2", chart: { type: "line", x: "month", y: ["revenue"], color: "rainbow" } },
        ],
      }),
    );
    expect(plan.queries[0]?.chart).toEqual({
      type: "bar",
      x: "month",
      y: ["revenue"],
      caption: "",
      color: "#9546de",
    });
    expect(plan.queries[1]?.chart?.color).toBeNull();
  });

  test("keeps a filter placeholder whose default would look like SELECT INTO", () => {
    const sql = "SELECT month FROM orders WHERE note = {{note:into|into,out}}";
    const plan = parseAssistPlan(JSON.stringify({ queries: [{ title: "Notes", sql }] }));
    expect(plan.queries[0]?.sql).toBe(sql);
    const literal = parseAssistPlan(
      JSON.stringify({
        queries: [{ sql: "SELECT month, revenue FROM orders WHERE region = 'east' AND total >= 10 LIMIT 200" }],
      }),
    );
    expect(literal.queries[0]?.sql).toBe(
      "SELECT month, revenue FROM orders WHERE region = {{region:east}} AND total >= {{total:10}} LIMIT 200",
    );
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
    const gateway = readAssistRequest({
      source: "gateway",
      model: "alibaba/qwen-3-14b",
      apiKey: "gw",
      question: "What changed?",
    });
    expect(gateway.ok).toBe(true);
    if (!gateway.ok) return;
    expect(gateway.value.source).toBe("gateway");
    expect(gateway.value.model).toBe("alibaba/qwen-3-14b");
  });

  test("trims a key and keeps earlier turns", () => {
    const parsed = request({ apiKey: "  secret  ", history: [{ question: "a", explanation: "b" }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.apiKey).toBe("secret");
    expect(parsed.value.history).toEqual([{ question: "a", explanation: "b" }]);
  });

  test.each([
    [{ source: "other" }, "Choose OpenRouter, Fireworks, or Vercel AI Gateway."],
    [{ source: 4 }, "Choose OpenRouter, Fireworks, or Vercel AI Gateway."],
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
    expect(messages[0]?.content).toContain("User-edited query (leave it unchanged):");
    expect(messages[0]?.content).toContain("chart.color");
    expect(messages[0]?.content).toContain("{{region:east|east,west,north}}");
    expect(messages[0]?.content).toContain("rather than defaulting to bar");
    expect(messages[0]?.content).toContain("A measure over time, including months or dates, is line.");
    expect(messages[0]?.content).toContain("total >= {{total:10}}");
    expect(messages[0]?.content).toContain("region AS area is filtered as region = {{region:east}}");
    expect(messages[0]?.content).toContain("was renamed or removed");
    expect(messages[0]?.content).toContain(">=, <=, or =");
    expect(messages[0]?.content).toContain("You have not seen the rows yet.");
  });
});

describe("assistChartColor", () => {
  test("accepts a hex colour and a named colour, and drops anything else", () => {
    expect(assistChartColor(" #9546DE ")).toBe("#9546de");
    expect(assistChartColor("Purple")).toBe("#9546de");
    expect(assistChartColor("rainbow")).toBeNull();
    expect(assistChartColor("#fff")).toBeNull();
    expect(assistChartColor(1)).toBeNull();
  });
});

describe("queries the user edited", () => {
  const revenue: AssistQueryPlan = {
    title: "Revenue",
    sql: "SELECT month, revenue FROM orders",
    connection: "Orders",
    chart: null,
  };
  const spend: AssistQueryPlan = {
    title: "Spend",
    sql: "SELECT region, sum(cost) AS spend FROM sales",
    connection: "Orders",
    chart: null,
  };

  test("leaves an edited statement out, recolors a matching one, and keeps a different one", () => {
    expect(
      splitAssistFollowUp([revenue, spend], [{ sql: "  SELECT month, revenue FROM orders  ", locked: true }]),
    ).toEqual({
      recolors: [],
      queries: [spend],
    });
    expect(splitAssistFollowUp([revenue], [])).toEqual({ recolors: [], queries: [revenue] });
    expect(
      splitAssistFollowUp(
        [revenue],
        [
          { sql: revenue.sql, locked: true },
          { sql: revenue.sql, locked: false },
        ],
      ),
    ).toEqual({ recolors: [], queries: [revenue] });
    const colored: AssistQueryPlan = {
      ...revenue,
      chart: { type: "bar", x: "month", y: ["revenue"], caption: "", color: "#9546de" },
    };
    expect(splitAssistFollowUp([colored], [{ sql: `  ${revenue.sql}  `, locked: true }])).toEqual({
      recolors: [{ sql: revenue.sql, color: "#9546de" }],
      queries: [],
    });
    expect(splitAssistFollowUp([colored], [])).toEqual({ recolors: [], queries: [colored] });
    const east = "SELECT month, revenue FROM orders WHERE region = {{region:east|east,west}}";
    const west = "SELECT month, revenue FROM orders WHERE region = {{region:west|east,west}}";
    const filtered = {
      ...colored,
      sql: west,
      chart: colored.chart === null ? null : { ...colored.chart, color: "#e66767" },
    };
    expect(splitAssistFollowUp([filtered], [{ sql: east, locked: true }])).toEqual({
      recolors: [{ sql: queryIdentity(west), color: "#e66767" }],
      queries: [],
    });
    expect(
      splitAssistFollowUp(
        [{ ...colored, sql: "SELECT  month, revenue\nFROM orders LIMIT 50" }],
        [{ sql: `${revenue.sql} LIMIT 200;`, locked: true }],
      ),
    ).toEqual({
      recolors: [{ sql: revenue.sql, color: "#9546de" }],
      queries: [],
    });
  });

  test("reads a colour from the question and paints the chart it names", () => {
    expect(requestedChartColor("show spend by region in purple")).toBeNull();
    expect(requestedChartColor("purple")).toBe("#9546de");
    expect(requestedChartColor("make it purple")).toBe("#9546de");
    expect(requestedChartColor("change the color to red")).toBe("#e66767");
    expect(requestedChartColor("change the revenue chart to pink")).toBe("#d55181");
    expect(requestedChartColor("make them #3987E5")).toBe("#3987e5");
    expect(requestedChartColor("change it from blue to red")).toBe("#e66767");
    expect(requestedChartColor(`please redraw this long chart so the bars are purple ${"x".repeat(40)}`)).toBeNull();
    expect(questionOnlyRecolors("make it purple")).toBe(true);
    expect(questionOnlyRecolors("make it red and show spend")).toBe(false);
    expect(questionOnlyRecolors(`change the colour to teal ${"y".repeat(80)}`)).toBe(false);
    expect(questionOnlyRecolors("show spend by region in purple")).toBe(false);
    const revenue = { sql: "SELECT month, revenue FROM orders LIMIT 200", title: "Revenue" };
    const count = { sql: "SELECT 1", title: "Count" };
    expect(recolorsFromQuestion("hello", [revenue])).toEqual([]);
    expect(recolorsFromQuestion("make it purple", [])).toEqual([]);
    expect(recolorsFromQuestion("change the revenue chart to pink", [revenue, count])).toEqual([
      { sql: "SELECT month, revenue FROM orders", color: "#d55181" },
    ]);
    expect(recolorsFromQuestion("make both red", [revenue, count])).toEqual([
      { sql: "SELECT month, revenue FROM orders", color: "#e66767" },
      { sql: "SELECT 1", color: "#e66767" },
    ]);
    expect(recolorsFromQuestion("purple", [revenue, { sql: "SELECT 2", title: "n" }])).toEqual([
      { sql: "SELECT 2", color: "#9546de" },
    ]);
  });

  test("names the edited statement for the next answer and stays within the history limit", () => {
    expect(explanationWithEdits("Revenue rose.", [])).toBe("Revenue rose.");
    expect(explanationWithEdits("Revenue rose.", ["  ", "SELECT region, cost FROM sales"])).toBe(
      "Revenue rose.\nUser-edited query (leave it unchanged): SELECT region, cost FROM sales",
    );
    const long = explanationWithEdits("Revenue rose.", ["x".repeat(5000)]);
    expect(long.startsWith("Revenue rose.\nUser-edited query (leave it unchanged):")).toBe(true);
    expect(long).toHaveLength(4000);
  });
});
