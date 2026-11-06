import { runAssistQuery } from "@/lib/ai/assist-query";
import { applyChartValues } from "@/lib/charts/chart-code";
import { presentChartOption } from "@/lib/charts/chart-present";
import type { ChartSettings } from "@/lib/charts/chart-settings";
import { buildChartOption, type BuiltChart } from "@/lib/charts/echarts-option";
import { withoutFilterLooks } from "@/lib/charts/filter-look";
import { applyQueryFilters } from "@/lib/charts/query-filters";
import { chartTheme, type ChartTheme } from "@/lib/charts/palette";
import { restampThemeChrome } from "@/lib/charts/theme-chrome";
import { storedChartLook } from "@/lib/charts/save-chart";
import { savedJoinCatalog } from "@/lib/saved-join/catalog";
import { isCrossDbJoins } from "@/lib/saved-join/connection";
import { readJoinSizeChoice } from "@/lib/saved-join/size-choice";
import type { DatabaseConnection, QueryResult, SavedChartConfig, SavedQuery } from "@/lib/types";

type Post = (path: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type SavedChartView =
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly result: QueryResult };

/**
 * Reruns the chart's query on its connection.
 * An empty query or a missing connection is a message, not a request.
 * Cross_DB_Joins is not a database file. Its statement runs through the saved-join route,
 * and each table is a saved query.
 */
export async function loadSavedChart(
  chart: Pick<SavedChartConfig, "query" | "connectionId">,
  connections: readonly DatabaseConnection[],
  post: Post,
  saved: readonly SavedQuery[] = [],
): Promise<SavedChartView> {
  const query = chart.query?.trim() ?? "";
  if (query === "") return { kind: "empty", message: "Save this chart with a query to fill it." };
  if (chart.connectionId === undefined || chart.connectionId === "") {
    return { kind: "empty", message: "This chart has no connection." };
  }
  const connection = connections.find((item) => item.id === chart.connectionId);
  if (connection === undefined) return { kind: "error", message: "That connection is no longer available." };
  const sql = applyQueryFilters(query);
  const outcome = await runAssistQuery(
    connection,
    sql,
    isCrossDbJoins(connection)
      ? () =>
          post("/api/db/saved-join", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sql,
              saved: savedJoinCatalog(saved, connections),
              size: readJoinSizeChoice(),
            }),
          })
      : post,
  );
  if (!outcome.ok) return { kind: "error", message: outcome.error };
  return { kind: "result", result: outcome.result };
}

/**
 * The option for a saved chart and a fresh result, or null when the shelves cannot draw it.
 * The dashboard card shows the chart name. A title in the chart code is drawn on the
 * plot as well. An empty title stays off the plot, and the legend and grid keep the
 * room the untitled chart uses.
 * Legend type and grid lines follow the theme that is open. Series colors stay saved.
 */
export function optionForSavedChart(
  chart: Pick<SavedChartConfig, "typeId" | "variationId" | "selection" | "look">,
  result: QueryResult,
  theme: ChartTheme = chartTheme("dark"),
  settings?: ChartSettings,
): BuiltChart | null {
  if (chart.typeId === undefined || chart.variationId === undefined) return null;
  const built = buildChartOption({
    typeId: chart.typeId,
    variationId: chart.variationId,
    rows: result.rows,
    selection: chart.selection ?? {},
    title: "",
    theme,
    settings,
  });
  if (built === null) return null;
  const look = storedChartLook(chart.look);
  const drawn = look === undefined ? built.option : withoutFilterLooks(applyChartValues(look, built.option));
  return { option: restampThemeChrome(presentChartOption(drawn, built.option), theme), notes: built.notes };
}
