import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

const drawnOptions: Record<string, unknown>[] = [];

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => ({
    setOption(option: Record<string, unknown>) {
      drawnOptions.push(option);
    },
    resize() {},
    dispose() {},
  }),
  registerMap: () => {},
}));

setupChartCodeMonacoMock();

mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const QueryEditor = React.forwardRef(function QueryEditor(
    {
      value,
      onContentChange,
      schemaContext,
    }: {
      value: string;
      onContentChange?: (value: string) => void;
      schemaContext?: string;
    },
    ref: { current: { insertText: (text: string) => void } | null },
  ) {
    React.useImperativeHandle(ref, () => ({
      insertText(text: string) {
        const gap = value.trim() === "" || /\s$/.test(value) ? "" : " ";
        onContentChange?.(`${value}${gap}${text}`);
      },
    }));
    return React.createElement("textarea", {
      "aria-label": "Query SQL",
      "data-schema": schemaContext ?? "",
      value,
      onChange: (event: { target: { value: string } }) => onContentChange?.(event.target.value),
    });
  });
  return { QueryEditor };
});

import { DashboardStudio } from "@/components/dashboards/DashboardStudio";
import { DEFAULT_DASHBOARD_BLOCK_WIDTH, DEFAULT_DASHBOARD_FILTER_HEIGHT } from "@/lib/dashboards/dashboard";
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
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Add chart" }));
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.getByRole("menuitem", { name: "Make a chart" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Add chart" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Revenue" }));
    const tile = await view.findByTestId("dashboard-chart-revenue");
    expect(tile.className).toContain("bg-transparent");
    expect(drawnOptions.at(-1)?.backgroundColor).toBe("transparent");
    const heading = view.getByLabelText("Chart title") as HTMLInputElement;
    expect(heading.value).toBe("Revenue");
    expect(heading.className).not.toContain("truncate");
    expect(heading.parentElement?.className).toContain("flex-wrap");
    expect(view.getByRole("button", { name: "Chart" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Query" }).textContent).toBe("");
    expect(view.getByRole("button", { name: "Code" }).textContent).toBe("");
    const unsave = view.getByRole("button", { name: "Unsave Revenue" });
    expect(unsave.textContent).toBe("");
    expect(unsave.getAttribute("aria-pressed")).toBe("true");
    expect(unsave.className).toContain("bg-brand-solid");
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
    expect(view.getByTestId("dashboard-chart-revenue")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Remove Revenue" }));
    expect(view.queryByRole("button", { name: "Confirm remove Revenue" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Remove Revenue" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm remove Revenue" }));
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
    expect(await view.findAllByRole("button", { name: "Use Bar chart" })).toHaveLength(2);
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
    expect(view.getByTestId("dashboard-chart-revenue")).toBeTruthy();
    expect(storage.getSavedCharts().some((item) => item.id === "revenue")).toBe(true);
    expect(view.getByRole("button", { name: "Confirm unsave Revenue" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Remove Revenue" }));
    expect(view.queryByRole("button", { name: "Confirm unsave Revenue" })).toBeNull();
    expect(view.getByRole("button", { name: "Confirm remove Revenue" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Remove Revenue" }));
    expect(view.queryByRole("button", { name: "Confirm remove Revenue" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Unsave Revenue" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm unsave Revenue" }));
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
    fireEvent.change(code, {
      target: { value: JSON.stringify({ color: ["#112233"], backgroundColor: "#112233" }) },
    });
    await waitFor(() => expect(drawnOptions.at(-1)?.backgroundColor).toBe("#112233"));
    const colors = drawnOptions.at(-1)?.color;
    expect(Array.isArray(colors) ? colors[0] : undefined).toBe("#112233");
    fireEvent.change(code, {
      target: { value: JSON.stringify({ color: ["#112233"], backgroundColor: "transparent" }) },
    });
    await waitFor(() => expect(drawnOptions.at(-1)?.backgroundColor).toBe("transparent"));
    fireEvent.change(code, {
      target: {
        value: JSON.stringify({
          title: { text: "By region" },
          yAxis: { axisLabel: { prefix: "$" } },
          tooltip: { formatter: "{b}: {c} usd" },
        }),
      },
    });
    await waitFor(() => expect((drawnOptions.at(-1)?.title as { text?: string } | undefined)?.text).toBe("By region"));
    const drawn = drawnOptions.at(-1);
    const axisLabel = (drawn?.yAxis as { axisLabel?: { formatter?: (value: unknown) => string } } | undefined)
      ?.axisLabel;
    expect(axisLabel?.formatter?.(2)).toBe("$2");
    expect(drawnOptions.at(-1)?.tooltip).toMatchObject({ formatter: "{b}: {c} usd" });
    fireEvent.change(code, {
      target: { value: JSON.stringify({ color: ["#112233"], backgroundColor: "transparent" }) },
    });
    await waitFor(() => expect(drawnOptions.at(-1)?.backgroundColor).toBe("transparent"));
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(drawnOptions.at(-1)?.backgroundColor).toBe("transparent");
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.click(view.getByRole("button", { name: "Use generated chart" }));
    expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.look).toBeUndefined();
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
  });

  test("a new dashboard with no saved charts says so", () => {
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Add chart" }));
    expect(view.getByText("Save a chart from the editor or AI Assist, then add it here.")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(view.queryByRole("menu", { name: "Add content" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(view.getByRole("menu", { name: "Add content" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByRole("menu", { name: "Add content" })).toBeNull();
  });

  test("makes a chart from scratch and picks a type", async () => {
    storage.saveConnection(connection);
    storage.saveDashboard(board("sales", []));
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({ "/api/db/query": { json: rows } });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Make a chart" }));
    const sql = view.getByRole("textbox", { name: "Query SQL" }) as HTMLTextAreaElement;
    fireEvent.change(sql, { target: { value: "SELECT region, total FROM sales" } });
    fireEvent.click(view.getByRole("button", { name: "Run Chart" }));
    fireEvent.click(await view.findByRole("button", { name: "Hide chart choices" }));
    expect(view.queryByRole("button", { name: "Use Bar chart" })).toBeNull();
    expect(view.queryByRole("group", { name: "Chart types" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Choose a type" }));
    expect(view.getByRole("button", { name: "Hide chart choices" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Use Bar chart" }));
    expect(view.queryByRole("group", { name: "Chart variations" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use Line chart" }));
    expect(view.queryByRole("button", { name: "Use Bar Stacked chart" })).toBeNull();
    expect(view.getByRole("button", { name: "Use Line Area chart" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use Bar chart" }));
    fireEvent.click(view.getByRole("button", { name: "Use Bar Stacked chart" }));
    await view.findByTestId("assist-chart");
    expect(storage.getSavedCharts()[0]).toMatchObject({ typeId: "bar", variationId: "stacked", connectionId: "c1" });
    expect(view.getByRole("button", { name: "Use Bar Stacked chart" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Use Bar Stacked chart" }));
    expect(storage.getSavedCharts()[0]?.selection?.category).toEqual(["region"]);
    expect(
      within(view.getByRole("group", { name: "Dimension" }))
        .getByRole("button", { name: "region" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(view.getByRole("group", { name: "Metrics" }))
        .getByRole("button", { name: "total" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Hide chart choices" }));
    expect(view.queryByRole("group", { name: "Dimension" })).toBeNull();
    expect(view.queryByRole("group", { name: "Chart types" })).toBeNull();
    expect(view.queryByRole("group", { name: "Chart variations" })).toBeNull();
    expect(view.getByText("Dimension region · Metrics total")).toBeTruthy();
    expect(view.getByTestId("assist-chart")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Bar · Stacked" }));
    expect(view.getByRole("button", { name: "Hide chart choices" }).getAttribute("aria-expanded")).toBe("true");
    const dimension = view.getByRole("group", { name: "Dimension" });
    const metrics = view.getByRole("group", { name: "Metrics" });
    fireEvent.click(within(dimension).getByRole("button", { name: "total" }));
    expect(storage.getSavedCharts()[0]?.selection).toMatchObject({ category: ["total"] });
    expect(storage.getSavedCharts()[0]?.xAxis).toBe("total");
    fireEvent.click(within(dimension).getByRole("button", { name: "region" }));
    fireEvent.click(within(dimension).getByRole("button", { name: "region" }));
    expect(storage.getSavedCharts()[0]?.selection?.category).toEqual([]);
    fireEvent.click(within(metrics).getByRole("button", { name: "total" }));
    expect(storage.getSavedCharts()[0]?.selection?.values).toEqual([]);
    fireEvent.click(within(metrics).getByRole("button", { name: "total" }));
    expect(storage.getSavedCharts()[0]?.selection?.values).toEqual(["total"]);
    fireEvent.click(view.getByRole("button", { name: "Use Line chart" }));
    expect(view.queryByRole("group", { name: "Dimension" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Use Line Area chart" }));
    expect(storage.getSavedCharts()[0]).toMatchObject({ typeId: "line", variationId: "area" });
    expect(view.getByRole("button", { name: "Use Line Area chart" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBeUndefined();
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "c1" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBe("c1");
    fireEvent.change(view.getByLabelText("Chart title"), { target: { value: "Revenue" } });
    expect(storage.getSavedCharts()[0]?.name).toBe("Revenue");
  });

  test("suggests tables in the chart query and lists Cross_DB_Joins", async () => {
    storage.saveConnection(connection);
    storage.saveQuery({
      id: "q1",
      name: "Orders",
      tableId: "orders",
      query: "SELECT id, region FROM sales",
      connectionType: "postgres",
      connectionId: "c1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });
    storage.saveChart(chart());
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({
      "/api/db/query": { json: rows },
      "/api/db/saved-join": { json: rows },
      "/api/db/provider-meta": {
        json: {
          capabilities: {
            queryLanguage: "sql",
            objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
          },
        },
      },
      "/api/db/objects/inventory": {
        json: {
          objects: [{ name: "sales", kind: "table", path: ["sales"] }],
          details: [{ path: ["sales"], columns: [{ name: "region", type: "text" }], indexes: [] }],
        },
      },
    });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    const sql = view.getByRole("textbox", { name: "Query SQL" });
    await waitFor(() => expect(sql.getAttribute("data-schema")).toContain("sales"));
    const select = view.getByLabelText("Connection for Revenue");
    expect(within(select).getByRole("option", { name: "Cross_DB_Joins" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "cross-db-joins" } });
    await waitFor(() =>
      expect(view.getByRole("textbox", { name: "Query SQL" }).getAttribute("data-schema")).toContain("orders"),
    );
  });

  test("designs a filter as a dropdown, slider, search box, or custom JavaScript", async () => {
    storage.saveConnection(connection);
    const query = "SELECT region, total FROM sales WHERE region = {{region}}";
    storage.saveChart(chart({ query }));
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    const posted: string[] = [];
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql?: string };
        posted.push(body.sql ?? "");
        if (body.sql === "FAIL") return { status: 400, json: { error: "refused" } };
        if (body.sql === "SELECT blank FROM sales")
          return { json: { ...rows, rows: [{ region: "" }, { region: null }] } };
        if (body.sql?.startsWith("SELECT region FROM")) {
          return { json: { ...rows, rows: [{ region: "east" }, { region: "west" }] } };
        }
        return { json: rows };
      },
    });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Component" }));
    const filterHandle = view.getByRole("button", { name: "Resize filter" });
    fireEvent.pointerDown(filterHandle, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 24, clientY: 16 });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]).toMatchObject({
      width: DEFAULT_DASHBOARD_BLOCK_WIDTH + 24,
      height: DEFAULT_DASHBOARD_FILTER_HEIGHT + 16,
    });
    fireEvent.click(view.getByRole("button", { name: "Dropdown" }));
    expect(view.queryByLabelText("Filter selection")).toBeNull();
    expect((view.getByLabelText("Component title") as HTMLInputElement).value).toBe("filter");
    fireEvent.change(view.getByLabelText("Component title"), { target: { value: "Area" } });
    expect((view.getByLabelText("Filter label") as HTMLInputElement).value).toBe("Area");
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "Region" } });
    expect((view.getByLabelText("Component title") as HTMLInputElement).value).toBe("Region");
    const publicId = (view.getByLabelText("Filter id") as HTMLInputElement).value;
    expect(publicId).toMatch(/^id_[a-f0-9]{10}$/);
    expect((view.getByLabelText("Filter id") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(view.getByLabelText("Filter id"), { target: { value: "region" } });
    expect((view.getByLabelText("Filter id") as HTMLInputElement).value).toBe(publicId);
    expect(view.getByText(`Reference this selection in a query as {{${publicId}}}.`)).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "" } });
    expect((view.getByLabelText("Component title") as HTMLInputElement).value).toBe(publicId);
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "Region" } });
    fireEvent.click(view.getByRole("button", { name: "Choices" }));
    fireEvent.click(view.getByRole("button", { name: "Run choices" }));
    expect(view.getByRole("alert").textContent).toBe("Add a connection and a query to fill the choices.");
    fireEvent.change(view.getByLabelText("Filter connection"), { target: { value: "" } });
    fireEvent.change(view.getByRole("textbox", { name: "Query SQL" }), {
      target: { value: "SELECT region FROM sales" },
    });
    fireEvent.change(view.getByLabelText("Filter connection"), { target: { value: "c1" } });
    fireEvent.click(view.getByRole("button", { name: "Run choices" }));
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    await waitFor(() =>
      expect((view.getByLabelText("Filter selection") as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    expect(view.getByLabelText("Filter selection").closest("label")).toBeNull();
    expect(view.getByText(`{{${publicId}}}`)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByRole("textbox", { name: "Query SQL" }), {
      target: { value: `SELECT region, total FROM sales WHERE region = {{${publicId}}}` },
    });
    fireEvent.click(view.getByRole("button", { name: "Run Revenue" }));
    fireEvent.change(view.getByLabelText("Filter selection"), { target: { value: "west" } });
    await waitFor(() => expect(posted.some((sql) => sql.includes("region = 'west'") && !sql.includes("{"))).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Slider" }));
    expect(view.queryByLabelText("Filter slider")).toBeNull();
    fireEvent.change(view.getByLabelText("Filter minimum"), { target: { value: "1" } });
    fireEvent.change(view.getByLabelText("Filter maximum"), { target: { value: "9" } });
    fireEvent.change(view.getByLabelText("Filter step"), { target: { value: "2" } });
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    expect(view.getByLabelText("Filter slider").closest("label")).toBeNull();
    fireEvent.change(view.getByLabelText("Filter slider"), { target: { value: "5" } });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("5");
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    expect(view.queryByLabelText("Filter search")).toBeNull();
    fireEvent.change(view.getByLabelText("Filter placeholder"), { target: { value: "Find" } });
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    expect(view.getByLabelText("Filter search").closest("label")).toBeNull();
    fireEvent.change(view.getByLabelText("Filter search"), { target: { value: "east" } });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("east");
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Custom" }));
    const script = view.getByRole("textbox", { name: "JavaScript" }) as HTMLTextAreaElement;
    fireEvent.change(script, { target: { value: script.value } });
    fireEvent.change(script, { target: { value: 'setValue("north");' } });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.script).toContain('setValue("north")');
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    const frame = view.getByTitle("Custom filter") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("csp")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain("setValue");
    const filterId = storage.getSavedDashboards()[0]?.filters?.[0]?.id ?? "";
    const message = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      window.dispatchEvent(new window.MessageEvent("message", { data, source }));
    message({ source: "libredb-filter", id: filterId, value: "nope" }, null);
    message({ source: "libredb-filter", id: "other", value: "nope" });
    message({ source: "libredb-filter", id: filterId, value: "east" });
    message({ source: "libredb-filter", id: filterId, value: "north" });
    await waitFor(() => expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("north"));
    fireEvent.click(view.getByRole("button", { name: `Remove ${publicId} filter` }));
    expect(storage.getSavedDashboards()[0]?.filters).toEqual([]);
  });

  test("hardcoded values replace the SQL editor", () => {
    storage.saveConnection(connection);
    storage.saveDashboard({
      ...board("sales", []),
      filters: [
        {
          id: "f1",
          name: "region",
          query: "SELECT region FROM sales",
          value: "",
          control: "select",
          connectionId: "c1",
        },
      ],
    });
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({ "/api/db/query": { json: rows } });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Choices" }));
    expect(view.getByRole("textbox", { name: "Query SQL" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Hardcoded values" }));
    expect(view.queryByRole("textbox", { name: "Query SQL" })).toBeNull();
    fireEvent.change(view.getByLabelText("Value list"), { target: { value: "east\nwest\neast\n  \n" } });
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    const select = view.getByLabelText("Filter selection") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "east", "west"]);
    fireEvent.click(view.getByRole("button", { name: "Choices" }));
    fireEvent.click(view.getByRole("button", { name: "From a query" }));
    expect(view.getByRole("textbox", { name: "Query SQL" })).toBeTruthy();
  });

  test("a filter query reports an empty list, a failure, and a late answer", async () => {
    storage.saveConnection(connection);
    const gate: { release: (() => void) | null } = { release: null };
    mockGlobalFetch({
      "/api/db/query": (req) =>
        new Promise((resolve) => {
          void req.json().then((body: { sql?: string }) => {
            if (body.sql === "WAIT") {
              gate.release = () => resolve({ json: rows });
              return;
            }
            if (body.sql === "FAIL") {
              resolve({ status: 400, json: { error: "refused" } });
              return;
            }
            resolve({ json: { ...rows, rows: [{ region: "" }] } });
          });
        }),
    });
    storage.saveDashboard({
      ...board("sales", []),
      filters: [
        {
          id: "blank",
          name: "blank",
          query: "SELECT blank FROM sales",
          connectionId: "c1",
          value: "kept",
          control: "select",
        },
        { id: "bad", name: "bad", query: "FAIL", connectionId: "c1", value: "", control: "select" },
        { id: "wait", name: "wait", query: "WAIT", connectionId: "c1", value: "", control: "select" },
      ],
    });
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    expect(await view.findByText("That query did not return any choices.")).toBeTruthy();
    expect(await view.findByText("refused")).toBeTruthy();
    const kept = view.getAllByLabelText("Filter selection")[0] as HTMLSelectElement;
    expect(Array.from(kept.options).some((option) => option.value === "kept")).toBe(true);
    await waitFor(() => expect(gate.release).not.toBeNull());
    view.unmount();
    gate.release?.();
  });

  test("a filter id is fixed, and an unusable id says so", () => {
    storage.saveDashboard({
      ...board("sales", []),
      filters: [{ id: "f1", name: "1bad", label: "Region", query: "", value: "", control: "select" }],
    });
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    const id = view.getByLabelText("Filter id") as HTMLInputElement;
    expect(id.readOnly).toBe(true);
    expect(id.value).toBe("1bad");
    fireEvent.change(id, { target: { value: "region" } });
    expect(id.value).toBe("1bad");
    expect(view.getByText("This id cannot be used in a query.")).toBeTruthy();
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.name).toBe("1bad");
  });

  test("a vector filter keeps a generated id and embeds the words typed in its box", () => {
    storage.saveDashboard({
      ...board("sales", []),
      filters: [{ id: "f1", name: "region", label: "Region", query: "", value: "", control: "select" }],
    });
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Vector text" }));
    const name = (view.getByLabelText("Filter id") as HTMLInputElement).value;
    expect(name).toBe("region");
    expect((view.getByLabelText("Filter id") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(view.getByLabelText("Filter id"), { target: { value: "1bad" } });
    expect((view.getByLabelText("Filter id") as HTMLInputElement).value).toBe("region");
    expect(view.getByText(/in the vector value/)).toBeTruthy();
    expect((view.getByLabelText("Filter placeholder") as HTMLInputElement).value).toBe("Text to embed");
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    const box = view.getByLabelText("Vector text") as HTMLInputElement;
    expect(box.placeholder).toBe("Text to embed");
    expect(view.getByText("{{region}}")).toBeTruthy();
    fireEvent.change(box, { target: { value: "a red mug" } });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("a red mug");
    fireEvent.click(view.getByRole("button", { name: "Viewer" }));
    expect(view.queryByText("{{region}}")).toBeNull();
    expect(view.queryByLabelText("Filter id")).toBeNull();
    expect((view.getByLabelText("Vector text") as HTMLInputElement).placeholder).toBe("Text to embed");
  });

  test("a chart query uses a filter id without an insert menu", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart());
    storage.saveDashboard({
      ...board("sales", ["revenue"]),
      filters: [
        { id: "bad", name: "1bad", query: "", value: "", control: "select" },
        { id: "region", name: "region", label: "Region", query: "", value: "west", control: "select" },
      ],
    });
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
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    expect(view.queryByLabelText("Insert variable")).toBeNull();
    expect(view.queryByLabelText("Embed as vector")).toBeNull();
    fireEvent.change(view.getByRole("textbox", { name: "Query SQL" }), {
      target: { value: "SELECT region, total FROM sales {{region}} {{embed region}}" },
    });
    fireEvent.click(view.getByRole("button", { name: "Run Revenue" }));
    await waitFor(() => {
      const query = storage.getSavedCharts().find((item) => item.id === "revenue")?.query ?? "";
      expect(query).toContain("{{region}}");
      expect(query).toContain("{{embed region}}");
    });
    await waitFor(() =>
      expect(
        posted.some((sql) => sql.includes("'west'") && sql.includes('{{embed "west"}}') && !sql.includes("{{region")),
      ).toBe(true),
    );
  });

  test("saves a component and places it on another dashboard", () => {
    storage.saveDashboard({
      ...board("sales", []),
      filters: [
        {
          id: "f1",
          name: "region",
          label: "Region",
          query: "SELECT region FROM sales",
          value: "east",
          control: "select",
          connectionId: "c1",
        },
      ],
    });
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Saved component" }));
    expect(view.getByText("Save a component from a dashboard, then add it here.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    fireEvent.change(view.getByLabelText("Dashboard"), { target: { value: "sales" } });
    const save = view.getByRole("button", { name: "Save Region component" });
    expect(save.getAttribute("aria-pressed")).toBe("false");
    expect(save.className).not.toContain("bg-brand-solid");
    fireEvent.click(save);
    expect(save.getAttribute("aria-pressed")).toBe("true");
    expect(save.className).toContain("bg-brand-solid");
    const saved = storage.getSavedComponents();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.filter).toMatchObject({ name: "region", query: "SELECT region FROM sales", value: "east" });
    expect(storage.getSavedDashboards().find((item) => item.id === "sales")?.filters?.[0]?.componentId).toBe(
      saved[0]?.id,
    );
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "Area" } });
    const unsave = view.getByRole("button", { name: "Unsave Area component" });
    expect(unsave.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unsave);
    expect(storage.getSavedComponents()).toHaveLength(1);
    expect(view.getByRole("button", { name: "Confirm unsave Area component" })).toBeTruthy();
    fireEvent.click(unsave);
    expect(view.queryByRole("button", { name: "Confirm unsave Area component" })).toBeNull();
    fireEvent.click(unsave);
    fireEvent.click(view.getByRole("button", { name: "Confirm unsave Area component" }));
    expect(storage.getSavedComponents()).toEqual([]);
    expect(storage.getSavedDashboards().find((item) => item.id === "sales")?.filters?.[0]?.componentId).toBeUndefined();
    expect(view.getByLabelText("Component title")).toBeTruthy();
    const saveAgain = view.getByRole("button", { name: "Save Area component" });
    expect(saveAgain.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(saveAgain);
    expect(storage.getSavedComponents()).toHaveLength(1);
    expect(storage.getSavedComponents()[0]?.name).toBe("Area");
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Saved component" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Area" }));
    const placedSave = view.getByRole("button", { name: "Unsave Area component" });
    expect(placedSave.getAttribute("aria-pressed")).toBe("true");
    expect(placedSave.className).toContain("bg-brand-solid");
    const placed = storage.getSavedDashboards().find((item) => item.id !== "sales" && (item.filters?.length ?? 0) > 0);
    expect(placed?.filters?.[0]).toMatchObject({
      name: "region",
      label: "Area",
      query: "SELECT region FROM sales",
      value: "east",
      control: "select",
      componentId: storage.getSavedComponents()[0]?.id,
    });
    expect(placed?.filters?.[0]?.id).not.toBe("f1");
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    expect(view.queryByLabelText("Filter search")).toBeNull();
    expect(view.getByLabelText("Filter placeholder")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Component title"), { target: { value: "Zone" } });
    const edited = storage.getSavedDashboards().find((item) => item.id === placed?.id);
    expect(edited?.filters?.[0]).toMatchObject({ label: "Zone", control: "search" });
    expect(storage.getSavedComponents()[0]?.filter.label).toBe("Area");
  });

  test("asks the assistant to add a chart", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart());
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    const posted: { schemaContext?: string; editorSql?: string; boardContext?: string; databaseType?: string }[] = [];
    mockGlobalFetch({
      "/api/ai/assist": async (req) => {
        if (req.method === "GET") return { json: { models: [] } };
        const body = (await req.json()) as {
          schemaContext?: string;
          editorSql?: string;
          boardContext?: string;
          databaseType?: string;
        };
        posted.push(body);
        return {
          json: {
            explanation: "East is ahead.",
            queries: [{ title: "Revenue", sql: "SELECT region, total FROM sales", chart: null }],
          },
        };
      },
    });
    const view = render(<DashboardStudio />);
    const ask = view.getByRole("button", { name: "Ask AI" });
    expect(ask.className).toContain("fixed");
    fireEvent.click(ask);
    expect(view.getByLabelText("Dashboard conversation")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Instructions for AI"), { target: { value: "Assume the latest month." } });
    fireEvent.change(view.getByLabelText("Ask about this dashboard"), { target: { value: "Chart revenue" } });
    expect(view.getByLabelText("Ask about this dashboard").getAttribute("placeholder")).toBe(
      "Ask a question about this dashboard",
    );
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findAllByText("East is ahead.")).toHaveLength(1);
    expect(posted[0]?.editorSql).toBeUndefined();
    expect(posted[0]?.databaseType).toBe("postgres");
    expect(posted[0]?.schemaContext ?? "").not.toContain("Dashboard:");
    expect(posted[0]?.boardContext).toContain("Instructions: Assume the latest month.");
    expect(posted[0]?.boardContext).toContain('1. chart "Revenue" | Bar / Basic | connection "Orders"');
    expect(posted[0]?.boardContext).toContain("trusted sql: SELECT region, total FROM sales");
    expect(posted[0]?.boardContext).toContain("shelves region, total");
    expect(view.queryByRole("button", { name: "Add as chart" })).toBeNull();
    expect(view.queryByRole("button", { name: "Add as text" })).toBeNull();
    expect(
      storage
        .getSavedCharts()
        .some((item) => item.id !== "revenue" && item.query === "SELECT region, total FROM sales"),
    ).toBe(true);
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(2);
    expect(storage.getSavedDashboards()[0]?.notes).toBeUndefined();
    expect(view.queryByRole("menuitem", { name: "Text box" })).toBeNull();
  });

  test("the assistant starts a dashboard when none is open", async () => {
    mockGlobalFetch({
      "/api/ai/assist": async (req) => {
        if (req.method === "GET") return { json: { models: [] } };
        const body = (await req.json()) as { question?: string };
        if (body.question === "Write") return { json: { explanation: "A note.", queries: [] } };
        if (body.question === "Numbers") {
          return { json: { explanation: "", queries: [{ title: "Query", sql: "SELECT 2", chart: null }] } };
        }
        return {
          json: {
            explanation: "A note.",
            queries: [{ title: "Query", sql: "SELECT 1", chart: null }],
          },
        };
      },
    });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(view.getByLabelText("Ask about this dashboard"), { target: { value: "Start" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findAllByText("A note.")).toHaveLength(1);
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();
    expect(storage.getSavedDashboards()).toHaveLength(1);
    expect(storage.getSavedCharts()[0]?.query).toBe("SELECT 1");
    expect(storage.getSavedDashboards()[0]?.notes).toBeUndefined();
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(1);
    expect(storage.getActiveDashboardId()).toBe(storage.getSavedDashboards()[0]?.id ?? null);
    view.unmount();
    localStorage.clear();
    const again = render(<DashboardStudio />);
    fireEvent.click(again.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(again.getByLabelText("Ask about this dashboard"), { target: { value: "Write" } });
    fireEvent.click(again.getByRole("button", { name: "Send" }));
    expect(await again.findAllByText("A note.")).toHaveLength(1);
    expect(storage.getSavedDashboards()).toHaveLength(0);
    expect(storage.getSavedCharts()).toHaveLength(0);
    fireEvent.change(again.getByLabelText("Ask about this dashboard"), { target: { value: "Numbers" } });
    fireEvent.click(again.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(storage.getSavedCharts()[0]?.query).toBe("SELECT 2"));
    expect(storage.getSavedDashboards()[0]?.notes).toBeUndefined();
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(1);
  });

  test("viewer mode shows charts and filters without the editing controls", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart({ token: "c_abc1234567" }));
    storage.saveChart(
      chart({
        id: "plain",
        name: "Plain",
        query: "SELECT 1",
        chartType: "bar",
        typeId: undefined,
        variationId: undefined,
        selection: undefined,
        xAxis: undefined,
        yAxis: undefined,
      }),
    );
    storage.saveDashboard({
      ...board("sales", ["revenue", "plain"], "Sales board"),
      filters: [
        { id: "region", name: "region", label: "Region", query: "", value: "east", control: "search" },
        { id: "open", name: "open", query: "", value: "" },
      ],
      notes: [
        { id: "hello", text: "Hello from the board" },
        { id: "blank", text: "" },
        { id: "drawn", text: "Drawn", script: "root.textContent = text;" },
      ],
    });
    storage.setActiveDashboardId("sales");
    const storedCharts = JSON.parse(localStorage.getItem("libredb_saved_charts") ?? "[]") as {
      id?: string;
      token?: string;
    }[];
    const plainChart = storedCharts.find((item) => item.id === "plain");
    if (plainChart) delete plainChart.token;
    localStorage.setItem("libredb_saved_charts", JSON.stringify(storedCharts));
    mockGlobalFetch({ "/api/db/query": { json: rows } });
    const view = render(<DashboardStudio />);
    expect(view.getByRole("button", { name: "Editor" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("button", { name: "Add content" })).toBeTruthy();
    expect(view.getByLabelText("Dashboard name")).toBeTruthy();
    expect(view.getAllByLabelText("Chart title")).toHaveLength(2);
    expect(view.getAllByLabelText("Component title")).toHaveLength(2);
    await waitFor(() => expect(view.getAllByLabelText("Chart id")).toHaveLength(2));
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "plain")?.token).toMatch(/^c_[a-f0-9]{10}$/),
    );
    expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.token).toBe("c_abc1234567");
    expect(view.getByText("{{region}}")).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: "Text box" })).toBeNull();
    expect(view.queryByRole("textbox", { name: "Text box" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Viewer" }));
    expect(view.getByRole("button", { name: "Viewer" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("heading", { name: "Sales board" })).toBeTruthy();
    expect(view.getByLabelText("Dashboard")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add content" })).toBeNull();
    expect(view.queryByRole("button", { name: "New dashboard" })).toBeNull();
    expect(view.queryByLabelText("Dashboard name")).toBeNull();
    expect(view.queryByRole("button", { name: "Delete dashboard" })).toBeNull();
    expect(view.queryByText("Make it your own")).toBeNull();
    expect(view.queryByText("ON THIS DASHBOARD")).toBeNull();
    expect(
      view.queryByText(
        "Compile a dashboard from saved charts. Save more than one, and switch when you want a different view.",
      ),
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Ask AI" })).toBeNull();
    expect(view.queryByLabelText("Dashboard conversation")).toBeNull();
    expect(view.queryByLabelText("Chart title")).toBeNull();
    expect(view.queryByLabelText("Chart id")).toBeNull();
    expect(view.queryByText("{{region}}")).toBeNull();
    expect(view.queryByRole("button", { name: "Query" })).toBeNull();
    expect(view.queryByRole("button", { name: "Code" })).toBeNull();
    expect(view.queryByRole("button", { name: "Use Bar chart" })).toBeNull();
    expect(view.queryByRole("button", { name: "Unsave Revenue" })).toBeNull();
    expect(view.queryByRole("button", { name: "Remove Revenue" })).toBeNull();
    expect(view.queryByRole("button", { name: "Resize Revenue" })).toBeNull();
    expect(view.queryByLabelText("Component title")).toBeNull();
    expect(view.queryByRole("button", { name: "Design" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save Region component" })).toBeNull();
    expect(view.queryByRole("button", { name: "Remove region filter" })).toBeNull();
    expect(view.queryByRole("button", { name: "Text query" })).toBeNull();
    expect(view.queryByRole("button", { name: "Text code" })).toBeNull();
    expect(view.queryByRole("button", { name: "Remove text" })).toBeNull();
    expect(view.queryByRole("button", { name: "Bold" })).toBeNull();
    expect(view.queryByLabelText("Text font")).toBeNull();
    expect(view.queryByRole("button", { name: "Resize text box" })).toBeNull();
    expect(view.queryByRole("textbox", { name: "Text box" })).toBeNull();
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Region" })).toBeTruthy();
    expect(view.getByText("This filter is not ready to view.")).toBeTruthy();
    expect(view.queryByLabelText("Text box")).toBeNull();
    expect(view.queryByTitle("Text script")).toBeNull();
    expect(view.queryByText("Hello from the board")).toBeNull();
    expect(await view.findByTestId("assist-chart")).toBeTruthy();
    expect(view.queryByRole("group", { name: "Dimension" })).toBeNull();
    expect(view.queryByRole("group", { name: "Metrics" })).toBeNull();
    expect(await view.findByText("This chart is not ready to view.")).toBeTruthy();

    fireEvent.change(view.getByLabelText("Filter search"), { target: { value: "west" } });
    expect(storage.getSavedDashboards()[0]?.filters?.find((item) => item.id === "region")?.value).toBe("west");

    fireEvent.click(view.getByRole("button", { name: "Editor" }));
    expect(view.getByRole("group", { name: "Dimension" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Create" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Add content" })).toBeTruthy();
    expect(view.getAllByLabelText("Chart title")).toHaveLength(2);
    expect(view.getByRole("button", { name: "Ask AI" })).toBeTruthy();
  });

  test("viewer mode on an empty page names the page Dash", () => {
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Viewer" }));
    expect(view.getByRole("heading", { name: "Dash" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "New dashboard" })).toBeNull();
    expect(view.getByText("You have no dashboards yet.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Editor" }));
    expect(view.getByRole("heading", { name: "Create" })).toBeTruthy();
    expect(view.getByRole("button", { name: "New dashboard" })).toBeTruthy();
  });
});
