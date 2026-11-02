import { runAssistQuery } from "@/lib/ai/assist-query";
import { applyChartValues } from "@/lib/charts/chart-code";
import { buildChartOption, type BuiltChart } from "@/lib/charts/echarts-option";
import { withoutFilterLooks } from "@/lib/charts/filter-look";
import { applyQueryFilters } from "@/lib/charts/query-filters";
import { chartTheme, type ChartTheme } from "@/lib/charts/palette";
import { storedChartLook } from "@/lib/charts/save-chart";
import type { DatabaseConnection, QueryResult, SavedChartConfig } from "@/lib/types";

type Post = (path: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type SavedChartView =
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly result: QueryResult };

/**
 * Reruns the chart's query on its connection.
 * An empty query or a missing connection is a message, not a request.
 */
export async function loadSavedChart(
  chart: Pick<SavedChartConfig, "query" | "connectionId">,
  connections: readonly DatabaseConnection[],
  post: Post,
): Promise<SavedChartView> {
  const query = chart.query?.trim() ?? "";
  if (query === "") return { kind: "empty", message: "Save this chart with a query to fill it." };
  if (chart.connectionId === undefined || chart.connectionId === "") {
    return { kind: "empty", message: "This chart has no connection." };
  }
  const connection = connections.find((item) => item.id === chart.connectionId);
  if (connection === undefined) return { kind: "error", message: "That connection is no longer available." };
  const outcome = await runAssistQuery(connection, applyQueryFilters(query), post);
  if (!outcome.ok) return { kind: "error", message: outcome.error };
  return { kind: "result", result: outcome.result };
}

/** The option for a saved chart and a fresh result, or null when the shelves cannot draw it. */
export function optionForSavedChart(
  chart: Pick<SavedChartConfig, "typeId" | "variationId" | "selection" | "title" | "name" | "look">,
  result: QueryResult,
  theme: ChartTheme = chartTheme("dark"),
): BuiltChart | null {
  if (chart.typeId === undefined || chart.variationId === undefined) return null;
  const built = buildChartOption({
    typeId: chart.typeId,
    variationId: chart.variationId,
    rows: result.rows,
    selection: chart.selection ?? {},
    title: chart.title ?? chart.name,
    theme,
  });
  const look = storedChartLook(chart.look);
  if (built === null || look === undefined) return built;
  return { option: withoutFilterLooks(applyChartValues(look, built.option)), notes: built.notes };
}
