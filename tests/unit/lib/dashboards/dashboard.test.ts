import { describe, expect, test } from "bun:test";
import {
  chartFrameSize,
  dashboardName,
  dragResize,
  freshDashboard,
  MAX_DASHBOARD_CHART_HEIGHT,
  MIN_DASHBOARD_CHART_HEIGHT,
  MIN_DASHBOARD_CHART_WIDTH,
  withChart,
  withFrame,
  withName,
  withoutChart,
} from "@/lib/dashboards/dashboard";
import type { SavedDashboard } from "@/lib/types";

function board(charts: SavedDashboard["charts"] = []): SavedDashboard {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return { id: "d1", name: "Board", charts, createdAt: now, updatedAt: now };
}

describe("dashboard layout", () => {
  test("sizes a chart to the board and refuses a size that is not a number", () => {
    expect(chartFrameSize(480, 320, 800)).toEqual({ width: 480, height: 320 });
    expect(chartFrameSize(2000, 20, 400)).toEqual({ width: 400, height: MIN_DASHBOARD_CHART_HEIGHT });
    expect(chartFrameSize(2000, 4000, 100)).toEqual({ width: 1600, height: MAX_DASHBOARD_CHART_HEIGHT });
    expect(chartFrameSize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toEqual({
      width: MIN_DASHBOARD_CHART_WIDTH,
      height: MIN_DASHBOARD_CHART_HEIGHT,
    });
    expect(dragResize({ width: 480, height: 320 }, -400, 40, 800)).toEqual({
      width: MIN_DASHBOARD_CHART_WIDTH,
      height: 360,
    });
  });

  test("names the next dashboard, and skips a name that is already used", () => {
    expect(dashboardName([])).toBe("Dashboard 1");
    expect(dashboardName([{ name: "Dashboard 2" }])).toBe("Dashboard 3");
  });

  test("places, renames, resizes, and removes a chart", () => {
    expect(freshDashboard("Dashboard 1").id).toBeTypeOf("string");
    const created = freshDashboard("Dashboard 1", "d1");
    expect(created.charts).toEqual([]);
    expect(created.createdAt).toBeInstanceOf(Date);
    const placed = withChart(created, "c1", 800);
    expect(placed.charts).toEqual([{ chartId: "c1", width: 480, height: 320 }]);
    expect(withChart(placed, "c1", 800)).toBe(placed);
    const narrow = withChart(board(), "c1", 300);
    expect(narrow.charts[0]?.width).toBe(300);
    const renamed = withName(placed, "Sales");
    expect(renamed.name).toBe("Sales");
    const sized = withFrame(renamed, "c1", { width: 500, height: 280 });
    expect(sized.charts[0]).toEqual({ chartId: "c1", width: 500, height: 280 });
    expect(withFrame(sized, "missing", { width: 1, height: 1 }).charts).toHaveLength(1);
    expect(withoutChart(sized, "c1").charts).toEqual([]);
  });
});
