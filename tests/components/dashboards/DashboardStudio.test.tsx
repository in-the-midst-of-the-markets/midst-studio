import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => ({
    setOption() {},
    resize() {},
    dispose() {},
  }),
  registerMap: () => {},
}));

setupChartCodeMonacoMock();

mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    QueryEditor: ({ value, onContentChange }: { value: string; onContentChange?: (value: string) => void }) =>
      React.createElement("textarea", {
        "aria-label": "Query SQL",
        value,
        onChange: (event: { target: { value: string } }) => onContentChange?.(event.target.value),
      }),
  };
});

import { DashboardStudio } from "@/components/dashboards/DashboardStudio";
import { storage } from "@/lib/storage";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  createdAt: new Date("2026-01-01"),
};

function chart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "revenue",
    name: "Revenue",
    chartType: "bar",
    xAxis: "region",
    yAxis: ["total"],
    query: "SELECT region, total FROM sales",
    connectionId: "c1",
    typeId: "bar",
    variationId: "basic",
    selection: { category: ["region"], values: ["total"] },
    title: "Revenue",
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

const rows = {
  rows: [{ region: "east", total: 2 }],
  fields: ["region", "total"],
  rowCount: 1,
  executionTime: 4,
};

function board(id: string, chartIds: string[], name = id): SavedDashboard {
  const now = new Date("2026-01-01");
  return {
    id,
    name,
    charts: chartIds.map((chartId) => ({ chartId, width: 480, height: 320 })),
    createdAt: now,
    updatedAt: now,
  };
}

describe("DashboardStudio", () => {
  const interval = window.setInterval;
  const clear = window.clearInterval;

  afterEach(() => {
    cleanup();
    localStorage.clear();
    restoreGlobalFetch();
    window.setInterval = interval;
    window.clearInterval = clear;
    window.innerWidth = 1024;
  });

  test("starts empty, then creates, renames, switches, and deletes dashboards", () => {
    const view = render(<DashboardStudio />);
    expect(view.getByRole("heading", { name: "Create" })).toBeTruthy();
    expect(view.getByText("You have no dashboards yet.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    expect(view.getByLabelText("Dashboard name")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Dashboard name"), { target: { value: "Sales" } });
    expect(storage.getSavedDashboards()[0]?.name).toBe("Sales");
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    fireEvent.change(view.getByLabelText("Dashboard"), { target: { value: storage.getSavedDashboards()[0]?.id } });
    expect((view.getByLabelText("Dashboard name") as HTMLInputElement).value).toBe("Sales");
    fireEvent.change(view.getByLabelText("Dashboard"), { target: { value: "" } });
    expect(view.getByText("Choose a dashboard.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Dashboard"), { target: { value: "missing" } });
    expect(view.getByText("Choose a dashboard.")).toBeTruthy();
    const second = storage.getSavedDashboards()[1]?.id ?? "";
    fireEvent.change(view.getByLabelText("Dashboard"), { target: { value: second } });
    fireEvent.click(view.getByRole("button", { name: "Delete dashboard" }));
    expect(storage.getSavedDashboards()).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Delete dashboard" }));
    expect(view.getByText("You have no dashboards yet.")).toBeTruthy();
    expect(storage.getActiveDashboardId()).toBeNull();
  });

  test("adds a saved chart, drags it, and removes it", async () => {
    window.innerWidth = 1000;
    storage.saveConnection(connection);
    storage.saveChart(chart());
    storage.saveChart(
      chart({ id: "plain", name: "Plain", query: undefined, connectionId: undefined, typeId: undefined }),
    );
    storage.saveDashboard(board("sales", []));
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({
      "/api/db/query": { json: rows },
    });
    const view = render(<DashboardStudio />);
    expect(view.getByText("Add a saved chart to this dashboard.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Saved chart"), { target: { value: "revenue" } });
    fireEvent.click(view.getByRole("button", { name: "Add chart" }));
    const tile = await view.findByTestId("dashboard-chart-revenue");
    const heading = view.getByRole("heading", { name: "Revenue" });
    expect(heading.className).not.toContain("truncate");
    expect(heading.parentElement?.className).toContain("flex-wrap");
    expect(view.getByRole("button", { name: "Chart" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Query" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Code" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Unsave Revenue" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Remove Revenue" }).textContent).toBe("");
    expect(tile.style.width).toBe("480px");
    await waitFor(() => expect(view.getByTestId("assist-chart")).toBeTruthy());
    const handle = view.getByRole("button", { name: "Resize Revenue" });
    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 30 });
    expect(view.getByTestId("dashboard-chart-revenue").style.width).toBe("520px");
    expect(view.getByTestId("dashboard-chart-revenue").style.height).toBe("340px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(storage.getSavedDashboards()[0]?.charts[0]?.width).toBe(520 + 16 - 48);
    fireEvent.click(view.getByRole("button", { name: "Remove Revenue" }));
    expect(view.queryByTestId("dashboard-chart-revenue")).toBeNull();
  });

  test("shows an empty chart, a missing connection, a failed query, and a chart that cannot draw", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart({ id: "empty", name: "Empty", query: "  " }));
    storage.saveChart(chart({ id: "gone", name: "Gone", connectionId: "missing" }));
    storage.saveChart(chart({ id: "bad", name: "Bad", variationId: "nope" }));
    storage.saveChart(chart({ id: "shelves", name: "Shelves", typeId: undefined, variationId: undefined }));
    storage.saveChart(chart({ id: "fail", name: "Fail", query: "FAIL" }));
    storage.saveDashboard(board("sales", ["empty", "gone", "bad", "shelves", "fail", "absent"]));
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql?: string };
        if (body.sql === "FAIL") return { status: 400, json: { error: "refused" } };
        return { json: rows };
      },
    });
    const view = render(<DashboardStudio />);
    expect(await view.findByText("Save this chart with a query to fill it.")).toBeTruthy();
    expect(await view.findByText("That connection is no longer available.")).toBeTruthy();
    expect(await view.findByText("refused")).toBeTruthy();
    expect(await view.findByText("Those columns do not have numbers to chart.")).toBeTruthy();
    expect(await view.findByText("Save this chart again from the chart view.")).toBeTruthy();
  });

  test("reruns a chart on its schedule and ignores a result after the chart is gone", async () => {
    const queued: Array<() => void> = [];
    window.setInterval = ((fn: TimerHandler) => {
      if (typeof fn === "function") queued.push(() => void (fn as () => void)());
      return 1;
    }) as unknown as typeof window.setInterval;
    window.clearInterval = (() => {}) as typeof clearInterval;
    storage.saveConnection(connection);
    storage.saveChart(chart({ refreshSeconds: 60 }));
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    let calls = 0;
    const pending: { release: (() => void) | null } = { release: null };
    mockGlobalFetch({
      "/api/db/query": () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) {
            pending.release = () => resolve({ json: rows });
            return;
          }
          resolve({ json: rows });
        }),
    });
    const view = render(<DashboardStudio />);
    expect(view.getByText("Running the query…")).toBeTruthy();
    view.unmount();
    pending.release?.();
    await waitFor(() => expect(calls).toBe(1));
    storage.saveChart(chart({ refreshSeconds: 60 }));
    const again = render(<DashboardStudio />);
    await waitFor(() => expect(again.getByTestId("assist-chart")).toBeTruthy());
    const before = calls;
    queued.at(-1)?.();
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  test("edits a chart's filters and can unsave it", async () => {
    storage.saveConnection(connection);
    const query = "SELECT region, total FROM sales WHERE region = {{region:east|east,west}} AND total >= {{total:1}}";
    storage.saveChart(chart({ query }));
    storage.saveChart(chart({ id: "plain", name: "Plain", query: undefined, connectionId: undefined }));
    storage.saveDashboard(board("sales", ["revenue", "plain"]));
    storage.setActiveDashboardId("sales");
    const posted: string[] = [];
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql?: string };
        posted.push(body.sql ?? "");
        return { json: rows };
      },
    });
    const view = render(<DashboardStudio />);
    expect(await view.findByLabelText("region")).toBeTruthy();
    await waitFor(() => expect(posted.some((sql) => sql.includes("region = 'east'") && !sql.includes("{"))).toBe(true));
    expect(await view.findByLabelText("total comparison")).toBeTruthy();
    fireEvent.change(view.getByLabelText("region"), { target: { value: "west" } });
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).toContain("west"),
    );
    await waitFor(() => expect(posted.some((sql) => sql.includes("region = 'west'") && !sql.includes("{"))).toBe(true));
    fireEvent.change(view.getByLabelText("total comparison"), { target: { value: "<=" } });
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).toContain("total <= {{total:1}}"),
    );
    fireEvent.change(view.getByLabelText("total"), { target: { value: "5" } });
    fireEvent.blur(view.getByLabelText("total"));
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).toContain("{{total:5}}"),
    );
    await waitFor(() => expect(posted.some((sql) => sql.includes("total <= 5") && !sql.includes("{"))).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).not.toContain("{"),
    );
    fireEvent.click(view.getByRole("button", { name: "Unsave Revenue" }));
    expect(view.queryByTestId("dashboard-chart-revenue")).toBeNull();
    expect(storage.getSavedCharts().some((item) => item.id === "revenue")).toBe(false);
    expect(storage.getSavedDashboards()[0]?.charts.some((frame) => frame.chartId === "revenue")).toBe(false);
  });

  test("edits a dashboard chart's query and code", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart({ look: { color: ["#9546de"] } }));
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    const posted: string[] = [];
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql?: string };
        posted.push(body.sql ?? "");
        return { json: rows };
      },
    });
    const view = render(<DashboardStudio />);
    await view.findByTestId("assist-chart");
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    const sql = view.getByRole("textbox", { name: "Query SQL" }) as HTMLTextAreaElement;
    expect(sql.value).toBe("SELECT region, total FROM sales");
    const nextQuery = "SELECT region, total FROM sales WHERE total > 1";
    fireEvent.change(sql, { target: { value: nextQuery } });
    fireEvent.click(view.getByRole("button", { name: "Run Revenue" }));
    await waitFor(() => expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).toBe(nextQuery));
    await waitFor(() => expect(posted).toContain(nextQuery));
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const code = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(code.value).toContain("#9546de");
    fireEvent.change(code, { target: { value: "{" } });
    expect(view.getByRole("alert").textContent).toBe("Chart code is not valid JSON.");
    expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.look).toEqual({ color: ["#9546de"] });
    fireEvent.change(code, { target: { value: JSON.stringify({ color: ["#112233"] }) } });
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.look).toEqual({ color: ["#112233"] }),
    );
    fireEvent.click(view.getByRole("button", { name: "Use generated chart" }));
    expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.look).toBeUndefined();
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
  });

  test("a new dashboard with no saved charts says so", () => {
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    expect(view.getByText("Save a chart from the editor or AI Assist, then add it here.")).toBeTruthy();
  });
});
