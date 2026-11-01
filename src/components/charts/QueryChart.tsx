"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  GeoComponent,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { init, registerMap, use as registerECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { QueryFilterBar } from "@/components/charts/QueryFilterBar";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import {
  classifyColumns,
  defaultSelection,
  ECHART_TYPES,
  echartType,
  seedChartChoice,
  selectionReady,
  slotsFor,
  toggleSlot,
  type ChartChoice,
  type ClassifiedColumns,
} from "@/lib/charts/echarts-catalog";
import { buildChartOption, watchChartSize, WORLD_MAP_NAME, WORLD_OUTLINE } from "@/lib/charts/echarts-option";
import { readQueryFilters } from "@/lib/charts/query-filters";
import { chartTheme } from "@/lib/charts/palette";
import {
  loadMaskingConfig,
  maskValueByPattern,
  maskingInForce,
  type MaskingConfig,
  type MaskingPattern,
} from "@/lib/data-masking";
import { splitMaskedColumns } from "@/lib/db/masking-exemption";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { AgentChartSpec, QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  VisualMapComponent,
  CanvasRenderer,
]);

export interface QueryChartProps {
  result: QueryResult | null;
  /**
   * A chart an agent run composed. It selects a type and a variation when the
   * columns are in this result. The shelves stay editable.
   */
  spec?: AgentChartSpec | null;
  /** The editor statement. Placeholders in it become controls on this chart. */
  query?: string;
  onFilterChange?: (name: string, value: string) => void;
  maskingEnabled?: boolean;
  userRole?: string;
  maskingConfig?: MaskingConfig;
  /** The provider's columns the masking rules must leave alone. */
  maskingExemptColumns?: ProviderCapabilities["maskingExemptColumns"];
}

function choiceSignature(columns: ClassifiedColumns, spec: AgentChartSpec | null | undefined): string {
  return [
    columns.dimensions.join("\0"),
    columns.metrics.join("\0"),
    spec?.type ?? "",
    spec?.x ?? "",
    (spec?.y ?? []).join("\0"),
  ].join("\n");
}

/**
 * The Charts tab.
 *
 * The thirteen ECharts types are the first choice. A type then lists its variations,
 * and the variation lists the result's columns. One chart is drawn, for the variation
 * that is selected.
 */
export function QueryChart({
  result,
  spec = null,
  query,
  onFilterChange,
  maskingEnabled,
  userRole,
  maskingConfig,
  maskingExemptColumns,
}: QueryChartProps) {
  const resolvedMaskingConfig = maskingConfig ?? loadMaskingConfig();
  const sensitive = useMemo(
    () =>
      result === null || !maskingInForce(userRole, resolvedMaskingConfig, maskingEnabled)
        ? new Map<string, MaskingPattern>()
        : splitMaskedColumns(result.fields, resolvedMaskingConfig, maskingExemptColumns).masked,
    [result, resolvedMaskingConfig, userRole, maskingEnabled, maskingExemptColumns],
  );
  const withheld = useMemo(() => new Set(sensitive.keys()), [sensitive]);
  const fields = result?.fields;
  const rows = result?.rows;
  const columns = useMemo(() => classifyColumns(fields ?? [], rows ?? [], withheld), [fields, rows, withheld]);
  const signature = choiceSignature(columns, spec);
  const seeded = useMemo(() => seedChartChoice(spec, columns), [spec, columns]);
  const [choice, setChoice] = useState<ChartChoice>(seeded);
  const [applied, setApplied] = useState(signature);
  if (applied !== signature) {
    setApplied(signature);
    setChoice(seeded);
  }

  const theme = chartTheme(useEffectiveTheme());
  const mask = useMemo(() => {
    if (sensitive.size === 0) return undefined;
    return (column: string, value: unknown): string => {
      const pattern = sensitive.get(column);
      if (pattern !== undefined) return maskValueByPattern(value, pattern);
      if (value === null || value === undefined) return "(null)";
      return String(value);
    };
  }, [sensitive]);

  const hasRows = result !== null && result.fields.length > 0 && result.rows.length > 0;
  const type = choice.typeId === null ? null : echartType(choice.typeId);
  const slots =
    choice.typeId !== null && choice.variationId !== null ? slotsFor(choice.typeId, choice.variationId) : null;
  const ready = slots !== null && selectionReady(choice.typeId ?? "", choice.variationId ?? "", choice.selection);
  const built = useMemo(() => {
    if (!hasRows || choice.typeId === null || choice.variationId === null || !ready) return null;
    return buildChartOption({
      typeId: choice.typeId,
      variationId: choice.variationId,
      rows: rows ?? [],
      selection: choice.selection,
      theme,
      mask,
    });
  }, [hasRows, choice, ready, rows, theme, mask]);

  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = hostRef.current;
    if (built === null || element === null) return;
    registerMap(WORLD_MAP_NAME, WORLD_OUTLINE);
    const chart = init(element);
    chart.setOption(built.option, true);
    const stop = watchChartSize(element, () => chart.resize());
    return () => {
      stop();
      chart.dispose();
    };
  }, [built]);

  const selectType = (typeId: string) => {
    setChoice((current) => (current.typeId === typeId ? current : { typeId, variationId: null, selection: {} }));
  };
  const selectVariation = (variationId: string) => {
    setChoice((current) => {
      if (current.typeId === null || current.variationId === variationId) return current;
      return {
        typeId: current.typeId,
        variationId,
        selection: defaultSelection(current.typeId, variationId, columns),
      };
    });
  };

  const filters = query !== undefined && onFilterChange !== undefined ? readQueryFilters(query) : [];
  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      {filters.length > 0 && onFilterChange !== undefined && (
        <QueryFilterBar filters={filters} onChange={onFilterChange} />
      )}
      <fieldset
        aria-label="Chart types"
        className="m-0 flex min-w-0 flex-wrap gap-1 border-0 border-b border-hairline p-2"
      >
        {ECHART_TYPES.map((item) => {
          const pressed = choice.typeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => selectType(item.id)}
              className={cn(
                "rounded border px-2 py-1 text-xs",
                pressed
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-hairline-strong text-fg-secondary hover:bg-raised",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </fieldset>
      {type !== null && (
        <fieldset
          aria-label="Chart variations"
          className="m-0 flex min-w-0 flex-wrap gap-1 border-0 border-b border-hairline px-2 py-2"
        >
          {type.variations.map((item) => {
            const pressed = choice.variationId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={pressed}
                onClick={() => selectVariation(item.id)}
                className={cn(
                  "rounded border px-2 py-1 text-xs",
                  pressed
                    ? "border-brand bg-brand/15 text-brand"
                    : "border-hairline-strong text-fg-secondary hover:bg-raised",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </fieldset>
      )}
      {slots !== null && !hasRows && (
        <p className="px-3 py-6 text-center text-xs text-fg-muted">
          Run a query. Charts can only use columns from its result.
        </p>
      )}
      {slots !== null && hasRows && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap gap-3 border-b border-hairline px-2 py-2">
            {slots.map((slot) => {
              const pool = slot.kind === "metric" ? columns.metrics : columns.dimensions;
              const selected = new Set(choice.selection[slot.id] ?? []);
              return (
                <fieldset
                  key={slot.id}
                  aria-label={slot.label}
                  className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
                >
                  <span className="text-xs text-fg-muted">{slot.label}</span>
                  {pool.map((name) => {
                    const pressed = selected.has(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() =>
                          setChoice((current) => {
                            if (current.typeId === null || current.variationId === null) return current;
                            return {
                              ...current,
                              selection: toggleSlot(
                                current.typeId,
                                current.variationId,
                                columns,
                                current.selection,
                                slot.id,
                                name,
                              ),
                            };
                          })
                        }
                        className={cn(
                          "rounded border px-2 py-0.5 text-xs",
                          pressed
                            ? "border-brand bg-brand/15 text-brand"
                            : "border-hairline-strong text-fg-secondary hover:bg-raised",
                        )}
                      >
                        {name}
                      </button>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
          {!ready && (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">Choose the columns this chart needs.</p>
          )}
          {ready && built === null && (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">Those columns do not have numbers to chart.</p>
          )}
          {built !== null && (
            <>
              <div ref={hostRef} data-testid="query-chart" className="min-h-48 flex-1" />
              {built.notes.length > 0 && (
                <ul className="px-3 py-1 text-xs text-fg-muted">
                  {built.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
