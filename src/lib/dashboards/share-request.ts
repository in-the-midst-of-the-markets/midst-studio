import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";
import { isShareId } from "./share-access";

export interface SharePublishRequest {
  readonly id?: string;
  readonly dashboard: SavedDashboard;
  readonly charts: readonly SavedChartConfig[];
  readonly connections: readonly DatabaseConnection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The publish body, or a sentence the route answers with. */
export function readSharePublish(body: Record<string, unknown>): SharePublishRequest | string {
  const dashboard = body.dashboard;
  if (!isRecord(dashboard) || typeof dashboard.name !== "string" || !Array.isArray(dashboard.charts)) {
    return "The dashboard is not valid.";
  }
  if (!Array.isArray(body.charts) || !Array.isArray(body.connections)) return "The dashboard is not valid.";
  if (body.id !== undefined && (typeof body.id !== "string" || !isShareId(body.id))) {
    return "That share link is not valid.";
  }
  const charts = body.charts.filter(isRecord);
  const connections = body.connections.filter(
    (item): item is DatabaseConnection =>
      isRecord(item) && typeof item.id === "string" && typeof item.type === "string",
  );
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    dashboard: dashboard as unknown as SavedDashboard,
    charts: charts as unknown as SavedChartConfig[],
    connections,
  };
}

/** The SQL a visitor wants to run on a snapshot, or a sentence when it is not a string. */
export function readShareQuery(body: Record<string, unknown>): string | null {
  return typeof body.sql === "string" ? body.sql : null;
}
