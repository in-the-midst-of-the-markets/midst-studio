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
import { ChartCodeEditor, useChartCode } from "@/components/charts/ChartCodeEditor";
import { CirclePackChart } from "@/components/charts/CirclePackChart";
import { SaveChartButton } from "@/components/charts/SaveChartButton";
import { stripChartValues } from "@/lib/charts/chart-code";
import { chartOptionForDisplay } from "@/lib/charts/chart-html";
import { chartTitleText } from "@/lib/charts/chart-title";
import { defaultFilterLooks, mergeFilterLooks, readFilterLooks, withFilterLooks } from "@/lib/charts/filter-look";
import { chartSaveDraft } from "@/lib/charts/save-chart";
import { ChartFilterShelf, QueryFilterBar } from "@/components/charts/QueryFilterBar";
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
import { useChartSettings } from "@/components/charts/use-chart-settings";
import { isCirclePack } from "@/lib/charts/circle-pack";
import { buildChartOption, watchChartSize, WORLD_MAP_NAME, WORLD_OUTLINE } from "@/lib/charts/echarts-option";
import {
  clearQueryFilters,
  readQueryFilters,
  writeMetricCompare,
  writeMetricFilter,
  writeQueryFilter,
} from "@/lib/charts/query-filters";
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
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
  BrushComponent,
  DataZoomComponent,
  ToolboxComponent,
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
  /** The connection the saved chart reruns `query` on. */
  connectionId?: string;
  /** Replaces the editor statement with the next template and runs it. */
  onFilterChange?: (sql: string) => void;
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
 * The ECharts types are the first choice. A type then lists its variations,
 * and the variation lists the result's columns. One chart is drawn, for the variation
 * that is selected.
 */
export function QueryChart({
  result,
  spec = null,
  query,
  connectionId,
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
  const settings = useChartSettings();
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
      title: type?.label ?? "",
      settings,
    });
  }, [hasRows, choice, ready, rows, theme, mask, type, settings]);
  const filters = query !== undefined && onFilterChange !== undefined ? readQueryFilters(query) : [];
  const filterLooks = defaultFilterLooks(filters, columns.metrics);
  const code = useChartCode(
    built?.option ?? null,
    choice.typeId,
    choice.variationId,
    choice.selection,
    result,
    filterLooks,
  );
  const looks = mergeFilterLooks(filterLooks, readFilterLooks(code.editedOption));
  const savedLook = built === null ? undefined : withFilterLooks(stripChartValues(code.option ?? built.option), looks);
  const [codeOpen, setCodeOpen] = useState(false);

  const drawn = code.option ?? built?.option ?? null;
  const pack = drawn !== null && isCirclePack(drawn);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = hostRef.current;
    if (codeOpen || built === null || pack || element === null) return;
    registerMap(WORLD_MAP_NAME, WORLD_OUTLINE);
    const chart = init(element);
    chart.setOption(chartOptionForDisplay(code.option ?? built.option), true);
    const stop = watchChartSize(element, () => chart.resize());
    return () => {
      stop();
      chart.dispose();
    };
  }, [built, code.option, codeOpen, pack]);

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

  const shelfOpen = slots !== null && hasRows;
  return (
    <div className="flex h-full min-h-0 flex-col bg-sunken">
      {filters.length > 0 && query !== undefined && onFilterChange !== undefined && !shelfOpen && (
        <QueryFilterBar
          filters={filters}
          metrics={columns.metrics}
          looks={looks}
          onChange={(name, value) =>
            onFilterChange(
              columns.metrics.includes(name)
                ? writeMetricFilter(query, name, value)
                : writeQueryFilter(query, name, value),
            )
          }
          onCompare={(name, compare) => onFilterChange(writeMetricCompare(query, filters, name, compare))}
          onClear={() => onFilterChange(clearQueryFilters(query))}
        />
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
            {query !== undefined && onFilterChange !== undefined && (
              <ChartFilterShelf
                columns={columns.dimensions}
                metrics={columns.metrics}
                rows={rows ?? []}
                sql={query}
                looks={looks}
                onSql={onFilterChange}
              />
            )}
          </div>
          {!ready && (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">Choose the columns this chart needs.</p>
          )}
          {ready && built === null && (
            <p className="px-3 py-6 text-center text-xs text-fg-muted">Those columns do not have numbers to chart.</p>
          )}
          {built !== null && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-1 border-b border-hairline px-2 py-1">
                <div className="flex items-center rounded-lg border border-hairline bg-control p-0.5">
                  <button
                    type="button"
                    aria-pressed={!codeOpen}
                    onClick={() => setCodeOpen(false)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium",
                      !codeOpen ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    Chart
                  </button>
                  <button
                    type="button"
                    aria-pressed={codeOpen}
                    onClick={() => setCodeOpen(true)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium",
                      codeOpen ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    Code
                  </button>
                </div>
                {type !== null && choice.typeId !== null && choice.variationId !== null && (
                  <SaveChartButton
                    draft={chartSaveDraft({
                      title: chartTitleText(code.option ?? built.option),
                      query,
                      connectionId,
                      typeId: choice.typeId,
                      variationId: choice.variationId,
                      selection: choice.selection,
                      look: savedLook,
                    })}
                  />
                )}
              </div>
              {codeOpen ? (
                <ChartCodeEditor
                  value={code.text}
                  error={code.error}
                  edited={code.edited}
                  onChange={code.onChange}
                  onReset={code.reset}
                />
              ) : (
                <>
                  {pack && drawn !== null ? (
                    <div data-testid="query-chart" className="min-h-48 flex-1">
                      <CirclePackChart option={drawn} />
                    </div>
                  ) : (
                    <div ref={hostRef} data-testid="query-chart" className="min-h-48 flex-1" />
                  )}
                  {code.option === null && built.notes.length > 0 && (
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
      )}
    </div>
  );
}
