import "../../setup-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";
import { assistStatementLanguage, isAssistRead } from "@/lib/ai/assist-language";

mock.module("@/lib/ai/assist-language", () => ({
  assistStatementLanguage,
  isAssistRead,
  assistRunnableStatement: () => null,
}));
mock.module("echarts/core", () => ({
  use: () => {},
  init: () => ({ setOption: () => {}, resize: () => {}, dispose: () => {} }),
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
  QueryEditor: () => null,
}));

setupChartCodeMonacoMock();

const { AiAssist } = await import("@/components/ai-assist/AiAssist");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("AiAssist read guard", () => {
  test("refuses a planned statement the connection cannot run", async () => {
    localStorage.clear();
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
    localStorage.setItem("libredb_active_connection_id", "c1");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/api/ai/assist") && method === "GET") {
        return Response.json({ models: [{ id: "openai/gpt-4o", name: "GPT-4o" }] });
      }
      if (url.includes("/api/ai/assist")) {
        return Response.json({
          explanation: "Revenue rose.",
          queries: [{ title: "Revenue", sql: "SELECT 1", chart: null }],
        });
      }
      return Response.json({ error: "missing" }, { status: 404 });
    }) as typeof fetch;

    const view = render(<AiAssist />);
    fireEvent.change(view.getByLabelText("How can I help?"), { target: { value: "Count the rows" } });
    fireEvent.click(await view.findByRole("button", { name: "Send" }));
    expect(await view.findByText("AI Assist only runs read-only queries.")).toBeTruthy();
  });
});
