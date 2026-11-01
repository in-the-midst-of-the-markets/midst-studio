import "../../setup-dom";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
mock.module("echarts/charts", () => ({ LineChart: {}, BarChart: {}, ScatterChart: {} }));
mock.module("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {} }));
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
const barChart: AssistChart = { type: "bar", x: "month", y: ["revenue"], caption: "Revenue by month" };

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
    expect(view.getByText("Revenue by month")).toBeTruthy();
    expect(view.getByText("1 rows · 4 ms")).toBeTruthy();
    expect(view.getByTestId("assist-chart")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    const editor = view.getByLabelText("SQL editor");
    fireEvent.change(editor, { target: { value: "SELECT 2" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(ran).toEqual(["SELECT 2"]));
    expect(view.getByText("1 rows · 9 ms")).toBeTruthy();
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
    expect(view.getByText("The SQL editor is behind this chart. Open Query to read it.")).toBeTruthy();
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
        chart={{ type: "bar", x: "missing", y: ["nope"], caption: "" }}
        running={false}
        onSqlChange={() => {}}
        onRun={() => {}}
      />,
    );
    expect(errorView.getByRole("alert").textContent).toBe("denied");
    expect(errorView.getByText("month")).toBeTruthy();
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
  });
});

describe("AiAssist page", () => {
  test("asks how it can help and points back at the editor", async () => {
    const view = render(<AssistPage />);
    expect(await view.findByRole("heading", { name: "How can I help?" })).toBeTruthy();
    expect(view.getByRole("link", { name: "AI Assist" }).getAttribute("aria-current")).toBe("page");
    expect(view.getByRole("link", { name: "Traditional" }).getAttribute("href")).toBe("/");
    expect(view.getByText("No database")).toBeTruthy();
    expect(view.getByText(/Add a database in Traditional mode/)).toBeTruthy();
  });

  test("uses the active connection, or the only one, and retries a catalog read", async () => {
    saveConnection("missing");
    const view = render(<AiAssist />);
    expect(await view.findByText("Orders")).toBeTruthy();
    expect(await view.findByText(/catalog is offline/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("provider-meta")).length).toBeGreaterThan(1));
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
    expect(view.getByRole("option", { name: "missing/model" })).toBeTruthy();
    fireEvent.change(view.getByLabelText("OpenRouter API key"), { target: { value: "ork" } });
    fireEvent.change(view.getByLabelText("OpenRouter model"), { target: { value: "other/model" } });
    fireEvent.click(view.getByLabelText("Fireworks AI"));
    fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: "What changed?" } });
    fireEvent.keyDown(view.getByLabelText("How can I help?"), { key: "Enter" });
    expect(await view.findByRole("alert")).toHaveProperty("textContent", "Name the model to use.");
    fireEvent.change(view.getByLabelText("Fireworks API key"), { target: { value: "fwk" } });
    fireEvent.change(view.getByLabelText("Fireworks model"), { target: { value: "accounts/acme/models/tuned" } });
    expect(JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}").fireworksModel).toBe(
      "accounts/acme/models/tuned",
    );
    view.unmount();
    expect(readStored().source).toBe("fireworks");
  });

  test("writes a query, draws the chart, and reveals the editor behind it", async () => {
    saveConnection();
    const view = render(<AiAssist />);
    await view.findByText("Orders");
    await typeAndSend(view);
    expect(await view.findByText("Revenue rose.")).toBeTruthy();
    expect(await view.findByText("Revenue by month")).toBeTruthy();
    expect(await view.findByText("1 rows · 4 ms")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    expect(view.getByLabelText("SQL editor")).toBeTruthy();
    fireEvent.change(view.getByLabelText("SQL editor"), { target: { value: "DELETE FROM orders" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    expect(await view.findByText("AI Assist only runs read-only queries.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.change(view.getByLabelText("SQL editor"), { target: { value: "SELECT 2" } });
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.url.includes("/api/db/query") && (call.body as { sql?: string } | null)?.sql === "SELECT 2",
        ),
      ).toBe(true),
    );
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
    await view.findByText("No database");
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
    expect(await view.findByText("The SQL editor is behind this chart. Open Query to read it.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Query" }));
    fireEvent.click(view.getByRole("button", { name: "Run" }));
    expect(await view.findByText("Connect a database in Traditional mode to run this query.")).toBeTruthy();
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
    await view.findByText("Orders");
    await typeAndSend(view, "First");
    await view.findByText("Revenue rose.");
    await typeAndSend(view, "Second");
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.body).toMatchObject({
      history: [{ question: "First", explanation: "Revenue rose." }],
    });
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
    await view.findByText("Orders");
    await typeAndSend(view);
    expect(await view.findByText("denied")).toBeTruthy();
    view.unmount();

    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "POST") return jsonResponse(null);
      return defaultFetch(url, init);
    };
    const empty = render(<AiAssist />);
    await typeAndSend(empty);
    expect(await empty.findByText("What changed?")).toBeTruthy();
    expect(empty.queryByText("Revenue rose.")).toBeNull();
  });

  test("says when the model list cannot be loaded", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") return jsonResponse({}, 503);
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect(await view.findByText("The OpenRouter catalog could not be loaded.")).toBeTruthy();
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

  test("treats a catalog that is not a list as ready and a thrown list as a failure", async () => {
    handler = (url, init) => {
      if (url.includes("/api/ai/assist") && (init?.method ?? "GET") === "GET") return jsonResponse({});
      return defaultFetch(url, init);
    };
    const view = render(<AiAssist />);
    fireEvent.click(await view.findByRole("button", { name: "Model" }));
    expect((view.getByLabelText("OpenRouter model") as HTMLSelectElement).value).toBe("z-ai/glm-5.3");
    expect(view.getByRole("option", { name: "GLM 5.3" })).toBeTruthy();
    view.unmount();

    handler = (url) => {
      if (url.includes("/api/ai/assist")) return new Response("nope", { status: 200 });
      return defaultFetch(url);
    };
    const broken = render(<AiAssist />);
    fireEvent.click(await broken.findByRole("button", { name: "Model" }));
    expect(await broken.findByText("The OpenRouter catalog could not be loaded.")).toBeTruthy();
  });
});

function readStored(): { source?: string } {
  return JSON.parse(localStorage.getItem("libredb_ai_assist") ?? "{}") as { source?: string };
}
