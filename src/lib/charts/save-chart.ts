import { readRefreshText } from "@/lib/charts/chart-refresh";
import { chartPublicId } from "@/lib/dashboards/public-id";
import type { SavedChartConfig } from "@/lib/types";

/** What the save control knows about the chart on screen. `refreshText` is the field, not the seconds. */
export interface SaveChartDraft {
  name: string;
  title: string;
  query?: string;
  connectionId?: string;
  chartType: string;
  xAxis: string;
  yAxis: string[];
  typeId?: string;
  variationId?: string;
  selection?: Record<string, string[]>;
  /** The chart's look, without query values. A colour edit belongs to the saved chart. */
  look?: Record<string, unknown>;
  refreshText: string;
}

export function axesFromSelection(selection: Record<string, readonly string[]>): { xAxis: string; yAxis: string[] } {
  const values = Object.values(selection).flat();
  return { xAxis: values[0] ?? "", yAxis: values.slice(1) };
}

/** A draft for the chart the user is looking at. An empty title is saved under the name "Chart". */
export function chartSaveDraft(input: {
  title: string;
  query?: string;
  connectionId?: string;
  typeId: string;
  variationId: string;
  selection: Record<string, readonly string[]>;
  look?: Record<string, unknown>;
}): Omit<SaveChartDraft, "refreshText"> {
  const selection = Object.fromEntries(Object.entries(input.selection).map(([key, values]) => [key, [...values]]));
  const title = input.title.trim();
  return {
    name: title === "" ? "Chart" : title,
    title,
    query: input.query,
    connectionId: input.connectionId,
    chartType: input.typeId,
    typeId: input.typeId,
    variationId: input.variationId,
    selection,
    ...(input.look !== undefined ? { look: input.look } : {}),
    ...axesFromSelection(selection),
  };
}

/** A look that can be stored. Functions and cycles are dropped. An empty object is not a look. */
export function storedChartLook(look: unknown): Record<string, unknown> | undefined {
  if (typeof look !== "object" || look === null || Array.isArray(look)) return undefined;
  try {
    const cloned = JSON.parse(JSON.stringify(look)) as unknown;
    if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) return undefined;
    return Object.keys(cloned).length === 0 ? undefined : (cloned as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function lookKey(look: unknown): string {
  return JSON.stringify(storedChartLook(look) ?? null);
}

interface ChartIdentity {
  query?: string;
  connectionId?: string;
  typeId?: string;
  variationId?: string;
  selection?: Record<string, readonly string[]>;
  look?: unknown;
}

/** The parts that make one saved chart the same as another. A new name is not a new chart. */
function chartIdentity(chart: ChartIdentity): string {
  const selection = chart.selection ?? {};
  const shelves = Object.entries(selection)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => `${key}=${values.join("\0")}`);
  return [
    chart.connectionId ?? "",
    chart.typeId ?? "",
    chart.variationId ?? "",
    shelves.join("\n"),
    (chart.query ?? "").trim(),
    lookKey(chart.look),
  ].join("\u0001");
}

/** The saved chart this draft would repeat, or null when nothing stored matches it. */
export function findSavedChart<T extends ChartIdentity>(charts: readonly T[], draft: ChartIdentity): T | null {
  const key = chartIdentity(draft);
  return charts.find((chart) => chartIdentity(chart) === key) ?? null;
}

/**
 * The stored chart, or null when the name is blank or the refresh field is not a schedule.
 * A query is required for a schedule: without one there is nothing to rerun.
 */
export function buildSavedChart(draft: SaveChartDraft, id = crypto.randomUUID()): SavedChartConfig | null {
  const name = draft.name.trim();
  if (name === "") return null;
  const refresh = readRefreshText(draft.refreshText);
  if (!refresh.ok) return null;
  const query = draft.query?.trim();
  const hasQuery = query !== undefined && query !== "";
  const title = draft.title.trim();
  const look = storedChartLook(draft.look);
  return {
    id,
    name,
    token: chartPublicId(),
    chartType: draft.chartType,
    xAxis: draft.xAxis,
    yAxis: [...draft.yAxis],
    ...(hasQuery ? { query } : {}),
    ...(draft.connectionId !== undefined && draft.connectionId !== "" ? { connectionId: draft.connectionId } : {}),
    ...(hasQuery && refresh.seconds !== undefined ? { refreshSeconds: refresh.seconds } : {}),
    ...(draft.typeId !== undefined ? { typeId: draft.typeId } : {}),
    ...(draft.variationId !== undefined ? { variationId: draft.variationId } : {}),
    ...(draft.selection !== undefined ? { selection: draft.selection } : {}),
    ...(title !== "" ? { title } : {}),
    ...(look !== undefined ? { look } : {}),
    createdAt: new Date(),
  };
}
