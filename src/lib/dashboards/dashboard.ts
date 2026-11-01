import type { SavedDashboard } from "@/lib/types";

export const DEFAULT_DASHBOARD_CHART_WIDTH = 480;
export const DEFAULT_DASHBOARD_CHART_HEIGHT = 320;
export const MIN_DASHBOARD_CHART_WIDTH = 280;
export const MIN_DASHBOARD_CHART_HEIGHT = 220;
export const MAX_DASHBOARD_CHART_HEIGHT = 900;

/** A width the chart may grow to when the board has not been measured yet. */
const UNMEASURED_MAX_WIDTH = 1600;

/**
 * A chart size that fits the board.
 * A width that is not a number, or a board that is narrower than the minimum, falls back
 * so a drag cannot collapse the chart or stretch it past the screen.
 */
export function chartFrameSize(width: number, height: number, maxWidth: number): { width: number; height: number } {
  const cap = Number.isFinite(maxWidth) && maxWidth >= MIN_DASHBOARD_CHART_WIDTH ? maxWidth : UNMEASURED_MAX_WIDTH;
  const nextWidth = Number.isFinite(width) ? Math.round(width) : MIN_DASHBOARD_CHART_WIDTH;
  const nextHeight = Number.isFinite(height) ? Math.round(height) : MIN_DASHBOARD_CHART_HEIGHT;
  return {
    width: Math.min(cap, Math.max(MIN_DASHBOARD_CHART_WIDTH, nextWidth)),
    height: Math.min(MAX_DASHBOARD_CHART_HEIGHT, Math.max(MIN_DASHBOARD_CHART_HEIGHT, nextHeight)),
  };
}

/** The size after a drag from `start` by `dx` and `dy` pixels. */
export function dragResize(
  start: { width: number; height: number },
  dx: number,
  dy: number,
  maxWidth: number,
): { width: number; height: number } {
  return chartFrameSize(start.width + dx, start.height + dy, maxWidth);
}

/** The next "Dashboard N" that is not already used. */
export function dashboardName(existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((item) => item.name));
  let index = existing.length + 1;
  let name = `Dashboard ${index}`;
  while (taken.has(name)) {
    index += 1;
    name = `Dashboard ${index}`;
  }
  return name;
}

export function freshDashboard(name: string, id = crypto.randomUUID()): SavedDashboard {
  const now = new Date();
  return { id, name, charts: [], createdAt: now, updatedAt: now };
}

/** Adds the chart at a size that fits `maxWidth`, or returns the dashboard when it is already there. */
export function withChart(dashboard: SavedDashboard, chartId: string, maxWidth: number): SavedDashboard {
  if (dashboard.charts.some((item) => item.chartId === chartId)) return dashboard;
  const size = chartFrameSize(DEFAULT_DASHBOARD_CHART_WIDTH, DEFAULT_DASHBOARD_CHART_HEIGHT, maxWidth);
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: [...dashboard.charts, { chartId, width: size.width, height: size.height }],
  };
}

export function withoutChart(dashboard: SavedDashboard, chartId: string): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: dashboard.charts.filter((item) => item.chartId !== chartId),
  };
}

export function withFrame(
  dashboard: SavedDashboard,
  chartId: string,
  size: { width: number; height: number },
): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: dashboard.charts.map((item) => (item.chartId === chartId ? { ...item, ...size } : item)),
  };
}

export function withName(dashboard: SavedDashboard, name: string): SavedDashboard {
  return { ...dashboard, name, updatedAt: new Date() };
}
