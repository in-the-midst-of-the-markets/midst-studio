import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

const clicks: ((params: unknown) => void)[] = [];

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => ({
    setOption() {},
    resize() {},
    dispose() {},
    on(_event: string, handler: (params: unknown) => void) {
      clicks.push(handler);
    },
  }),
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
  CalendarComponent: {},
  BrushComponent: {},
  DataZoomComponent: {},
  ToolboxComponent: {},
}));
mock.module("echarts/renderers", () => ({ CanvasRenderer: {} }));

const { AssistChartCanvas } = await import("@/components/ai-assist/AssistChartCanvas");

class ImmediateObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

describe("AssistChartCanvas clicks", () => {
  const Observer = globalThis.ResizeObserver;

  afterEach(() => {
    cleanup();
    clicks.length = 0;
    globalThis.ResizeObserver = Observer;
  });

  test("reports a series click and ignores a click that is not a point", () => {
    globalThis.ResizeObserver = ImmediateObserver as unknown as typeof ResizeObserver;
    const seen: { name: string; value: unknown }[] = [];
    render(<AssistChartCanvas option={{ series: [] }} notes={[]} onPoint={(point) => seen.push(point)} />);
    clicks[0]?.({ componentType: "legend", name: "Amount" });
    clicks[0]?.({ componentType: "series", name: "East", value: 12 });
    expect(seen).toEqual([{ name: "East", value: 12 }]);
  });

  test("a chart with no click handler still accepts the event", () => {
    globalThis.ResizeObserver = ImmediateObserver as unknown as typeof ResizeObserver;
    render(<AssistChartCanvas option={{ series: [] }} notes={[]} />);
    expect(() => clicks[0]?.({ componentType: "series", name: "East", value: 1 })).not.toThrow();
  });
});
