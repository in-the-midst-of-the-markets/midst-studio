"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  BarChart,
  BoxplotChart,
  CandlestickChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  BrushComponent,
  CalendarComponent,
  DataZoomComponent,
  GeoComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { init, registerMap, use as registerECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { CirclePackChart } from "@/components/charts/CirclePackChart";
import { isCirclePack } from "@/lib/charts/circle-pack";
import { watchChartSize, WORLD_MAP_NAME, WORLD_OUTLINE } from "@/lib/charts/echarts-option";

registerECharts([
  LineChart,
  BarChart,
  ScatterChart,
  RadarChart,
  BoxplotChart,
  CandlestickChart,
  HeatmapChart,
  GraphChart,
  TreemapChart,
  SankeyChart,
  FunnelChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  RadarComponent,
  GeoComponent,
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
  BrushComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

/**
 * Draws one ECharts option. The SQL editor that produced it is a sibling behind
 * this canvas, owned by the card.
 */
export function AssistChartCanvas({
  option,
  notes,
}: {
  readonly option: Record<string, unknown>;
  readonly notes: readonly string[];
}) {
  const chartRef = useRef<ReturnType<typeof init> | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const optionRef = useRef(option);

  // React 19 detaches a ref when its callback identity changes, and that detach
  // disposes the chart. Typing in the chat re-renders this card, so the callback
  // stays the same and the option is applied only when it actually changes.
  const bind = useCallback((element: HTMLDivElement | null) => {
    stopRef.current?.();
    stopRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
    if (element === null) return;
    registerMap(WORLD_MAP_NAME, WORLD_OUTLINE);
    const chart = init(element);
    chart.setOption(optionRef.current, true);
    chartRef.current = chart;
    stopRef.current = watchChartSize(element, () => {
      chart.resize();
    });
  }, []);

  useEffect(() => {
    optionRef.current = option;
    chartRef.current?.setOption(option, true);
  }, [option]);

  if (isCirclePack(option)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div data-testid="assist-chart" className="min-h-0 w-full flex-1">
          <CirclePackChart option={option} />
        </div>
        {notes.length > 0 && (
          <ul className="px-3 py-1 text-xs text-fg-muted">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={bind} data-testid="assist-chart" className="min-h-0 w-full flex-1" />
      {notes.length > 0 && (
        <ul className="px-3 py-1 text-xs text-fg-muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
