import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
import {
  DEFAULT_DASHBOARD_BLOCK_WIDTH,
  DEFAULT_DASHBOARD_FILTER_HEIGHT,
  MIN_DASHBOARD_BLOCK_HEIGHT,
} from "@/lib/dashboards/dashboard";
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
    expect(await view.findByRole("button", { name: "Use Bar chart" })).toBeTruthy();
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
    expect((drawnOptions.at(-1)?.color as string[])[0]).toBe("#112233");
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
    fireEvent.click(await view.findByRole("button", { name: "Use Bar chart" }));
    expect(view.queryByRole("group", { name: "Chart variations" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use Line chart" }));
    expect(view.queryByRole("button", { name: "Use Bar Stacked chart" })).toBeNull();
    expect(view.getByRole("button", { name: "Use Line Area chart" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Use Bar chart" }));
    fireEvent.click(view.getByRole("button", { name: "Use Bar Stacked chart" }));
    await view.findByTestId("assist-chart");
    expect(storage.getSavedCharts()[0]).toMatchObject({ typeId: "bar", variationId: "stacked", connectionId: "c1" });
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBeUndefined();
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "c1" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBe("c1");
    fireEvent.change(view.getByLabelText("Chart title"), { target: { value: "Revenue" } });
    expect(storage.getSavedCharts()[0]?.name).toBe("Revenue");
  });

  test("adds a text box", () => {
    window.innerWidth = 1024;
    storage.saveDashboard(board("sales", []));
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    expect(view.getByRole("menuitem", { name: "Text box" }).textContent).toContain("Add a note or context");
    fireEvent.click(view.getByRole("menuitem", { name: "Text box" }));
    expect(view.queryByRole("heading", { name: "Text" })).toBeNull();
    const box = view.getByLabelText("Text box") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Add a note or context");
    fireEvent.change(box, { target: { value: "Hello" } });
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.text).toBe("Hello");
    expect(box.closest("article")?.style.width).toBe(`${DEFAULT_DASHBOARD_BLOCK_WIDTH}px`);
    const handle = view.getByRole("button", { name: "Resize text box" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: -200 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: -200 });
    expect(storage.getSavedDashboards()[0]?.notes?.[0]).toMatchObject({
      text: "Hello",
      width: DEFAULT_DASHBOARD_BLOCK_WIDTH + 40,
      height: MIN_DASHBOARD_BLOCK_HEIGHT,
    });
    fireEvent.click(view.getByRole("button", { name: "Remove text" }));
    expect(storage.getSavedDashboards()[0]?.notes).toEqual([]);
  });

  test("fills a text box from a query and keeps its type", async () => {
    storage.saveConnection(connection);
    storage.saveDashboard({
      ...board("sales", []),
      filters: [{ id: "f1", name: "region", query: "", value: "east", connectionId: "c1" }],
    });
    storage.setActiveDashboardId("sales");
    const posted: string[] = [];
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql?: string };
        posted.push(body.sql ?? "");
        if (body.sql === "FAIL") return { status: 400, json: { error: "refused" } };
        if (body.sql === "SELECT blank") return { json: { ...rows, rows: [{ value: null }], fields: ["value"] } };
        return {
          json: {
            rows: [{ line: "Area east" }, { line: "And more" }],
            fields: ["line"],
            rowCount: 2,
            executionTime: 1,
          },
        };
      },
    });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Text box" }));
    fireEvent.change(view.getByLabelText("Text box"), { target: { value: "Hello" } });
    fireEvent.change(view.getByLabelText("Text font"), { target: { value: "Georgia, serif" } });
    fireEvent.change(view.getByLabelText("Text size"), { target: { value: "32" } });
    fireEvent.change(view.getByLabelText("Color"), { target: { value: "#112233" } });
    fireEvent.change(view.getByLabelText("Background"), { target: { value: "#ffeeee" } });
    fireEvent.click(view.getByRole("button", { name: "Bold" }));
    fireEvent.click(view.getByRole("button", { name: "Italic" }));
    fireEvent.click(view.getByRole("button", { name: "Align center" }));
    fireEvent.click(view.getByRole("button", { name: "Align right" }));
    const styled = view.getByLabelText("Text box") as HTMLTextAreaElement;
    expect(styled.style.fontFamily).toContain("Georgia");
    expect(styled.style.fontSize).toBe("32px");
    expect(styled.style.fontWeight).toBe("700");
    expect(styled.style.fontStyle).toBe("italic");
    expect(styled.style.textAlign).toBe("right");
    expect(styled.style.color).not.toBe("");
    expect(styled.style.backgroundColor).not.toBe("");
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.style).toMatchObject({
      color: "#112233",
      background: "#ffeeee",
    });
    fireEvent.click(view.getByRole("button", { name: "Align left" }));
    fireEvent.click(view.getByRole("button", { name: "Default text color" }));
    fireEvent.click(view.getByRole("button", { name: "Default background" }));
    expect(view.getByLabelText("Text box").style.color).toBe("");
    expect(view.getByLabelText("Text box").style.backgroundColor).toBe("");
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.style).toMatchObject({
      fontFamily: "Georgia, serif",
      fontSize: 32,
      align: "left",
      bold: true,
      italic: true,
    });
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.style?.color).toBeUndefined();
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.style?.background).toBeUndefined();

    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    expect(view.getByText("The result of this query is the text. Include the words in the SQL.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Insert variable"), { target: { value: "{{region}}" } });
    expect((view.getByLabelText("Query SQL") as HTMLTextAreaElement).value).toBe("{{region}}");
    fireEvent.change(view.getByLabelText("Text connection"), { target: { value: "" } });
    fireEvent.change(view.getByLabelText("Text connection"), { target: { value: "c1" } });
    fireEvent.change(view.getByLabelText("Query SQL"), { target: { value: "SELECT 'Area ' || {{region}}" } });
    fireEvent.click(view.getByRole("button", { name: "Run text query" }));
    expect((await view.findByLabelText("Text box")).textContent).toBe("Area east\nAnd more");
    expect(posted.some((sql) => sql.includes("'east'"))).toBe(true);
    const filled = view.getByLabelText("Text box");
    expect(filled.style.fontSize).toBe("32px");
    expect(filled.style.fontWeight).toBe("700");
    expect(filled.style.textAlign).toBe("left");

    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    fireEvent.change(view.getByLabelText("Query SQL"), { target: { value: "FAIL" } });
    fireEvent.click(view.getByRole("button", { name: "Run text query" }));
    expect((await view.findByRole("alert")).textContent).toBe("refused");

    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    fireEvent.change(view.getByLabelText("Query SQL"), { target: { value: "SELECT blank" } });
    fireEvent.click(view.getByRole("button", { name: "Run text query" }));
    expect(await view.findByText("That query did not return any text.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    fireEvent.change(view.getByLabelText("Text connection"), { target: { value: "" } });
    fireEvent.click(view.getByRole("button", { name: "Text" }));
    expect(view.getByText("Choose a connection for this text.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    fireEvent.change(view.getByLabelText("Query SQL"), { target: { value: "" } });
    fireEvent.click(view.getByRole("button", { name: "Run text query" }));
    expect((view.getByLabelText("Text box") as HTMLTextAreaElement).value).toBe("Hello");
  });

  test("ignores a text query that finishes after the box is gone", async () => {
    storage.saveConnection(connection);
    storage.saveDashboard({
      ...board("sales", []),
      notes: [{ id: "n1", text: "", query: "SELECT 1", connectionId: "c1" }],
    });
    storage.setActiveDashboardId("sales");
    let release: (() => void) | null = null;
    mockGlobalFetch({
      "/api/db/query": () =>
        new Promise((resolve) => {
          release = () => resolve({ json: rows });
        }),
    });
    const view = render(<DashboardStudio />);
    expect(view.getByText("Running the query…")).toBeTruthy();
    await waitFor(() => expect(release).not.toBeNull());
    view.unmount();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("says when a text query's connection is gone and offers an odd size", async () => {
    storage.saveDashboard({
      ...board("sales", []),
      notes: [
        {
          id: "n1",
          text: "Keep",
          query: "SELECT 1",
          connectionId: "gone",
          style: { fontSize: 15 },
        },
      ],
    });
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({ "/api/db/query": { json: rows } });
    const view = render(<DashboardStudio />);
    expect((await view.findByRole("alert")).textContent).toBe("That connection is no longer available.");
    const size = view.getByLabelText("Text size") as HTMLSelectElement;
    expect(Array.from(size.options).some((option) => option.value === "15")).toBe(true);
  });

  test("lets a text box draw itself with JavaScript", async () => {
    storage.saveConnection(connection);
    storage.saveDashboard(board("sales", []));
    storage.setActiveDashboardId("sales");
    mockGlobalFetch({
      "/api/db/query": {
        json: { rows: [{ line: "Area east" }], fields: ["line"], rowCount: 1, executionTime: 1 },
      },
    });
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Text box" }));
    fireEvent.change(view.getByLabelText("Text box"), { target: { value: "Hello" } });
    fireEvent.click(view.getByRole("button", { name: "Text code" }));
    expect(view.getByText("JavaScript can read text, rows, and fields, and draw into #root.")).toBeTruthy();
    const editor = view.getByRole("textbox", { name: "JavaScript" }) as HTMLTextAreaElement;
    expect(editor.value).toContain("root.textContent = text");
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.script).toBeUndefined();
    fireEvent.change(editor, {
      target: { value: 'const root = document.getElementById("root"); root.textContent = text;' },
    });
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.script).toContain("root.textContent = text");
    fireEvent.click(view.getByRole("button", { name: "Text" }));
    const frame = view.getByTitle("Text script") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("Hello");
    expect(frame.getAttribute("srcdoc")).toContain("root.textContent = text");
    fireEvent.change(view.getByLabelText("Text box"), { target: { value: "Hello there" } });
    expect(view.getByTitle("Text script").getAttribute("srcdoc")).toContain("Hello there");
    fireEvent.click(view.getByRole("button", { name: "Text code" }));
    fireEvent.change(view.getByRole("textbox", { name: "JavaScript" }), { target: { value: "   " } });
    fireEvent.click(view.getByRole("button", { name: "Text" }));
    expect(view.queryByTitle("Text script")).toBeNull();
    expect((view.getByLabelText("Text box") as HTMLTextAreaElement).value).toBe("Hello there");

    fireEvent.click(view.getByRole("button", { name: "Text code" }));
    fireEvent.change(view.getByRole("textbox", { name: "JavaScript" }), {
      target: { value: "root.textContent = rows.length;" },
    });
    fireEvent.click(view.getByRole("button", { name: "Text query" }));
    fireEvent.change(view.getByLabelText("Text connection"), { target: { value: "c1" } });
    fireEvent.change(view.getByLabelText("Query SQL"), { target: { value: "SELECT 'Area east'" } });
    fireEvent.click(view.getByRole("button", { name: "Run text query" }));
    const drawn = (await view.findByTitle("Text script")) as HTMLIFrameElement;
    expect(drawn.getAttribute("srcdoc")).toContain("Area east");
    expect(drawn.getAttribute("srcdoc")).toContain("rows.length");
    expect(view.queryByLabelText("Text box")).toBeNull();
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
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "region" } });
    expect(view.getByText("Reference this selection in a query as {{region}}.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "1bad" } });
    expect(view.getByText("Use a name like region so a query can reference it.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "" } });
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "" } });
    expect((view.getByLabelText("Component title") as HTMLInputElement).value).toBe("Filter");
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "region" } });
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
    expect(frame.getAttribute("srcdoc")).toContain("setValue");
    const filterId = storage.getSavedDashboards()[0]?.filters?.[0]?.id ?? "";
    const message = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data }));
    message({ source: "libredb-filter", id: "other", value: "nope" });
    message({ source: "libredb-filter", id: filterId, value: "east" });
    message({ source: "libredb-filter", id: filterId, value: "north" });
    await waitFor(() => expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("north"));
    fireEvent.click(view.getByRole("button", { name: "Remove region filter" }));
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

  test("inserts a dashboard variable id into the chart query", async () => {
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
    const variable = view.getByLabelText("Insert variable") as HTMLSelectElement;
    expect(Array.from(variable.options).map((option) => option.value)).toEqual(["", "{{region}}"]);
    expect(variable.options[0]?.textContent).toBe("Insert an id");
    fireEvent.change(variable, { target: { value: "" } });
    fireEvent.change(variable, { target: { value: "{{region}}" } });
    expect((view.getByRole("textbox", { name: "Query SQL" }) as HTMLTextAreaElement).value).toBe(
      "SELECT region, total FROM sales {{region}}",
    );
    fireEvent.click(view.getByRole("button", { name: "Run Revenue" }));
    await waitFor(() =>
      expect(storage.getSavedCharts().find((item) => item.id === "revenue")?.query).toContain("{{region}}"),
    );
    await waitFor(() => expect(posted.some((sql) => sql.includes("'west'") && !sql.includes("{"))).toBe(true));
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
    fireEvent.click(view.getByRole("button", { name: "Save Area component" }));
    expect(storage.getSavedComponents()).toHaveLength(1);
    expect(storage.getSavedComponents()[0]?.name).toBe("Area");
    fireEvent.click(view.getByRole("button", { name: "New dashboard" }));
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Saved component" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Area" }));
    const placedSave = view.getByRole("button", { name: "Save Area component" });
    expect(placedSave.getAttribute("aria-pressed")).toBe("true");
    expect(placedSave.className).toContain("bg-brand-solid");
    const placed = storage.getSavedDashboards().find((item) => item.id !== "sales" && (item.filters?.length ?? 0) > 0);
    expect(placed?.filters?.[0]).toMatchObject({
      name: "region",
      label: "Area",
      query: "SELECT region FROM sales",
      value: "east",
      control: "select",
      componentId: saved[0]?.id,
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

  test("asks the assistant to add a chart and a text box", async () => {
    storage.saveConnection(connection);
    storage.saveChart(chart());
    storage.saveDashboard(board("sales", ["revenue"]));
    storage.setActiveDashboardId("sales");
    const posted: { schemaContext?: string; editorSql?: string; databaseType?: string }[] = [];
    mockGlobalFetch({
      "/api/ai/assist": async (req) => {
        if (req.method === "GET") return { json: { models: [] } };
        const body = (await req.json()) as { schemaContext?: string; editorSql?: string; databaseType?: string };
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
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Chart revenue" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findAllByText("East is ahead.")).toHaveLength(2);
    expect(posted[0]?.editorSql).toBe("SELECT region, total FROM sales");
    expect(posted[0]?.databaseType).toBe("postgres");
    expect(posted[0]?.schemaContext).toContain("Dashboard: sales");
    expect(posted[0]?.schemaContext).toContain("Chart Revenue: SELECT region, total FROM sales");
    expect(posted[0]?.schemaContext).toContain("Take the time to write a complete query");
    expect(view.queryByRole("button", { name: "Add as chart" })).toBeNull();
    expect(view.queryByRole("button", { name: "Add as text" })).toBeNull();
    expect(
      storage
        .getSavedCharts()
        .some((item) => item.id !== "revenue" && item.query === "SELECT region, total FROM sales"),
    ).toBe(true);
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(2);
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.text).toBe("East is ahead.");
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
    fireEvent.change(view.getByLabelText("Build or revise a query"), { target: { value: "Start" } });
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(await view.findAllByText("A note.")).toHaveLength(2);
    expect(view.queryByRole("button", { name: "Use this query" })).toBeNull();
    expect(storage.getSavedDashboards()).toHaveLength(1);
    expect(storage.getSavedCharts()[0]?.query).toBe("SELECT 1");
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.text).toBe("A note.");
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(1);
    expect(storage.getActiveDashboardId()).toBe(storage.getSavedDashboards()[0]?.id ?? null);
    view.unmount();
    localStorage.clear();
    const again = render(<DashboardStudio />);
    fireEvent.click(again.getByRole("button", { name: "Ask AI" }));
    fireEvent.change(again.getByLabelText("Build or revise a query"), { target: { value: "Write" } });
    fireEvent.click(again.getByRole("button", { name: "Send" }));
    expect(await again.findAllByText("A note.")).toHaveLength(2);
    expect(storage.getSavedDashboards()).toHaveLength(1);
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.text).toBe("A note.");
    expect(storage.getSavedCharts()).toHaveLength(0);
    fireEvent.change(again.getByLabelText("Build or revise a query"), { target: { value: "Numbers" } });
    fireEvent.click(again.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(storage.getSavedCharts()[0]?.query).toBe("SELECT 2"));
    expect(storage.getSavedDashboards()[0]?.notes).toHaveLength(1);
    expect(storage.getSavedDashboards()[0]?.charts).toHaveLength(1);
  });
});
