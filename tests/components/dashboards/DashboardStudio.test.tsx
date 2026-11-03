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
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Add chart" }));
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.getByRole("menuitem", { name: "Make a chart" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Add chart" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Revenue" }));
    const tile = await view.findByTestId("dashboard-chart-revenue");
    const heading = view.getByRole("heading", { name: "Revenue" });
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
    await view.findByTestId("assist-chart");
    expect(storage.getSavedCharts()[0]).toMatchObject({ typeId: "bar", variationId: "basic", connectionId: "c1" });
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBeUndefined();
    fireEvent.change(view.getByLabelText("Connection for Chart"), { target: { value: "c1" } });
    expect(storage.getSavedCharts()[0]?.connectionId).toBe("c1");
  });

  test("adds a text box", () => {
    storage.saveDashboard(board("sales", []));
    storage.setActiveDashboardId("sales");
    const view = render(<DashboardStudio />);
    fireEvent.click(view.getByRole("button", { name: "Add content" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Text box" }));
    fireEvent.change(view.getByLabelText("Text box"), { target: { value: "Hello" } });
    expect(storage.getSavedDashboards()[0]?.notes?.[0]?.text).toBe("Hello");
    fireEvent.click(view.getByRole("button", { name: "Remove text" }));
    expect(storage.getSavedDashboards()[0]?.notes).toEqual([]);
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
    fireEvent.click(view.getByRole("button", { name: "Dropdown" }));
    expect(view.getByLabelText("Filter selection")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "Region" } });
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "region" } });
    expect(view.getByText("Reference this selection in a query as {{region}}.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "1bad" } });
    expect(view.getByText("Use a name like region so a query can reference it.")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter label"), { target: { value: "" } });
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "" } });
    expect(view.getByRole("heading", { name: "Filter" })).toBeTruthy();
    fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "region" } });
    fireEvent.click(view.getByRole("button", { name: "Choices" }));
    fireEvent.click(view.getByRole("button", { name: "Run choices" }));
    expect(view.getByRole("alert").textContent).toBe("Add a connection and a query to fill the choices.");
    fireEvent.change(view.getByLabelText("Filter connection"), { target: { value: "" } });
    fireEvent.change(view.getByLabelText("Filter query"), { target: { value: "SELECT region FROM sales" } });
    fireEvent.change(view.getByLabelText("Filter connection"), { target: { value: "c1" } });
    fireEvent.click(view.getByRole("button", { name: "Run choices" }));
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    await waitFor(() =>
      expect((view.getByLabelText("Filter selection") as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    fireEvent.change(view.getByLabelText("Filter selection"), { target: { value: "west" } });
    await waitFor(() => expect(posted.some((sql) => sql.includes("region = 'west'") && !sql.includes("{"))).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.click(view.getByRole("button", { name: "Slider" }));
    expect(view.getByLabelText("Filter slider")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.change(view.getByLabelText("Filter minimum"), { target: { value: "1" } });
    fireEvent.change(view.getByLabelText("Filter maximum"), { target: { value: "9" } });
    fireEvent.change(view.getByLabelText("Filter step"), { target: { value: "2" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    fireEvent.change(view.getByLabelText("Filter search"), { target: { value: "east" } });
    expect(storage.getSavedDashboards()[0]?.filters?.[0]?.value).toBe("east");
    fireEvent.click(view.getByRole("button", { name: "Design" }));
    fireEvent.change(view.getByLabelText("Filter placeholder"), { target: { value: "Find" } });
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
    fireEvent.click(view.getByRole("button", { name: "Save Region component" }));
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
  });
});
