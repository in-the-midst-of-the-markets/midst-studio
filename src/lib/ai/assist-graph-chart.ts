/**
 * A chart for a Neo4j result the model's shelves cannot draw.
 *
 * A relationship or a path becomes a graph of the records it names. Nodes with
 * no relationship become a bar of how many carry each label. Rows that are
 * already numbers and categories are left to the ordinary chart.
 */

import { nextAssistChoice, type AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import { buildChartOption } from "@/lib/charts/echarts-option";
import { captionOf } from "@/lib/db/graph/result-graph";
import { isGraphValueJson, type GraphNodeJson, type GraphRelationshipJson } from "@/lib/db/graph/values";
import type { QueryResult } from "@/lib/types";

const WALK_DEPTH = 8;

export interface AssistGraphDraw {
  readonly choice: AssistChartChoice;
  readonly rows: readonly Record<string, unknown>[];
}

function walk(cell: unknown, depth: number, visit: (value: GraphNodeJson | GraphRelationshipJson) => void): void {
  if (typeof cell !== "object" || cell === null || depth > WALK_DEPTH) return;
  if (isGraphValueJson(cell)) {
    if (cell["~graph"] === "path") {
      for (const member of [...cell.nodes, ...cell.relationships]) walk(member, depth + 1, visit);
      return;
    }
    visit(cell);
    return;
  }
  const items = Array.isArray(cell) ? cell : Object.values(cell);
  for (const item of items) walk(item, depth + 1, visit);
}

function collect(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
): {
  nodes: Map<string, GraphNodeJson>;
  relationships: GraphRelationshipJson[];
} {
  const nodes = new Map<string, GraphNodeJson>();
  const relationships: GraphRelationshipJson[] = [];
  const seen = new Set<string>();
  const visit = (value: GraphNodeJson | GraphRelationshipJson): void => {
    if (value["~graph"] === "node") {
      nodes.set(value.elementId, value);
      return;
    }
    if (seen.has(value.elementId)) return;
    seen.add(value.elementId);
    relationships.push(value);
  };
  for (const row of rows) {
    for (const field of fields) walk(row[field], 1, visit);
  }
  return { nodes, relationships };
}

function namesOf(nodes: ReadonlyMap<string, GraphNodeJson>): (id: string) => string {
  const captions = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const [id, node] of nodes) {
    const caption = captionOf(node);
    captions.set(id, caption);
    counts.set(caption, (counts.get(caption) ?? 0) + 1);
  }
  return (id: string): string => {
    const node = nodes.get(id);
    if (node === undefined) return id;
    const caption = captions.get(id) ?? id;
    if ((counts.get(caption) ?? 0) <= 1) return caption;
    return `${caption} (${id.slice(-4)})`;
  };
}

/** Links or label counts from graph values, or null when the rows have none. */
export function assistGraphChart(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
): AssistGraphDraw | null {
  const { nodes, relationships } = collect(rows, fields);
  if (nodes.size === 0 && relationships.length === 0) return null;
  const nameOf = namesOf(nodes);
  const links: Record<string, unknown>[] = [];
  for (const relationship of relationships) {
    const source = nameOf(relationship.startNodeElementId);
    const target = nameOf(relationship.endNodeElementId);
    if (source === target) continue;
    links.push({ source, target });
  }
  if (links.length > 0) {
    return {
      choice: {
        typeId: "graph",
        variationId: "force",
        selection: { source: ["source"], target: ["target"], weight: [] },
      },
      rows: links,
    };
  }
  if (nodes.size === 0) return null;
  const counts = new Map<string, number>();
  for (const node of nodes.values()) {
    const label = node.labels[0] ?? "Unlabeled";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return {
    choice: {
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["label"], values: ["count"] },
    },
    rows: [...counts].map(([label, count]) => ({ label, count })),
  };
}

function choiceDraws(choice: AssistChartChoice, result: QueryResult): boolean {
  return (
    buildChartOption({
      typeId: choice.typeId,
      variationId: choice.variationId,
      rows: result.rows,
      selection: choice.selection,
    }) !== null
  );
}

/**
 * The chart to draw for this result.
 * A choice that already draws keeps its rows. Otherwise a graph result supplies
 * the links or the label counts.
 */
export function assistChartForResult(choice: AssistChartChoice | null, result: QueryResult): AssistGraphDraw | null {
  if (choice !== null && choiceDraws(choice, result)) return { choice, rows: result.rows };
  return assistGraphChart(result.rows, result.fields);
}

/** The choice and any projected rows for a result that just arrived. */
export function openAssistChart(
  chart: AssistChart | null,
  result: QueryResult | null,
  previous: AssistChartChoice | null,
): { choice: AssistChartChoice | null; projected: readonly Record<string, unknown>[] | null } {
  const next = nextAssistChoice(chart, result, previous);
  if (result === null || result.rows.length === 0) return { choice: next, projected: null };
  const drawn = assistChartForResult(next, result);
  return {
    choice: drawn?.choice ?? next,
    projected: drawn !== null && drawn.rows !== result.rows ? drawn.rows : null,
  };
}

/** Projected rows when the choice names columns this result does not have. */
export function assistDrawRows(
  choice: AssistChartChoice,
  result: QueryResult,
  projected: readonly Record<string, unknown>[] | null,
): readonly Record<string, unknown>[] {
  if (projected === null) return result.rows;
  const names = [
    choice.selection.source?.[0],
    choice.selection.target?.[0],
    choice.selection.category?.[0],
    ...(choice.selection.values ?? []),
  ];
  const missing = names.some((name) => name !== undefined && !result.fields.includes(name));
  return missing ? projected : result.rows;
}
