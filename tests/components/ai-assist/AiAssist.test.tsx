import "../../setup-dom";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";
import { ASSIST_TRANSCRIPT_KEY } from "@/lib/ai/assist-history";
import { readAssistSettings, writeAssistSettings } from "@/lib/ai/assist-settings";
import type { AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import type { QueryResult } from "@/lib/types";

const charts: {
  setOption: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
}[] = [];

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => {
    const chart = { setOption: mock(() => {}), resize: mock(() => {}), dispose: mock(() => {}) };
    charts.push(chart);
    return chart;
  },
  registerMap: () => {},
}));
mock.module("echarts/charts", () => ({
  LineChart: {},
  BarChart: {},
  ScatterChart: {},
  RadarChart: {},
  BoxplotChart: {},
  CandlestickChart: {},
  HeatmapChart: {},
  GraphChart: {},
  TreemapChart: {},
  SankeyChart: {},
  FunnelChart: {},
  GaugeChart: {},
}));
mock.module("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  RadarComponent: {},
  GeoComponent: {},
  TitleComponent: {},
  VisualMapComponent: {},
}));
mock.module("echarts/renderers", () => ({ CanvasRenderer: {} }));
mock.module("@/components/QueryEditor", () => ({
  QueryEditor: ({ value, onContentChange }: { value: string; onContentChange?: (value: string) => void }) =>
    React.createElement("textarea", {
      "aria-label": "SQL editor",
      defaultValue: value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onContentChange?.(event.target.value),
    }),
}));
mock.module("@/components/auth/WorkspaceOwnerGate", () => ({
  WorkspaceOwnerGate: ({ children }: { children: React.ReactNode }) => children,
}));

setupChartCodeMonacoMock();

const { AssistChartCanvas } = await import("@/components/ai-assist/AssistChartCanvas");
const { ChartWithEditor } = await import("@/components/ai-assist/ChartWithEditor");
const { AiAssist } = await import("@/components/ai-assist/AiAssist");
const { default: AssistPage } = await import("@/app/assist/page");

class ImmediateObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "nope" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const calls: { url: string; method: string; body: unknown }[] = [];

function defaultFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  let body: unknown = null;
  if (init?.body !== undefined) body = JSON.parse(String(init.body));
  calls.push({ url, method, body });
  if (url.includes("/api/ai/assist") && method === "GET") {
    return jsonResponse({
      models: [
        { id: "openai/gpt-4o", name: "GPT-4o" },
        { id: "other/model", name: "Other" },
      ],
    });
  }
  if (url.includes("/api/db/provider-meta")) return jsonResponse({ error: "The catalog is offline." }, 500);
  if (url.includes("/api/ai/assist")) {
    return jsonResponse({
      explanation: "Revenue rose.",
      queries: [
        {
          title: "Revenue",
          sql: "SELECT month, revenue FROM orders LIMIT 200",
          chart: { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month" },
        },
      ],
    });
  }
  if (url.includes("/api/db/query")) {
    return jsonResponse({
      rows: [{ month: "Jan", revenue: 10 }],
      fields: ["month", "revenue"],
      rowCount: 1,
      executionTime: 4,
    });
  }
  return jsonResponse({ error: "missing" }, 404);
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let handler: FetchHandler = defaultFetch;

function saveConnection(active: string | null = "c1") {
  localStorage.setItem(
    "libredb_connections",
    JSON.stringify([
      {
        id: "c1",
        name: "Orders",
        type: "postgres",
        host: "localhost",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
  if (active !== null) localStorage.setItem("libredb_active_connection_id", active);
}

const barResult: QueryResult = {
  rows: [{ month: "Jan", revenue: 10 }],
  fields: ["month", "revenue"],
  rowCount: 1,
  executionTime: 4,
};
const barChart: AssistChart = {
  type: "bar",
  x: "month",
  y: ["revenue"],
  caption: "Revenue by month",
  color: null,
};
const areaChart: AssistChart = {
  type: "bar",
  x: "area",
  y: ["revenue"],
  caption: "",
  color: null,
};

beforeEach(() => {
  calls.length = 0;
  charts.length = 0;
  handler = defaultFetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
  globalThis.ResizeObserver = ImmediateObserver as unknown as typeof ResizeObserver;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function posts() {
  return calls.filter((call) => call.url.includes("/api/ai/assist") && call.method === "POST");
}

function planPosts() {
  return posts().filter((call) => {
    const body = call.body;
    return body === null || typeof body !== "object" || !("results" in body);
  });
}

async function typeAndSend(view: ReturnType<typeof render>, text = "What changed?") {
  fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: text } });
  fireEvent.click(await view.findByRole("button", { name: "Send" }));
}

describe("AssistChartCanvas", () => {
  test("draws the option, lists a note, and resizes", () => {
    const view = render(<AssistChartCanvas option={{ series: [] }} notes={["Showing the first 1 points."]} />);
    expect(charts.at(-1)?.setOption).toHaveBeenCalled();
    expect(charts.at(-1)?.resize).toHaveBeenCalled();
    expect(view.getByText("Showing the first 1 points.")).toBeTruthy();
    view.unmount();
    expect(charts.at(-1)?.dispose).toHaveBeenCalled();
  });

  test("draws again when the option changes and hides an empty note list", () => {
    const view = render(<AssistChartCanvas option={{ series: [1] }} notes={[]} />);
    const chart = charts.at(-1);
    view.rerender(<AssistChartCanvas option={{ series: [2] }} notes={[]} />);
    expect(chart?.setOption.mock.calls.length).toBeGreaterThan(1);
    expect(view.queryByRole("list")).toBeNull();
  });

  test("keeps the same chart when a parent render does not change the option", () => {
    const option = { series: [1] };
    const view = render(<AssistChartCanvas option={option} notes={[]} />);
    const chart = charts.at(-1);
    view.rerender(<AssistChartCanvas option={option} notes={["Showing the first 1 points."]} />);
    expect(charts).toHaveLength(1);
    expect(chart?.dispose).not.toHaveBeenCalled();
    expect(view.getByText("Showing the first 1 points.")).toBeTruthy();
  });
});

describe("ChartWithEditor", () => {
  test("draws a chart in front of the editor and runs a changed query", async () => {
    const ran: string[] = [];
    function Harness() {
      const [sql, setSql] = useState("SELECT month, revenue FROM orders");
      const [result, setResult] = useState<QueryResult | null>(barResult);
      return (
        <ChartWithEditor
          title="Revenue"
          sql={sql}
          databaseType="postgres"
          result={result}
          error={null}
          chart={barChart}
          running={false}
          onSqlChange={setSql}
          onRun={(next) => {
            ran.push(next);
            setResult({ ...barResult, executionTime: 9 });
          }}
        />
      );
    }
    const view = render(<Harness />);
    const toolbar = view.getByRole("button", { name: "Chart" }).parentElement;
    expect([...(toolbar?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("aria-label"))).toEqual(
      ["Chart", "Query", "Code", "Save Chart"],
    );
    expect([...(toolbar?.querySelectorAll("button") ?? [])].every((button) => button.textContent === "")).toBe(true);
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    expect(view.queryByText("Warehouse")).toBeNull();
    expect(view.queryByText("Revenue by month")).toBeNull();
    expect(view.queryByText("1 rows · 4 ms")).toBeNull();
    expect(view.getByTestId("assist-chart")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    const editor = view.getByLabelText("SQL editor");
    fireEvent.change(editor, { target: { value: "SELECT 2" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(ran).toEqual(["SELECT 2"]));
    expect(view.queryByText("1 rows · 9 ms")).toBeNull();
    expect(view.getByRole("button", { name: "Chart" }).getAttribute("aria-pressed")).toBe("true");
    const dimension = within(view.getByRole("group", { name: "Dimension" }));
    const metrics = within(view.getByRole("group", { name: "Metrics" }));
    expect(dimension.getByRole("button", { name: "month" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dimension.getByRole("button", { name: "revenue" }));
    expect(dimension.getByRole("button", { name: "revenue" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(metrics.getByRole("button", { name: "revenue" }));
    expect(view.getByText("Choose the columns this chart needs.")).toBeTruthy();
    fireEvent.click(metrics.getByRole("button", { name: "revenue" }));
    expect(view.getByTestId("assist-chart")).toBeTruthy();
  });

  test("adds and removes a filter from the button beside Dimension", () => {
    const ran: string[] = [];
    const months = Array.from({ length: 25 }, (_, index) => `m${index}`);
    function Harness() {
      const [sql, setSql] = useState("SELECT month, revenue FROM orders");
      return (
        <ChartWithEditor
          title="Revenue"
          sql={sql}
          result={{
            rows: months.map((month, index) => ({
              month,
              revenue: index,
              note: index === 0 ? null : index === 1 ? { bad: true } : false,
              blank: index === 0 ? "  " : "",
              long: "x".repeat(81),
              odd: "a|b",
            })),
            fields: ["month", "revenue", "note", "blank", "long", "odd"],
            rowCount: months.length,
            executionTime: 1,
          }}
          error={null}
          chart={barChart}
          running={false}
          onSqlChange={setSql}
          onRun={(next) => {
            ran.push(next);
            setSql(next);
          }}
        />
      );
    }
    const view = render(<Harness />);
    const filter = within(view.getByRole("group", { name: "Filter" }));
    fireEvent.click(filter.getByRole("button", { name: "month" }));
    expect(ran[0]).toContain("WHERE month = {{month:m0|");
    expect(ran[0]).toContain("m23");
    expect(ran[0]).not.toContain("m24");
    fireEvent.click(filter.getByRole("button", { name: "month" }));
    expect(ran[1]).toBe("SELECT month, revenue FROM orders");
  });

  test("edits a metric filter as a number comparison", () => {
    const onRun = mock(() => {});
    const sql = "SELECT month, revenue FROM orders WHERE revenue > {{revenue:10}}";
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql={sql}
        result={barResult}
        error={null}
        chart={null}
        running={false}
        onSqlChange={() => {}}
        onRun={onRun}
      />,
    );
    const comparison = view.getByRole("combobox", { name: "revenue comparison" }) as HTMLSelectElement;
    expect(comparison.value).toBe("=");
    fireEvent.change(comparison, { target: { value: ">=" } });
    expect(onRun).toHaveBeenCalledWith("SELECT month, revenue FROM orders WHERE revenue >= {{revenue:10}}");
    const input = view.getByRole("spinbutton", { name: "revenue" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    expect(onRun).toHaveBeenLastCalledWith("SELECT month, revenue FROM orders WHERE revenue > {{revenue:3}}");
  });

  test("chart code can turn a filter into a slider and the query still supplies the value", () => {
    const onRun = mock(() => {});
    const sql = "SELECT month, revenue FROM orders WHERE revenue > {{revenue:10}}";
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql={sql}
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={onRun}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const code = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    const parsed = JSON.parse(code.value) as {
      filters: { revenue: { control: string; min?: number; max?: number; step?: number } };
    };
    expect(parsed.filters.revenue.control).toBe("number");
    expect(code.value).not.toContain('"data"');
    parsed.filters.revenue = { control: "slider", min: 0, max: 20, step: 1 };
    fireEvent.change(code, { target: { value: JSON.stringify(parsed) } });
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    const slider = view.getByRole("slider", { name: "revenue" }) as HTMLInputElement;
    expect(slider.max).toBe("20");
    expect(slider.step).toBe("1");
    fireEvent.change(slider, { target: { value: "4" } });
    expect(onRun).toHaveBeenCalledWith("SELECT month, revenue FROM orders WHERE revenue > {{revenue:4}}");
  });

  test("filters a renamed column by its original name and can clear it", () => {
    const ran: string[] = [];
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT region AS area, revenue FROM orders"
        result={{
          rows: [{ area: "east", revenue: 4 }],
          fields: ["area", "revenue"],
          rowCount: 1,
          executionTime: 1,
        }}
        error={null}
        chart={areaChart}
        running={false}
        onSqlChange={() => {}}
        onRun={(sql) => ran.push(sql)}
      />,
    );
    const filter = within(view.getByRole("group", { name: "Filter" }));
    expect(filter.queryByRole("button", { name: "missing" })).toBeNull();
    fireEvent.click(filter.getByRole("button", { name: "area" }));
    expect(ran[0]).toContain("WHERE region = {{region:");
    expect(ran[0]).not.toContain("area =");
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql={ran[0] ?? ""}
        result={{
          rows: [{ area: "east", revenue: 4 }],
          fields: ["area", "revenue"],
          rowCount: 1,
          executionTime: 1,
        }}
        error={null}
        chart={areaChart}
        running={false}
        onSqlChange={() => {}}
        onRun={(sql) => ran.push(sql)}
      />,
    );
    fireEvent.click(within(view.getByRole("group", { name: "Filter" })).getByRole("button", { name: "Clear filters" }));
    expect(ran[1]).not.toContain("{{");
  });

  test("does not offer a filter for a column renamed from an expression", () => {
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT lower(region) AS area, revenue FROM orders"
        result={{
          rows: [{ area: "east", revenue: 4 }],
          fields: ["area", "revenue"],
          rowCount: 1,
          executionTime: 1,
        }}
        error={null}
        chart={areaChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    const filter = within(view.getByRole("group", { name: "Filter" }));
    expect(filter.queryByRole("button", { name: "area" })).toBeNull();
    expect(filter.getByRole("button", { name: "revenue" })).toBeTruthy();
  });

  test("wraps the SQL when a filter query fails so the clause can be removed", () => {
    const changed: string[] = [];
    const ran: string[] = [];
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT region AS area FROM orders WHERE area = {{area:east}}"
        result={null}
        error="column area does not exist"
        chart={null}
        running={false}
        onSqlChange={(sql) => changed.push(sql)}
        onRun={(sql) => ran.push(sql)}
      />,
    );
    expect(view.getByRole("alert").textContent).toBe("column area does not exist");
    const sql = view.getByRole("textbox", { name: "Query SQL" }) as HTMLTextAreaElement;
    expect(sql.getAttribute("wrap")).toBe("soft");
    expect(sql.value).toContain("area = {{area:east}}");
    fireEvent.change(sql, { target: { value: "SELECT region FROM orders" } });
    expect(changed).toEqual(["SELECT region FROM orders"]);
    fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    expect(ran).toEqual(["SELECT region AS area FROM orders"]);
  });

  test("edits the chart code, keeps it when the rows change, and can use the generated chart", () => {
    const edited = { title: { text: "Edited" } };
    function lastOption(): unknown {
      const calls = charts.at(-1)?.setOption.mock.calls ?? [];
      return calls.at(-1)?.[0];
    }
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const code = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(code.getAttribute("data-language")).toBe("json");
    expect(code.getAttribute("data-controlled")).toBe("no");
    expect(code.value).toContain('"series"');
    expect(code.value).not.toContain('"data"');
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
    fireEvent.change(code, { target: { value: "{" } });
    expect(view.getByRole("alert").textContent).toBe("Chart code is not valid JSON.");
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(JSON.stringify(lastOption())).toContain('"series"');
    expect(JSON.stringify(lastOption())).not.toContain("Edited");
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: { value: JSON.stringify(edited) },
    });
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(view.getByText("Showing your chart code.")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Edited" })).toBeTruthy();
    expect(JSON.stringify((lastOption() as { series: { data: unknown }[] }).series)).toContain("10");
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={{ ...barResult, rows: [{ month: "Feb", revenue: 99 }] }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(view.getByText("Showing your chart code.")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Edited" })).toBeTruthy();
    expect(JSON.stringify((lastOption() as { series: { data: unknown }[] }).series)).toContain("99");
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const kept = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(kept.value).toContain("Edited");
    expect(kept.value).not.toContain("99");
    expect(kept.value).not.toContain('"data"');
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={{ ...barResult, rows: [{ month: "Mar", revenue: 7 }] }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(JSON.stringify((lastOption() as { series: { data: unknown }[] }).series)).toContain("7");
    fireEvent.click(view.getByRole("button", { name: "Use generated chart" }));
    expect(view.queryByText("Showing your chart code.")).toBeNull();
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const restored = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(restored.value).not.toContain("99");
    expect(restored.value).not.toContain('"data"');
    expect(restored.value).not.toContain("Edited");
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
    fireEvent.change(restored, { target: { value: "[]" } });
    expect(view.getByRole("alert").textContent).toBe("Chart code must be a JSON object.");
    fireEvent.change(restored, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect((lastOption() as { title: { text: string } }).title.text).toBe("Edited");
    expect(JSON.stringify((lastOption() as { series: { data: unknown }[] }).series)).toContain("7");
    fireEvent.click(within(view.getByRole("group", { name: "Metrics" })).getByRole("button", { name: "revenue" }));
    expect(view.queryByText("Showing your chart code.")).toBeNull();
    fireEvent.click(within(view.getByRole("group", { name: "Metrics" })).getByRole("button", { name: "revenue" }));
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    expect((view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement).value).not.toContain("Edited");
  });

  test("an empty chart-code title keeps the card title", () => {
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: { value: JSON.stringify({ title: { text: "" } }) },
    });
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
  });

  test("title textStyle changes the heading, and a rerun drops values out of the code", () => {
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={{ ...barResult, executionTime: 8 }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), { target: { value: "{" } });
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={{ ...barResult, rows: [{ month: "Feb", revenue: 99 }] }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    expect(view.getByRole("alert").textContent).toBe("Chart code is not valid JSON.");
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: {
        value: JSON.stringify({
          title: {
            text: "Edited",
            textStyle: {
              fontSize: 32,
              fontWeight: "bold",
              color: "#112233",
              fontFamily: "Georgia",
              fontStyle: "italic",
            },
          },
          series: [{ data: [1] }],
        }),
      },
    });
    const heading = view.getByRole("heading", { name: "Edited" });
    expect(heading.style.fontSize).toBe("32px");
    expect(heading.style.fontWeight).toBe("bold");
    expect(heading.style.fontFamily).toContain("Georgia");
    expect(heading.style.fontStyle).toBe("italic");
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={{ ...barResult, rows: [{ month: "Feb", revenue: 99 }] }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const cleaned = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(cleaned.value).toContain("Edited");
    expect(cleaned.value).toContain("32");
    expect(cleaned.value).not.toContain('"data"');
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(view.getByRole("heading", { name: "Edited" }).style.fontSize).toBe("32px");
    const drawn = charts.at(-1);
    if (drawn === undefined) throw new Error("expected a chart");
    const plotted = drawn.setOption.mock.calls.at(-1)?.[0] as { series?: unknown } | undefined;
    expect(JSON.stringify(plotted?.series)).toContain("99");
  });

  test("listens for the editor's run event only while the query is showing", () => {
    const ran: string[] = [];
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT 1"
        result={null}
        error={null}
        chart={null}
        running={false}
        onSqlChange={() => {}}
        onRun={(sql) => ran.push(sql)}
      />,
    );
    expect(
      view.getByText("The SQL editor is behind this chart. Open Query to edit it, or Code to edit the chart."),
    ).toBeTruthy();
    window.dispatchEvent(new CustomEvent("execute-query", { detail: { query: "SELECT 9" } }));
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    window.dispatchEvent(new CustomEvent("execute-query", { detail: { query: "" } }));
    window.dispatchEvent(new CustomEvent("execute-query", { detail: { query: 4 } }));
    window.dispatchEvent(new CustomEvent("execute-query", { detail: { query: "SELECT 9" } }));
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    window.dispatchEvent(new CustomEvent("execute-query", { detail: { query: "SELECT 8" } }));
    expect(ran).toEqual(["SELECT 9"]);
    view.unmount();
  });

  test("shows an error, an empty result, a running query, and a table", () => {
    const errorView = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT 1"
        result={barResult}
        error="denied"
        chart={{ type: "bar", x: "missing", y: ["nope"], caption: "", color: null }}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(errorView.getByRole("alert").textContent).toBe("denied");
    expect(errorView.getAllByText("month").length).toBeGreaterThan(0);
    errorView.unmount();

    const emptyView = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT 1"
        result={{ rows: [], fields: ["n"], rowCount: 0, executionTime: 1 }}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(emptyView.getByText("The query returned no rows.")).toBeTruthy();
    emptyView.unmount();

    const running = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT 1"
        result={null}
        error={null}
        chart={null}
        running
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(running.getByText("Running the query…")).toBeTruthy();
    fireEvent.click(running.getByRole("button", { name: "Query" }));
    expect(running.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    running.unmount();

    const circular: { self?: unknown } = {};
    circular.self = circular;
    const rows = Array.from({ length: 9 }, (_, index) => ({
      a: index === 0 ? null : "x",
      b: index,
      c: index === 0,
      d: index === 0 ? { z: 1 } : BigInt(1),
      e: index === 0 ? circular : "z",
      f: "f",
      g: "g",
    }));
    const table = render(
      <ChartWithEditor
        title="Rows"
        sql="SELECT 1"
        result={{ rows, fields: ["a", "b", "c", "d", "e", "f", "g"], rowCount: 9, executionTime: 2 }}
        error={null}
        chart={null}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(table.getByText("true")).toBeTruthy();
    expect(table.getByText('{"z":1}')).toBeTruthy();
    expect(table.getByText("1 more rows")).toBeTruthy();
    expect(table.getByText("1 more columns")).toBeTruthy();
    expect(table.queryByRole("button", { name: "Chart" })).toBeNull();
    expect(table.queryByRole("button", { name: "Query" })).toBeNull();
    expect(table.queryByRole("button", { name: "Code" })).toBeNull();
  });

  test("switches to another chart type and can chart a plain result", () => {
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Change type, Line, Basic" }));
    const types = within(view.getByRole("group", { name: "Chart types" }));
    expect(types.getByRole("button", { name: "Line" }).getAttribute("aria-pressed")).toBe("true");
    const variations = within(view.getByRole("group", { name: "Chart variations" }));
    expect(variations.getByRole("button", { name: "Basic" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(variations.getByRole("button", { name: "Area" }));
    expect(view.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(view.getByTestId("assist-chart")).toBeTruthy();
    fireEvent.click(variations.getByRole("button", { name: "Area" }));
    fireEvent.click(types.getByRole("button", { name: "Candlestick" }));
    fireEvent.click(
      within(view.getByRole("group", { name: "Chart variations" })).getByRole("button", { name: "Basic" }),
    );
    expect(view.getByText("Choose the columns this chart needs.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Change type, Candlestick, Basic" }));
    expect(view.queryByRole("group", { name: "Chart types" })).toBeNull();
    view.unmount();

    const table = render(
      <ChartWithEditor
        title="Rows"
        sql="SELECT 1"
        result={barResult}
        error={null}
        chart={null}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    fireEvent.click(table.getByRole("button", { name: "Choose a type" }));
    fireEvent.click(within(table.getByRole("group", { name: "Chart types" })).getByRole("button", { name: "Gauge" }));
    fireEvent.click(
      within(table.getByRole("group", { name: "Chart variations" })).getByRole("button", { name: "Basic" }),
    );
    expect(table.getByTestId("assist-chart")).toBeTruthy();
    expect(table.getByRole("button", { name: "Change type, Gauge, Basic" })).toBeTruthy();
  });

  test("edits a filter from the chart and leaves a placeholder inside a string alone", () => {
    const onRun = mock(() => {});
    const sql =
      "SELECT '{{region:east}}' AS label, revenue FROM orders WHERE region = {{region:north|east,west}} AND min_total = {{min:1}}";
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql={sql}
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        onSqlChange={() => {}}
        onRun={onRun}
      />,
    );
    const region = view.getByRole("combobox", { name: "region" }) as HTMLSelectElement;
    expect(within(region).getByRole("option", { name: "north" })).toBeTruthy();
    fireEvent.change(region, { target: { value: "west" } });
    expect(onRun).toHaveBeenCalledWith(sql.replace("{{region:north|east,west}}", "{{region:west|east,west}}"));
    const minimum = view.getByRole("textbox", { name: "min" });
    fireEvent.keyDown(minimum, { key: "a" });
    fireEvent.blur(minimum);
    expect(onRun).toHaveBeenCalledTimes(1);
    fireEvent.change(minimum, { target: { value: "5" } });
    fireEvent.keyDown(minimum, { key: "Enter" });
    expect(onRun).toHaveBeenLastCalledWith(expect.stringContaining("{{min:5}}"));
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql={sql.replace("{{min:1}}", "{{min:5}}")}
        result={barResult}
        error={null}
        chart={barChart}
        running
        onSqlChange={() => {}}
        onRun={onRun}
      />,
    );
    const updated = view.getByRole("textbox", { name: "min" }) as HTMLInputElement;
    expect(updated.value).toBe("5");
    expect(updated.hasAttribute("disabled")).toBe(true);
    fireEvent.change(updated, { target: { value: "9" } });
    fireEvent.keyDown(updated, { key: "Enter" });
    const runningSql = sql.replace("{{min:1}}", "{{min:5}}");
    expect(onRun).toHaveBeenLastCalledWith(runningSql.replace("{{min:5}}", "{{min:9}}"));
    view.rerender(
      <ChartWithEditor
        title="Revenue"
        sql={runningSql.replace("{{min:5}}", "{{min:9}}")}
        result={barResult}
        error={null}
        chart={barChart}
        running
        onSqlChange={() => {}}
        onRun={onRun}
      />,
    );
    expect((view.getByRole("textbox", { name: "min" }) as HTMLInputElement).value).toBe("9");
  });

  test("keeps the chosen type when a new query only clears the caption", () => {
    const props = {
      title: "Revenue",
      sql: "SELECT month, revenue FROM orders",
      result: barResult,
      error: null,
      chart: barChart,
      running: false,
      onSqlChange: () => {},
      onRun: () => {},
    };
    const view = render(<ChartWithEditor {...props} />);
    fireEvent.click(view.getByRole("button", { name: "Change type, Line, Basic" }));
    fireEvent.click(within(view.getByRole("group", { name: "Chart types" })).getByRole("button", { name: "Line" }));
    fireEvent.click(
      within(view.getByRole("group", { name: "Chart variations" })).getByRole("button", {
        name: (accessibleName) => accessibleName === "Area",
      }),
    );
    view.rerender(
      <ChartWithEditor
        {...props}
        title="cost by region"
        chart={{ ...barChart, caption: "" }}
        result={{ ...barResult, executionTime: 5 }}
      />,
    );
    expect(view.getByRole("heading", { name: "cost by region" })).toBeTruthy();
    expect(view.queryByText("Revenue by month")).toBeNull();
    expect(view.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    view.rerender(
      <ChartWithEditor
        {...props}
        chart={{ type: "line", x: "month", y: ["revenue"], caption: "trend", color: null }}
      />,
    );
    expect(view.getByRole("button", { name: "Change type, Line, Basic" })).toBeTruthy();
    view.rerender(<ChartWithEditor {...props} chart={null} />);
    expect(view.getByRole("button", { name: "Choose a type" })).toBeTruthy();
  });

  test("restores the chosen type and chart code after the chart unmounts", async () => {
    const props = {
      title: "Revenue",
      sql: "SELECT month, revenue FROM orders",
      result: barResult,
      error: null,
      chart: barChart,
      running: false,
      onSqlChange: () => {},
      onRun: () => {},
    };
    let memory: { view: AssistChartChoice | null; code: string | null } = { view: null, code: null };
    const onRemember = (view: AssistChartChoice | null, code: string | null) => {
      memory = { view, code };
    };
    const view = render(<ChartWithEditor {...props} onRemember={onRemember} />);
    fireEvent.click(view.getByRole("button", { name: "Change type, Line, Basic" }));
    fireEvent.click(within(view.getByRole("group", { name: "Chart types" })).getByRole("button", { name: "Line" }));
    fireEvent.click(
      within(view.getByRole("group", { name: "Chart variations" })).getByRole("button", {
        name: (accessibleName) => accessibleName === "Area",
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: { value: JSON.stringify({ title: { text: "Edited" } }) },
    });
    await waitFor(() => expect(memory.code).toContain("Edited"));
    expect(memory.view).toEqual({ typeId: "line", variationId: "area", selection: expect.any(Object) });
    view.unmount();

    const again = render(
      <ChartWithEditor {...props} savedView={memory.view} savedCode={memory.code} onRemember={onRemember} />,
    );
    expect(again.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(again.getByText("Showing your chart code.")).toBeTruthy();
    expect(again.getByRole("heading", { name: "Edited" })).toBeTruthy();
    fireEvent.click(again.getByRole("button", { name: "Code" }));
    expect((again.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement).value).toContain("Edited");
    fireEvent.click(again.getByRole("button", { name: "Use generated chart" }));
    await waitFor(() => expect(memory.code).toBeNull());
    expect(again.queryByText("Showing your chart code.")).toBeNull();
    again.unmount();

    const restored = render(
      <ChartWithEditor {...props} savedView={memory.view} savedCode={memory.code} onRemember={onRemember} />,
    );
    expect(restored.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(restored.queryByText("Showing your chart code.")).toBeNull();
    fireEvent.click(restored.getByRole("button", { name: "Code" }));
    expect((restored.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement).value).not.toContain(
      "Edited",
    );
  });

  test("does not apply saved chart code when the saved type no longer fits the rows", () => {
    const view = render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT month, revenue FROM orders"
        result={barResult}
        error={null}
        chart={barChart}
        running={false}
        savedView={{ typeId: "candlestick", variationId: "basic", selection: {} }}
        savedCode={JSON.stringify({ title: { text: "Edited" } })}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(view.getByRole("button", { name: "Change type, Line, Basic" })).toBeTruthy();
    expect(view.queryByText("Showing your chart code.")).toBeNull();
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
  });

  test("paints a chart in the colour it was given", () => {
    render(
      <ChartWithEditor
        title="Revenue"
        sql="SELECT 1"
        result={barResult}
        error={null}
        chart={barChart}
        color="#9546de"
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    const option = charts.at(-1)?.setOption.mock.calls.at(-1)?.[0] as { color?: string[] };
    expect(option.color?.[0]).toBe("#9546de");
  });
});

describe("AiAssist page", () => {
  test("formats an assistant answer written as markdown and leaves the question plain", async () => {
    const at = new Date().toISOString();
    localStorage.setItem(
      ASSIST_TRANSCRIPT_KEY,
      JSON.stringify([
        { id: "assist-1", role: "user", text: "Show **this**", at, cards: [] },
        {
          id: "assist-2",
          role: "assistant",
          text: 'Revenue is **120**.\n\n- East led on `orders`\n- West was flat\n\n<img src=x onerror="steal()">',
          at,
          cards: [],
        },
      ]),
    );
    const view = render(<AiAssist />);
    const thread = view.getByRole("region", { name: "Conversation" });
    expect(await view.findByText("Show **this**")).toBeTruthy();
    expect(thread.querySelector("strong")?.textContent).toBe("120");
    expect(thread.querySelector("code")?.textContent).toBe("orders");
    expect(thread.querySelectorAll("li").length).toBe(2);
    expect(thread.querySelector("img")).toBeNull();
    expect(thread.textContent).toContain('<img src=x onerror="steal()">');
    expect(thread.textContent).not.toContain("**120**");
  });

  test("opens the conversation at the latest message", async () => {
    const element = HTMLElement.prototype;
    const scrollHeight = Object.getOwnPropertyDescriptor(element, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(element, "clientHeight");
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => 900 });
    Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 200 });
    try {
      const at = new Date().toISOString();
      localStorage.setItem(
        ASSIST_TRANSCRIPT_KEY,
        JSON.stringify([
          { id: "assist-1", role: "user", text: "Earlier question", at, cards: [] },
          { id: "assist-2", role: "assistant", text: "The latest answer", at, cards: [] },
        ]),
      );
      saveConnection();
      const view = render(<AiAssist />);
      const thread = view.getByRole("region", { name: "Conversation" });
      const charts = view.getByRole("main");
      expect(await view.findByText("The latest answer")).toBeTruthy();
      expect(thread.scrollTop).toBe(700);
      expect(charts.scrollTop).toBe(700);
      thread.scrollTop = 0;
      charts.scrollTop = 0;
      await typeAndSend(view, "What changed?");
      expect(await view.findByText("Revenue rose.")).toBeTruthy();
      expect(thread.scrollTop).toBe(700);
      expect(charts.scrollTop).toBe(700);
    } finally {
      if (scrollHeight === undefined) delete (element as { scrollHeight?: unknown }).scrollHeight;
      else Object.defineProperty(element, "scrollHeight", scrollHeight);
      if (clientHeight === undefined) delete (element as { clientHeight?: unknown }).clientHeight;
      else Object.defineProperty(element, "clientHeight", clientHeight);
    }
  });

  test("clears the conversation and reads the catalog again", async () => {
    const at = new Date().toISOString();
    localStorage.setItem(
      ASSIST_TRANSCRIPT_KEY,
      JSON.stringify([{ id: "assist-1", role: "user", text: "Earlier question", at, cards: [] }]),
    );
    saveConnection();
    const view = render(<AiAssist />);
    expect(await view.findByText("Earlier question")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    expect(view.getByText("Earlier question")).toBeTruthy();
    expect(view.getByRole("button", { name: "Clear chat" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    expect(view.queryByRole("button", { name: "Confirm clear chat" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Clear chat" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm clear chat" }));
    expect(view.queryByText("Earlier question")).toBeNull();
    expect(view.getByRole("heading", { name: "How can I help?" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "null")).toEqual([]);
    await waitFor(() => expect(calls.filter((call) => call.url.includes("provider-meta")).length).toBeGreaterThan(1));
    await typeAndSend(view, "What is in the new tables?");
    const history = (planPosts()[0]?.body as { history?: unknown[] } | undefined)?.history;
    expect(history).toEqual([]);
  });

  test("asks how it can help and points back at the editor", async () => {
    const view = render(<AssistPage />);
    expect(await view.findByRole("heading", { name: "How can I help?" })).toBeTruthy();
    expect(view.queryByRole("navigation", { name: "Editor mode" })).toBeNull();
    const ide = view.getByRole("link", { name: "IDE" });
    expect(ide.getAttribute("href")).toBe("/");
    expect(ide.className.includes("border")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "New query" }));
    expect(document.activeElement).toBe(view.getByLabelText("How can I help?"));
    expect(view.getByRole("link", { name: "Dash" }).getAttribute("href")).toBe("/create");
    expect(view.queryByRole("link", { name: "AI" })).toBeNull();
    expect(view.getByText(/Add a database in Traditional mode/)).toBeTruthy();
    expect(await view.findByText(/This server has no OpenRouter key/)).toBeTruthy();
  });

  test("uses the active connection, or the only one, and retries a catalog read", async () => {
    saveConnection("missing");
    const view = render(<AiAssist />);
    expect(await view.findByText(/catalog is offline/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("provider-meta")).length).toBeGreaterThan(1));
  });

  test("sends only the chosen number of earlier messages", async () => {
    saveConnection();
    const view = render(<AiAssist />);
    fireEvent.click(view.getByRole("button", { name: "Earlier messages, 5" }));
    const count = view.getByLabelText("Number of earlier messages") as HTMLSelectElement;
    expect([...count.options].map((option) => option.value)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    fireEvent.change(count, { target: { value: "1" } });
    expect(readAssistSettings().historyMessages).toBe(1);
    await typeAndSend(view, "First");
    expect(await view.findByText("Revenue rose.")).toBeTruthy();
    await typeAndSend(view, "Second");
    await waitFor(() => expect(view.getAllByText("Revenue rose.")).toHaveLength(2));
    await typeAndSend(view, "Third");
    await waitFor(() => expect(planPosts()).toHaveLength(3));
    const history = (planPosts()[2]?.body as { history?: { question: string }[] } | undefined)?.history;
    expect(history?.map((turn) => turn.question)).toEqual(["Second"]);
  });

  test("saves an OpenRouter model that is not in the catalog and a Fireworks account", async () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({
        source: "openrouter",
        openRouterModel: "missing/model",
        fireworksModel: "",
        openRouterKey: "",
        fireworksKey: "",
      }),
    );
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect(view.queryByRole("radio", { name: "OpenRouter" })).toBeNull();
    expect(view.queryByRole("radio", { name: "Fireworks AI" })).toBeNull();
    expect(view.queryByRole("radio", { name: "Vercel AI Gateway" })).toBeNull();
    expect(view.queryByLabelText("OpenRouter API key")).toBeNull();
    expect(view.getByRole("option", { name: "missing/model" })).toBeTruthy();
    fireEvent.change(view.getByLabelText("OpenRouter model"), { target: { value: "other/model" } });
    writeAssistSettings({ ...readAssistSettings(), source: "fireworks" });
    fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: "What changed?" } });
    fireEvent.keyDown(view.getByLabelText("How can I help?"), { key: "Enter" });
    expect(await view.findByRole("alert")).toHaveProperty("textContent", "Name the model to use.");
    fireEvent.change(view.getByLabelText("Fireworks model"), { target: { value: "accounts/acme/models/tuned" } });
    expect(JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}").fireworksModel).toBe(
      "accounts/acme/models/tuned",
    );
    view.unmount();
    expect(readStored().source).toBe("fireworks");
  });

  test("asks Vercel AI Gateway with the key saved under Connectors", async () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({
        source: "openrouter",
        openRouterModel: "openai/gpt-4o",
        openRouterKey: "ork-secret",
        fireworksModel: "",
        fireworksKey: "fw-secret",
        gatewayModel: "",
        gatewayKey: "gw-secret",
      }),
    );
    handler = (url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/ai/assist") && method === "GET") {
        return jsonResponse({
          models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
          gatewayModels: [{ id: "alibaba/qwen-3-14b", name: "Qwen3-14B" }],
          gatewayCatalog: true,
          serverKey: false,
        });
      }
      if (url.includes("/api/ai/assist") && method === "POST") {
        calls.push({ url, method, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ explanation: "Routed.", queries: [] });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect(view.queryByLabelText("OpenRouter API key")).toBeNull();
    expect(view.queryByText("API key saved")).toBeNull();
    expect(view.container.textContent?.includes("ork-secret")).toBe(false);

    act(() => {
      writeAssistSettings({ ...readAssistSettings(), source: "gateway" });
    });
    expect(view.queryByLabelText("Vercel AI Gateway API key")).toBeNull();
    expect(view.container.textContent?.includes("gw-secret")).toBe(false);
    const listed = document.querySelector("#vercel-gateway-models option");
    expect(listed?.getAttribute("value")).toBe("alibaba/qwen-3-14b");
    expect(listed?.textContent).toBe("Qwen3-14B");
    fireEvent.change(view.getByLabelText("Vercel AI Gateway model"), { target: { value: "alibaba/qwen-3-14b" } });
    await typeAndSend(view, "What changed?");
    expect(await view.findByText("Routed.")).toBeTruthy();

    act(() => {
      writeAssistSettings({ ...readAssistSettings(), source: "fireworks" });
    });
    fireEvent.change(view.getByLabelText("Fireworks model"), { target: { value: "accounts/acme/models/tuned" } });
    expect(view.queryByLabelText("Fireworks API key")).toBeNull();
    expect(view.container.textContent?.includes("fw-secret")).toBe(false);
    await typeAndSend(view, "And cost?");
    expect(await view.findByText("Routed.")).toBeTruthy();

    const sent = posts().map((call) => call.body);
    expect(sent[0]).toMatchObject({
      source: "gateway",
      model: "alibaba/qwen-3-14b",
      apiKey: "gw-secret",
    });
    expect(sent[1]).toMatchObject({
      source: "fireworks",
      model: "accounts/acme/models/tuned",
      apiKey: "fw-secret",
    });
    expect(JSON.stringify(sent)).not.toContain("ork-secret");
  });

  test("says when the Vercel AI Gateway catalog cannot be loaded", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
          gatewayModels: [],
          gatewayCatalog: false,
        });
      }
      return defaultFetch(url, init);
    };
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({ ...readAssistSettings(), source: "gateway", gatewayModel: "alibaba/qwen-3-14b" }),
    );
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect(await view.findByText("The Vercel AI Gateway catalog could not be loaded.")).toBeTruthy();
    expect(view.getByLabelText("Vercel AI Gateway model")).toBeTruthy();
  });

  test("writes a query, draws the chart, and reveals the editor behind it", async () => {
    saveConnection();
    const view = render(<AiAssist />);
    await typeAndSend(view);
    expect(await view.findByText("Revenue rose.")).toBeTruthy();
    expect(await view.findByRole("heading", { name: "Revenue" })).toBeTruthy();
    expect(view.queryByText("Revenue by month")).toBeNull();
    expect(view.queryByText("1 rows · 4 ms")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    expect(view.getByLabelText("SQL editor")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    const queriesBeforeRerun = calls.filter((call) => call.url.includes("/api/db/query")).length;
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes("/api/db/query")).length).toBeGreaterThan(queriesBeforeRerun),
    );
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    expect(view.queryByText("Revenue by month")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("SQL editor"), { target: { value: "DELETE FROM orders" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    expect(await view.findByText("AI Assist only runs read-only queries.")).toBeTruthy();
    expect(view.getByRole("heading", { name: "DELETE FROM orders" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("SQL editor"), { target: { value: "SELECT region, cost FROM sales" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes("/api/db/query") &&
            (call.body as { sql?: string } | null)?.sql === "SELECT region, cost FROM sales",
        ),
      ).toBe(true),
    );
    expect(view.getByRole("heading", { name: "cost by region" })).toBeTruthy();
    expect(view.queryByText("Revenue by month")).toBeNull();
  });

  test("runs a chart filter as a literal and keeps the title when the control changes", async () => {
    saveConnection();
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          explanation: "Revenue by region.",
          queries: [
            {
              title: "Revenue",
              sql: "SELECT month, revenue FROM orders WHERE region = {{region:east|east,west}} AND total >= {{min:1}} LIMIT 200",
              chart: { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month", color: null },
            },
          ],
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view, "Revenue for a region");
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes("/api/db/query") &&
            (call.body as { sql?: string } | null)?.sql ===
              "SELECT month, revenue FROM orders WHERE region = 'east' AND total >= 1 LIMIT 200",
        ),
      ).toBe(true),
    );
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    fireEvent.change(view.getByRole("combobox", { name: "region" }), { target: { value: "west" } });
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            (call.body as { sql?: string } | null)?.sql ===
            "SELECT month, revenue FROM orders WHERE region = 'west' AND total >= 1 LIMIT 200",
        ),
      ).toBe(true),
    );
    expect(view.getByRole("heading", { name: "Revenue" })).toBeTruthy();
    const callsBeforeMin = calls.length;
    const minimum = view.getByRole("textbox", { name: "min" });
    fireEvent.keyDown(minimum, { key: "a" });
    fireEvent.blur(minimum);
    fireEvent.change(minimum, { target: { value: "5" } });
    fireEvent.keyDown(minimum, { key: "Enter" });
    await waitFor(() => expect(calls.length).toBeGreaterThan(callsBeforeMin));
    expect(
      calls.some(
        (call) =>
          (call.body as { sql?: string } | null)?.sql ===
          "SELECT month, revenue FROM orders WHERE region = 'west' AND total >= 5 LIMIT 200",
      ),
    ).toBe(true);
  });

  test("refuses a write the model returned and still shows the editor with no database", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          explanation: "That would delete rows.",
          queries: [{ title: "Wipe", sql: "DELETE FROM orders", chart: null }],
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await view.findByText(/Add a database in Traditional mode/);
    await typeAndSend(view, "Delete everything");
    expect(await view.findByText("That would delete rows.")).toBeTruthy();
    expect(view.queryByText("Wipe")).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/db/query"))).toBe(false);

    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        return jsonResponse({
          explanation: "Here is a count.",
          queries: [{ title: "Count", sql: "SELECT 1", chart: null }],
        });
      }
      return defaultFetch(url, init);
    };
    await typeAndSend(view, "How many?");
    expect(await view.findByText("Connect a database in Traditional mode to run this query.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(view.getByText("Connect a database in Traditional mode to run this query.")).toBeTruthy();
  });

  test("shows the route's error, a fallback, and a network failure", async () => {
    const answers = [
      jsonResponse({ error: "Add an API key for this model." }, 400),
      jsonResponse({ error: "  " }, 500),
      jsonResponse({ error: 1 }, 500),
      new Response("nope", { status: 400 }),
    ];
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: null });
        return answers.shift() ?? jsonResponse({ error: "later" }, 500);
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view, "One");
    expect(await view.findByText("Add an API key for this model.")).toBeTruthy();
    await typeAndSend(view, "Two");
    expect((await view.findAllByText("The assistant could not answer.")).length).toBeGreaterThan(0);
    await typeAndSend(view, "Three");
    await typeAndSend(view, "Four");
    await waitFor(() => expect(view.getAllByText("The assistant could not answer.").length).toBe(3));

    handler = () => {
      throw new Error("offline");
    };
    await typeAndSend(view, "Five");
    expect(await view.findByText("The assistant could not be reached.")).toBeTruthy();
  });

  test("sends one request while another is in flight and ignores a blank or shifted enter", async () => {
    let release: ((response: Response) => void) | undefined;
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    const box = view.getByLabelText("How can I help?");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "What changed?" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await view.findByText("Sending…")).toBeTruthy();
    expect(posts()).toHaveLength(1);
    release?.(jsonResponse({ explanation: "Done.", queries: [] }));
    expect(await view.findByText("Done.")).toBeTruthy();
  });

  test("sends the earlier turn the next time", async () => {
    saveConnection();
    const view = render(<AiAssist />);
    await typeAndSend(view, "First");
    await view.findByText("Revenue rose.");
    await typeAndSend(view, "Second");
    await waitFor(() => expect(planPosts()).toHaveLength(2));
    const history = (planPosts()[1]?.body as { history?: { question: string; explanation: string }[] } | undefined)
      ?.history;
    expect(history?.[0]?.question).toBe("First");
    expect(history?.[0]?.explanation).toContain("Revenue rose.");
    expect(history?.[0]?.explanation).toContain("10");
  });

  test("keeps the chart type and code when the page is opened again", async () => {
    saveConnection();
    const view = render(<AiAssist />);
    await typeAndSend(view);
    expect(await view.findByRole("heading", { name: "Revenue" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Change type, Line, Basic" }));
    fireEvent.click(
      within(view.getByRole("group", { name: "Chart variations" })).getByRole("button", {
        name: (accessibleName) => accessibleName === "Area",
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: { value: JSON.stringify({ title: { text: "Edited" } }) },
    });
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "[]") as {
        cards?: { view?: { variationId?: string } | null; code?: string | null }[];
      }[];
      const card = saved.flatMap((turn) => turn.cards ?? []).find((item) => item.code?.includes("Edited"));
      expect(card?.view?.variationId).toBe("area");
    });
    view.unmount();
    const again = render(<AiAssist />);
    expect(await again.findByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(again.getByRole("heading", { name: "Edited" })).toBeTruthy();
    fireEvent.click(again.getByRole("button", { name: "Code" }));
    expect((again.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement).value).toContain("Edited");
  });

  test("keeps a chart the user edited and adds a new one on the next question", async () => {
    saveConnection();
    let assistPosts = 0;
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, method: "POST", body });
        if (body !== null && typeof body === "object" && "results" in body) {
          const posted = body as { pass?: string; question?: string };
          if (posted.pass === "final" && posted.question === "What about cost?") {
            return jsonResponse({ explanation: "Cost is separate.", queries: [] });
          }
          return jsonResponse({ explanation: "Revenue rose.", queries: [] });
        }
        assistPosts += 1;
        if (assistPosts === 1) {
          return jsonResponse({
            explanation: "Revenue rose.",
            queries: [
              {
                title: "Revenue",
                sql: "SELECT month, revenue FROM orders LIMIT 200",
                chart: { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month" },
              },
            ],
          });
        }
        return jsonResponse({
          explanation: "Cost is separate.",
          queries: [
            {
              title: "Revenue again",
              sql: "SELECT region, cost FROM sales",
              chart: { type: "line", x: "region", y: ["cost"], caption: "replaced" },
            },
            { title: "Spend", connection: "Orders", sql: "SELECT region, sum(cost) AS spend FROM sales", chart: null },
          ],
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view);
    expect(await view.findByRole("heading", { name: "Revenue" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("SQL editor"), { target: { value: "SELECT region, cost FROM sales" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes("/api/db/query") &&
            (call.body as { sql?: string } | null)?.sql === "SELECT region, cost FROM sales",
        ),
      ).toBe(true),
    );
    expect(view.getByRole("heading", { name: "cost by region" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Change type, Line, Basic" }));
    fireEvent.click(within(view.getByRole("group", { name: "Chart types" })).getByRole("button", { name: "Line" }));
    fireEvent.click(
      within(view.getByRole("group", { name: "Chart variations" })).getByRole("button", {
        name: (accessibleName) => accessibleName === "Area",
      }),
    );
    expect(view.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(await view.findByText("Revenue rose.")).toBeTruthy();

    await typeAndSend(view, "What about cost?");
    expect(await view.findByText("Cost is separate.")).toBeTruthy();
    expect(await view.findByRole("heading", { name: "Spend" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Revenue again" })).toBeNull();
    expect(view.getByRole("heading", { name: "cost by region" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Change type, Line, Area" })).toBeTruthy();
    expect(view.queryByText("replaced")).toBeNull();
    expect((view.getAllByLabelText("SQL editor")[0] as HTMLTextAreaElement).value).toBe(
      "SELECT region, cost FROM sales",
    );
    const history = (planPosts()[1]?.body as { history?: { question: string; explanation: string }[] } | undefined)
      ?.history;
    expect(history?.[0]?.question).toBe("What changed?");
    expect(history?.[0]?.explanation).toContain(
      "User-edited query (leave it unchanged): SELECT region, cost FROM sales",
    );
  });

  test("reports a query failure and an empty answer", async () => {
    saveConnection();
    handler = (url, init) => {
      if (url.includes("/api/db/query")) {
        calls.push({ url, method: "POST", body: null });
        return jsonResponse({ error: "denied" }, 400);
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view);
    expect(await view.findByText("denied")).toBeTruthy();
    view.unmount();
    localStorage.removeItem(ASSIST_TRANSCRIPT_KEY);

    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") return jsonResponse(null);
      return defaultFetch(url, init);
    };
    const empty = render(<AiAssist />);
    await typeAndSend(empty);
    expect(await empty.findByText("What changed?")).toBeTruthy();
    expect(empty.queryByText("Revenue rose.")).toBeNull();
  });

  test("says when the server already has an OpenRouter key", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ models: [], serverKey: true });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    expect(await view.findByText("Using the server OpenRouter key.")).toBeTruthy();
    expect(view.queryByText(/This server has no OpenRouter key/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Model" }));
    expect(view.queryByRole("radio", { name: "OpenRouter" })).toBeNull();
    expect(view.getByLabelText("OpenRouter model")).toBeTruthy();
  });

  test("says when the model list cannot be loaded", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") return jsonResponse({}, 503);
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect(await view.findByText("The OpenRouter catalog could not be loaded.")).toBeTruthy();
    act(() => {
      writeAssistSettings({ ...readAssistSettings(), source: "gateway" });
    });
    expect(view.getByText("The Vercel AI Gateway catalog could not be loaded.")).toBeTruthy();
    view.unmount();

    let release: ((response: Response) => void) | undefined;
    handler = (url) => {
      if (url.includes("/api/ai/assist")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return defaultFetch(url);
    };
    const hanging = render(<AiAssist />);
    hanging.unmount();
    release?.(jsonResponse({}));
    await Promise.resolve();
  });

  test("ignores a catalog that arrives after the page is gone", async () => {
    let releaseJson: (() => void) | undefined;
    handler = (url) => {
      if (!url.includes("/api/ai/assist")) return defaultFetch(url);
      const response = jsonResponse({ models: [] });
      response.json = () =>
        new Promise((resolve) => {
          releaseJson = () => resolve({ models: [] });
        });
      return response;
    };
    const view = render(<AiAssist />);
    await waitFor(() => expect(releaseJson).toBeTypeOf("function"));
    view.unmount();
    releaseJson?.();
    await Promise.resolve();
  });

  test("runs each query on the connected database it names", async () => {
    localStorage.setItem(
      "libredb_connections",
      JSON.stringify([
        { id: "c1", name: "Orders", type: "postgres", host: "localhost", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "c2", name: "Logs", type: "mysql", host: "localhost", createdAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    let unnamed = false;
    handler = (url, init) => {
      const method = init?.method ?? "GET";
      let body: unknown = null;
      if (init?.body !== undefined) body = JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (url.includes("/api/db/provider-meta")) {
        const posted = body as { connection?: { id?: string } } | null;
        if (posted?.connection?.id === "c2") throw new Error("boom");
        return jsonResponse({ error: "The catalog is offline." }, 500);
      }
      if (url.includes("/api/ai/assist") && method === "POST") {
        return jsonResponse(
          unnamed
            ? { explanation: "Which database?", queries: [{ title: "Count", sql: "SELECT 4", chart: null }] }
            : {
                explanation: "Both databases.",
                queries: [
                  { title: "Revenue", connection: "Orders", sql: "SELECT 1", chart: null },
                  { title: "Events", connection: "c2", sql: "SELECT 2", chart: null },
                  { title: "Missing", connection: "Nope", sql: "SELECT 3", chart: null },
                ],
              },
        );
      }
      if (url.includes("/api/db/query")) {
        return jsonResponse({ rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    expect(await view.findByText("Orders: The catalog is offline.")).toBeTruthy();
    expect(view.queryByRole("list", { name: "Connected databases" })).toBeNull();
    expect(view.queryByText("Orders · postgres")).toBeNull();
    expect(view.getByText("Logs: Could not read the database.")).toBeTruthy();
    await typeAndSend(view, "Compare them");
    expect(await view.findByText("Both databases.")).toBeTruthy();
    expect(
      view.getByText("No connected database is named Nope. The connected databases are Orders, Logs."),
    ).toBeTruthy();
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/api/db/query"))).toHaveLength(2));
    const ids = calls
      .filter((call) => call.url.includes("/api/db/query"))
      .map((call) => (call.body as { connection?: { id?: string } } | null)?.connection?.id);
    expect(ids).toEqual(["c1", "c2"]);
    expect(posts().at(-1)?.body).toMatchObject({ databaseType: "", schemaContext: expect.stringContaining("Orders") });
    unnamed = true;
    await typeAndSend(view, "And another");
    expect(await view.findByText("Name the connected database this query should use.")).toBeTruthy();
  });

  test("a saved chart follows the connection that replaced a renamed database", async () => {
    localStorage.setItem(
      "libredb_connections",
      JSON.stringify([
        { id: "c9", name: "Markets", type: "postgres", host: "localhost", createdAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    localStorage.setItem(
      ASSIST_TRANSCRIPT_KEY,
      JSON.stringify([
        {
          id: "u1",
          role: "user",
          text: "Revenue",
          at: new Date().toISOString(),
          cards: [],
        },
        {
          id: "a1",
          role: "assistant",
          text: "Saved.",
          at: new Date().toISOString(),
          cards: [
            {
              id: "card1",
              title: "Revenue",
              titledSql: "SELECT 1",
              modelSql: "SELECT 1",
              locked: false,
              sql: "SELECT 1",
              connectionId: "c1",
              connectionName: "Warehouse",
              chart: null,
              color: null,
              result: null,
              error: "No connected database is named Warehouse.",
            },
          ],
        },
      ]),
    );
    const view = render(<AiAssist />);
    expect(await view.findByText("Saved.")).toBeTruthy();
    await waitFor(() => expect(view.queryByText(/No connected database is named/)).toBeNull());
    expect(view.getByText(/Markets/)).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "[]") as {
      cards?: { connectionId?: string; connectionName?: string; error?: string | null }[];
    }[];
    expect(saved[1]?.cards?.[0]).toMatchObject({ connectionId: "c9", connectionName: "Markets", error: null });
  });

  test("ignores a schema that arrives after the page is gone", async () => {
    saveConnection();
    let release: ((response: Response) => void) | undefined;
    handler = (url, init) => {
      if (url.includes("provider-meta")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    view.unmount();
    release?.(jsonResponse({ error: "late" }, 500));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  test("treats a catalog that is not a list as ready and a thrown list as a failure", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") return jsonResponse({});
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect((view.getByLabelText("OpenRouter model") as HTMLSelectElement).value).toBe(
      "deepseek/deepseek-v4.1-flash-1017",
    );
    expect(view.getByRole("option", { name: "DeepSeek V4.1 Flash" })).toBeTruthy();
    view.unmount();

    handler = (url) => {
      if (url.includes("/api/ai/assist")) return new Response("nope", { status: 200 });
      return defaultFetch(url);
    };
    const broken = render(<AiAssist />);
    fireEvent.click(await broken.findByRole("button", { name: "Model" }));
    expect(await broken.findByText("The OpenRouter catalog could not be loaded.")).toBeTruthy();
  });

  test("keeps seven days of the conversation and recolors a chart without rewriting it", async () => {
    saveConnection();
    const week = 7 * 24 * 60 * 60 * 1000;
    const revenueSql = "SELECT month, revenue FROM orders LIMIT 200";
    localStorage.setItem(
      ASSIST_TRANSCRIPT_KEY,
      JSON.stringify([
        {
          id: "assist-9",
          role: "user",
          text: "Last week",
          at: new Date(Date.now() - week - 1000).toISOString(),
          cards: [],
        },
        {
          id: "note",
          role: "user",
          text: "Yesterday",
          at: new Date(Date.now() - 60_000).toISOString(),
          cards: [],
        },
        {
          id: "assist-8",
          role: "assistant",
          text: "Saved.",
          at: new Date(Date.now() - 60_000).toISOString(),
          cards: [
            {
              id: "assist-7",
              title: "Saved revenue",
              titledSql: revenueSql,
              modelSql: revenueSql,
              locked: true,
              sql: revenueSql,
              connectionId: "c1",
              connectionName: "Orders",
              chart: { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month", color: null },
              color: "#9546de",
              result: barResult,
              error: null,
            },
            {
              id: "assist-6",
              title: "Count",
              titledSql: "SELECT 1",
              modelSql: "SELECT 1",
              locked: false,
              sql: "SELECT 1",
              connectionId: "c1",
              connectionName: "Orders",
              chart: null,
              color: null,
              result: { rows: [], fields: ["n"], rowCount: 0, executionTime: 1 },
              error: null,
            },
          ],
        },
      ]),
    );
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          explanation: "The bars are red.",
          queries: [
            {
              title: "Revenue again",
              sql: "SELECT  month, revenue FROM orders\nLIMIT 50",
              chart: { type: "line", x: "month", y: ["revenue"], caption: "replaced", color: "red" },
            },
            {
              title: "Spend",
              connection: "Orders",
              sql: "SELECT region, sum(cost) AS spend FROM sales",
              chart: { type: "bar", x: "region", y: ["spend"], caption: "Spend", color: "green" },
            },
          ],
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    expect(await view.findByText("Yesterday")).toBeTruthy();
    expect(view.queryByText("Last week")).toBeNull();
    expect(view.getByRole("heading", { name: "Saved revenue" })).toBeTruthy();
    const restored = charts.at(-1)?.setOption.mock.calls.at(-1)?.[0] as { color?: string[] };
    expect(restored.color?.[0]).toBe("#9546de");
    fireEvent.click(view.getAllByRole("button", { name: "Query" })[0] as HTMLButtonElement);
    fireEvent.change(view.getAllByLabelText("SQL editor")[0] as HTMLTextAreaElement, {
      target: { value: "SELECT 9" },
    });
    const before = JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "[]") as {
      cards?: { sql?: string }[];
    }[];
    expect(before[2]?.cards?.[0]?.sql).toBe(revenueSql);
    fireEvent.click(view.getAllByRole("button", { name: "Chart" })[0] as HTMLButtonElement);

    await typeAndSend(view, "Make it red and show spend");
    expect(await view.findByText("The bars are red.")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Saved revenue" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Revenue again" })).toBeNull();
    expect(view.getByRole("heading", { name: "Spend" })).toBeTruthy();
    expect((view.getAllByLabelText("SQL editor")[0] as HTMLTextAreaElement).value).toBe("SELECT 9");
    await waitFor(() => {
      const colours = charts.flatMap((chart) =>
        chart.setOption.mock.calls.map((call) => (call[0] as { color?: string[] }).color?.[0]),
      );
      expect(colours).toContain("#e66767");
    });

    view.unmount();
    const again = render(<AiAssist />);
    expect(await again.findByText("Yesterday")).toBeTruthy();
    expect(await again.findByText("Make it red and show spend")).toBeTruthy();
    expect(again.queryByText("Last week")).toBeNull();
    expect(again.getByRole("heading", { name: "Saved revenue" })).toBeTruthy();
    expect(again.getByRole("heading", { name: "Spend" })).toBeTruthy();
    const kept = JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "[]") as {
      text?: string;
      cards?: { title?: string; sql?: string; color?: string }[];
    }[];
    expect(kept.some((item) => item.text === "Last week")).toBe(false);
    const saved = kept.flatMap((item) => item.cards ?? []).find((card) => card.title === "Saved revenue");
    expect(saved?.sql).toBe(revenueSql);
    expect(saved?.color).toBe("#e66767");
    const spend = kept.flatMap((item) => item.cards ?? []).find((card) => card.title === "Spend");
    expect(spend?.color).toBe("#199e70");
  });

  test("recolors a locked chart from the question and does not add another", async () => {
    saveConnection();
    const revenueSql = "SELECT month, revenue FROM orders LIMIT 200";
    localStorage.setItem(
      ASSIST_TRANSCRIPT_KEY,
      JSON.stringify([
        {
          id: "assist-2",
          role: "assistant",
          text: "Saved.",
          at: new Date().toISOString(),
          cards: [
            {
              id: "assist-1",
              title: "Saved revenue",
              titledSql: revenueSql,
              modelSql: revenueSql,
              locked: false,
              sql: revenueSql,
              connectionId: "c1",
              connectionName: "Orders",
              chart: { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month", color: null },
              color: null,
              result: barResult,
              error: null,
            },
          ],
        },
      ]),
    );
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          explanation: "Painted.",
          queries: [
            {
              title: "Spend",
              connection: "Orders",
              sql: "SELECT region, sum(cost) AS spend FROM sales",
              chart: { type: "bar", x: "region", y: ["spend"], caption: "Spend", color: null },
            },
          ],
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    expect(await view.findByRole("heading", { name: "Saved revenue" })).toBeTruthy();
    const created = charts.length;
    fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: "p" } });
    fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: "pu" } });
    expect(charts).toHaveLength(created);
    expect(charts.some((chart) => chart.dispose.mock.calls.length > 0)).toBe(false);
    await typeAndSend(view, "make it purple");
    expect(await view.findByText("Painted.")).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Spend" })).toBeNull();
    await waitFor(() => {
      const colours = charts.flatMap((chart) =>
        chart.setOption.mock.calls.map((call) => (call[0] as { color?: string[] }).color?.[0]),
      );
      expect(colours).toContain("#9546de");
    });
  });

  test("drops an answer that arrives after the page is gone", async () => {
    let release: ((response: Response) => void) | undefined;
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body)) });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view, "Stay with me");
    expect(await view.findByText("Stay with me")).toBeTruthy();
    view.unmount();
    release?.(jsonResponse({ explanation: "Too late.", queries: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kept = JSON.parse(localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "[]") as { text?: string }[];
    expect(kept.some((item) => item.text === "Stay with me")).toBe(true);
    expect(kept.some((item) => item.text === "Too late.")).toBe(false);
  });

  test("runs the query, adds the charts those rows suggest, then shows the final analysis", async () => {
    saveConnection();
    const revenue = "SELECT month, revenue FROM orders LIMIT 200";
    handler = (url, init) => {
      const method = init?.method ?? "GET";
      let body: unknown = null;
      if (init?.body !== undefined) body = JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (url.includes("/api/ai/assist") && method === "POST") {
        const posted = body as { pass?: string; results?: unknown } | null;
        if (posted === null || typeof posted !== "object" || !("results" in posted)) {
          return jsonResponse({
            explanation: "I will total revenue.",
            queries: [
              {
                title: "Revenue",
                connection: "Orders",
                sql: revenue,
                chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month" },
              },
            ],
          });
        }
        if (posted.pass === "follow") {
          const seen = calls.filter((call) => {
            const item = call.body;
            return item !== null && typeof item === "object" && "pass" in item && item.pass === "follow";
          }).length;
          if (seen > 2) return jsonResponse({ explanation: "Nothing further.", queries: [] });
          if (seen === 2) {
            return jsonResponse({
              explanation: "A channel split would help.",
              queries: [
                {
                  title: "By channel",
                  connection: "Orders",
                  sql: "SELECT channel, revenue FROM orders",
                  chart: { type: "bar", x: "channel", y: ["revenue"], caption: "by channel" },
                },
              ],
            });
          }
          return jsonResponse({
            explanation: "A region split would help.",
            queries: [
              {
                title: "Revenue",
                sql: revenue,
                chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month" },
              },
              {
                title: "By region",
                connection: "Orders",
                sql: "SELECT region, revenue FROM orders",
                chart: { type: "bar", x: "region", y: ["revenue"], caption: "by region" },
              },
              {
                title: "By product",
                connection: "Orders",
                sql: "SELECT product, revenue FROM orders",
                chart: { type: "bar", x: "product", y: ["revenue"], caption: "by product" },
              },
              {
                title: "By region again",
                connection: "Orders",
                sql: "SELECT region, revenue FROM orders LIMIT 50",
                chart: { type: "bar", x: "region", y: ["revenue"], caption: "again" },
              },
            ],
          });
        }
        return jsonResponse({
          explanation: "January revenue is 10.",
          queries: [{ title: "Ignored", sql: "SELECT 9", chart: null }],
        });
      }
      if (url.includes("/api/db/query")) {
        return jsonResponse({
          rows: [{ month: "Jan", revenue: 10 }],
          fields: ["month", "revenue"],
          rowCount: 1,
          executionTime: 4,
        });
      }
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    await typeAndSend(view);
    expect(await view.findByText("January revenue is 10.")).toBeTruthy();
    expect(view.queryByText("I will total revenue.")).toBeNull();
    expect(view.queryByText("A region split would help.")).toBeNull();
    expect(view.getAllByRole("heading", { name: "Revenue" })).toHaveLength(1);
    expect(view.getByRole("heading", { name: "By region" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "By product" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "By channel" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "By region again" })).toBeNull();
    expect(view.queryByRole("heading", { name: "Ignored" })).toBeNull();
    expect(calls.filter((call) => call.url.includes("/api/db/query"))).toHaveLength(4);
    const bodies = posts().map((call) => call.body as { pass?: string; results?: { rows?: { revenue?: number }[] }[] });
    expect(bodies).toHaveLength(5);
    expect(bodies[0]?.pass).toBeUndefined();
    expect(bodies[0]).not.toHaveProperty("results");
    expect(bodies[1]?.pass).toBe("follow");
    expect(bodies[1]?.results?.[0]?.rows?.[0]?.revenue).toBe(10);
    expect(bodies[2]?.pass).toBe("follow");
    expect(bodies[2]?.results).toHaveLength(3);
    expect(bodies[3]?.pass).toBe("follow");
    expect(bodies[3]?.results).toHaveLength(4);
    expect(bodies[4]?.pass).toBe("final");
    expect(bodies[4]?.results).toHaveLength(4);
  });

  test("shows the final analysis when the follow-up fails, and the plan when neither reading returns one", async () => {
    saveConnection();
    let mode: "final" | "none" | "follow" | "blank" | "throw" = "final";
    handler = (url, init) => {
      const method = init?.method ?? "GET";
      let body: unknown = null;
      if (init?.body !== undefined) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = null;
        }
      }
      calls.push({ url, method, body });
      if (url.includes("/api/ai/assist") && method === "POST") {
        const posted = body as { pass?: string } | null;
        const reading = posted !== null && typeof posted === "object" && "results" in posted;
        if (!reading) {
          return jsonResponse({
            explanation: "I will total revenue.",
            queries: [
              {
                title: "Revenue",
                connection: "Orders",
                sql: "SELECT month, revenue FROM orders LIMIT 200",
                chart: { type: "bar", x: "month", y: ["revenue"], caption: "by month" },
              },
            ],
          });
        }
        if (mode === "throw") throw new Error("offline");
        if (mode === "blank") return new Response("nope", { status: 200 });
        if (mode === "none") return jsonResponse({ error: "no" }, 500);
        if (mode === "follow") {
          if (posted?.pass === "follow") return jsonResponse({ explanation: "Rows suggest a split.", queries: [] });
          return jsonResponse({ explanation: "   ", queries: [] });
        }
        if (posted?.pass === "follow") return jsonResponse({ error: "no" }, 500);
        return jsonResponse({ explanation: "January revenue is 10.", queries: [] });
      }
      return defaultFetch(url, init);
    };

    const ask = async (next: typeof mode, visible: string, hidden: string) => {
      mode = next;
      const view = render(<AiAssist />);
      await typeAndSend(view);
      expect(await view.findByText(visible)).toBeTruthy();
      expect(view.queryByText(hidden)).toBeNull();
      expect(view.queryByText("The assistant could not be reached.")).toBeNull();
      expect(view.queryByRole("heading", { name: "By region" })).toBeNull();
      view.unmount();
      localStorage.removeItem(ASSIST_TRANSCRIPT_KEY);
      calls.length = 0;
    };

    await ask("final", "January revenue is 10.", "I will total revenue.");
    await ask("none", "I will total revenue.", "January revenue is 10.");
    await ask("follow", "Rows suggest a split.", "I will total revenue.");
    await ask("blank", "I will total revenue.", "January revenue is 10.");
    await ask("throw", "I will total revenue.", "January revenue is 10.");
  });
});

function readStored(): { source?: string } {
  return JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}") as { source?: string };
}
