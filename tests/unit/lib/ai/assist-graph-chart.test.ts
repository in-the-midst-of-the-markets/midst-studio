import { describe, expect, test } from "bun:test";
import { assistChartForResult, assistDrawRows, assistGraphChart, openAssistChart } from "@/lib/ai/assist-graph-chart";
import type { AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import { buildChartOption } from "@/lib/charts/echarts-option";
import type { QueryResult } from "@/lib/types";

function result(fields: string[], rows: Record<string, unknown>[]): QueryResult {
  return { fields, rows, rowCount: rows.length, executionTime: 1 };
}

function node(elementId: string, labels: string[], properties: Record<string, unknown> = {}) {
  return { "~graph": "node" as const, elementId, labels, properties };
}

function relationship(
  elementId: string,
  type: string,
  startNodeElementId: string,
  endNodeElementId: string,
  properties: Record<string, unknown> = {},
) {
  return {
    "~graph": "relationship" as const,
    elementId,
    type,
    startNodeElementId,
    endNodeElementId,
    properties,
  };
}

function seriesType(choice: AssistChartChoice, rows: readonly Record<string, unknown>[]): string | undefined {
  const built = buildChartOption({
    typeId: choice.typeId,
    variationId: choice.variationId,
    rows: [...rows],
    selection: choice.selection,
  });
  const series = built?.option.series;
  const first = Array.isArray(series) ? series[0] : null;
  return first !== null && typeof first === "object" && "type" in first && typeof first.type === "string"
    ? first.type
    : undefined;
}

const ada = node("4:ada", ["Person"], { name: "Ada" });
const grace = node("4:grace", ["Person"], { name: "Ada" });
const city = node("4:city", ["City"], { name: "London" });
const bare = node("4:bare", ["City"]);
const unlabeled = node("4:plain", [], { title: "Loose" });
const knows = relationship("5:knows", "KNOWS", "4:ada", "4:city");
const lives = relationship("5:lives", "LIVES_IN", "4:ada", "4:bare");
const loop = relationship("5:loop", "LOOP", "4:ada", "4:ada");

describe("assistGraphChart", () => {
  test("draws a relationship, a path, and a nested node as a graph", () => {
    const skipped = relationship("5:deep", "HID", "4:ada", "4:deep");
    let buried: unknown = skipped;
    for (let depth = 0; depth < 8; depth += 1) buried = { held: buried };
    const drawn = assistGraphChart(
      [
        {
          path: { "~graph": "path", nodes: [ada, city, bare], relationships: [knows, knows] },
          nested: { item: [lives] },
          note: "text",
          empty: null,
          buried,
        },
      ],
      ["path", "nested", "note", "empty", "buried"],
    );
    expect(drawn).toEqual({
      choice: {
        typeId: "graph",
        variationId: "force",
        selection: { source: ["source"], target: ["target"], weight: [] },
      },
      rows: [
        { source: "Ada", target: "London" },
        { source: "Ada", target: "City" },
      ],
    });
    expect(seriesType(drawn!.choice, drawn!.rows)).toBe("graph");
  });

  test("splits two nodes that share a caption and counts labels when nothing links", () => {
    const twin = relationship("5:twin", "KNOWS", "4:ada", "4:grace");
    const linked = assistGraphChart([{ a: ada, b: grace, r: twin }], ["a", "b", "r"]);
    expect(linked?.rows).toEqual([{ source: "Ada (:ada)", target: "Ada (race)" }]);
    const counted = assistGraphChart([{ a: ada, b: city, c: bare, d: unlabeled }], ["a", "b", "c", "d"]);
    expect(counted).toEqual({
      choice: {
        typeId: "bar",
        variationId: "basic",
        selection: { category: ["label"], values: ["count"] },
      },
      rows: [
        { label: "Person", count: 1 },
        { label: "City", count: 2 },
        { label: "Unlabeled", count: 1 },
      ],
    });
    expect(seriesType(counted!.choice, counted!.rows)).toBe("bar");
  });

  test("names a missing endpoint by its id and skips a relationship with no other node", () => {
    const orphan = relationship("5:orphan", "KNOWS", "4:left", "4:right");
    const drawn = assistGraphChart([{ r: orphan }], ["r"]);
    expect(drawn?.rows).toEqual([{ source: "4:left", target: "4:right" }]);
    expect(assistGraphChart([{ r: loop }], ["r"])).toBeNull();
    expect(assistGraphChart([{ p: { "~graph": "path", nodes: [], relationships: [] } }], ["p"])).toBeNull();
    expect(assistGraphChart([{ n: "Ada" }], ["n"])).toBeNull();
  });

  test("counts labels when every relationship stays on one node", () => {
    const drawn = assistGraphChart([{ n: ada, r: loop }], ["n", "r"]);
    expect(drawn?.choice.typeId).toBe("bar");
    expect(drawn?.rows).toEqual([{ label: "Person", count: 1 }]);
  });
});

describe("assistChartForResult", () => {
  test("keeps a choice that already draws and replaces one that does not", () => {
    const revenue = result(
      ["region", "revenue"],
      [
        { region: "East", revenue: 10 },
        { region: "West", revenue: 4 },
      ],
    );
    const bar: AssistChartChoice = {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["region"], values: ["revenue"] },
    };
    expect(assistChartForResult(bar, revenue)).toEqual({ choice: bar, rows: revenue.rows });
    const graphRows = result(["n", "r", "m"], [{ n: ada, r: knows, m: city }]);
    const unfit: AssistChartChoice = {
      typeId: "graph",
      variationId: "force",
      selection: { source: ["source"], target: ["target"] },
    };
    expect(assistChartForResult(unfit, graphRows)?.choice.typeId).toBe("graph");
    expect(assistChartForResult(unfit, graphRows)?.rows).toEqual([{ source: "Ada", target: "London" }]);
    const self = result(["source", "target"], [{ source: "Ada", target: "Ada" }]);
    expect(assistChartForResult(unfit, self)).toBeNull();
    expect(assistChartForResult(null, graphRows)?.rows).toEqual([{ source: "Ada", target: "London" }]);
  });
});

describe("openAssistChart", () => {
  test("projects graph links and leaves a chart that already fits", () => {
    expect(openAssistChart(null, null, null)).toEqual({ choice: null, projected: null });
    const empty = result(["n"], []);
    expect(openAssistChart(null, empty, null)).toEqual({ choice: null, projected: null });
    const nodesOnly = result(["n", "m"], [{ n: ada, m: city }]);
    const counted = openAssistChart(null, nodesOnly, null);
    expect(counted.choice?.typeId).toBe("bar");
    expect(counted.projected).toEqual([
      { label: "Person", count: 1 },
      { label: "City", count: 1 },
    ]);
    const graphRows = result(["n", "r", "m"], [{ n: ada, r: knows, m: city }]);
    const opened = openAssistChart(null, graphRows, null);
    expect(opened.choice?.typeId).toBe("graph");
    expect(opened.projected).toEqual([{ source: "Ada", target: "London" }]);
    const chart: AssistChart = { type: "bar", x: "region", y: ["revenue"], caption: "", color: null };
    const revenue = result(
      ["region", "revenue"],
      [
        { region: "East", revenue: 10 },
        { region: "West", revenue: 4 },
      ],
    );
    const fitted = openAssistChart(chart, revenue, null);
    expect(fitted.choice?.typeId).toBe("bar");
    expect(fitted.projected).toBeNull();
    const plain = result(["source", "target"], [{ source: "Ada", target: "Ada" }]);
    expect(openAssistChart(null, plain, null)).toEqual({ choice: null, projected: null });
  });
});

describe("assistDrawRows", () => {
  test("uses projected rows only while the choice names columns the result lacks", () => {
    const graphRows = result(["n"], [{ n: ada }]);
    const projected = [{ source: "Ada", target: "London" }];
    const graph: AssistChartChoice = {
      typeId: "graph",
      variationId: "force",
      selection: { source: ["source"], target: ["target"], weight: [] },
    };
    expect(assistDrawRows(graph, graphRows, null)).toBe(graphRows.rows);
    expect(assistDrawRows(graph, graphRows, projected)).toBe(projected);
    const present = result(["source", "target"], [{ source: "Ada", target: "London" }]);
    expect(assistDrawRows(graph, present, projected)).toBe(present.rows);
    const emptySelection: AssistChartChoice = { typeId: "graph", variationId: "force", selection: {} };
    expect(assistDrawRows(emptySelection, graphRows, projected)).toBe(graphRows.rows);
  });
});
