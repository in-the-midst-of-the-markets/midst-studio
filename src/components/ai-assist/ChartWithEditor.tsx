"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, Braces, Terminal, X, type LucideIcon } from "lucide-react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
import { ChartCodeEditor, useChartCode } from "@/components/charts/ChartCodeEditor";
import { SaveChartButton } from "@/components/charts/SaveChartButton";
import { stripChartValues } from "@/lib/charts/chart-code";
import { chartTitleStyle, chartTitleText } from "@/lib/charts/chart-title";
import { defaultFilterLooks, mergeFilterLooks, readFilterLooks, withFilterLooks } from "@/lib/charts/filter-look";
import { chartSaveDraft } from "@/lib/charts/save-chart";
import { ChartFilterShelf, QueryFilterBar } from "@/components/charts/QueryFilterBar";
import { QueryEditor } from "@/components/QueryEditor";
import { assistChoiceForVariation, nextAssistChoice, type AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import {
  clearQueryFilters,
  readQueryFilters,
  writeMetricCompare,
  writeMetricFilter,
  writeQueryFilter,
  type FilterCompare,
} from "@/lib/charts/query-filters";
import { classifyColumns, ECHART_TYPES, echartType, slotsFor, toggleSlot } from "@/lib/charts/echarts-catalog";
import { buildChartOption } from "@/lib/charts/echarts-option";
import { chartTheme } from "@/lib/charts/palette";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const PREVIEW_ROWS = 8;
const PREVIEW_COLUMNS = 6;

function FaceButton({
  pressed,
  onClick,
  icon: Icon,
  label,
}: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly icon: LucideIcon;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-lg",
        pressed ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

export interface ChartWithEditorProps {
  readonly title: string;
  readonly sql: string;
  /** The connection the saved chart reruns `sql` on. */
  readonly connectionId?: string;
  readonly databaseType?: DatabaseType;
  readonly schemaContext?: string;
  readonly result: QueryResult | null;
  readonly error: string | null;
  readonly chart: AssistChart | null;
  /** The series colour for this chart, when the model or a later answer set one. */
  readonly color?: string | null;
  readonly running: boolean;
  readonly onSqlChange: (sql: string) => void;
  readonly onRun: (sql: string) => void;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  return String(value);
}

/** A caption-only update is still the same chart the user has been editing. */
function sameChartPlan(left: AssistChart | null, right: AssistChart | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.type === right.type &&
    left.x === right.x &&
    left.y.length === right.y.length &&
    left.y.every((metric, index) => metric === right.y[index])
  );
}

function ResultTable({ result }: { result: QueryResult }) {
  const fields = result.fields.slice(0, PREVIEW_COLUMNS);
  const rows = result.rows.slice(0, PREVIEW_ROWS);
  const hiddenRows = result.rows.length - rows.length;
  const hiddenFields = result.fields.length - fields.length;
  return (
    <div className="h-full overflow-auto p-3">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            {fields.map((field) => (
              <th key={field} className="border-b border-hairline px-2 py-1 font-medium text-fg-muted">
                {field}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={fields.map((field) => cellText(row[field])).join("\u001f")}>
              {fields.map((field) => (
                <td key={field} className="border-b border-hairline px-2 py-1 text-fg">
                  {cellText(row[field])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenRows > 0 && <p className="px-2 py-1 text-xs text-fg-muted">{hiddenRows} more rows</p>}
      {hiddenFields > 0 && <p className="px-2 py-1 text-xs text-fg-muted">{hiddenFields} more columns</p>}
    </div>
  );
}

/**
 * A chart the assistant drew, with the SQL editor and the chart's own code behind it.
 * Query hides the chart and leaves the editor, which was mounted underneath the whole time.
 * Code is the chart option as JSON. The canvas keeps the generated option until that JSON parses.
 */
export function ChartWithEditor({
  title,
  sql,
  connectionId,
  databaseType,
  schemaContext,
  result,
  error,
  chart,
  color = null,
  running,
  onSqlChange,
  onRun,
}: ChartWithEditorProps) {
  const [tracked, setTracked] = useState({ result, error });
  const [face, setFace] = useState<"chart" | "code" | "query">("chart");
  const [choice, setChoice] = useState<AssistChartChoice | null>(() => nextAssistChoice(chart, result, null));
  const [seen, setSeen] = useState({ result, chart });
  const [typesOpen, setTypesOpen] = useState(false);
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const theme = chartTheme(useEffectiveTheme());
  if (tracked.result !== result || tracked.error !== error) {
    setTracked({ result, error });
    setFace("chart");
  }
  if (seen.result !== result || seen.chart !== chart) {
    const previous = sameChartPlan(seen.chart, chart) ? choice : null;
    setSeen({ result, chart });
    setChoice(nextAssistChoice(chart, result, previous));
    setBrowsingId(null);
  }

  useEffect(() => {
    if (face !== "query") return;
    const onExecute = (event: Event) => {
      const query = (event as CustomEvent<{ query?: unknown }>).detail?.query;
      if (typeof query !== "string" || query.trim() === "") return;
      onSqlChange(query);
      onRun(query);
    };
    window.addEventListener("execute-query", onExecute);
    return () => window.removeEventListener("execute-query", onExecute);
  }, [face, onRun, onSqlChange]);

  const columns = result !== null && result.rows.length > 0 ? classifyColumns(result.fields, result.rows) : null;
  const filters = readQueryFilters(sql);
  const metricNames = columns?.metrics ?? [];
  const changeFilter = (name: string, value: string) => {
    onRun(metricNames.includes(name) ? writeMetricFilter(sql, name, value) : writeQueryFilter(sql, name, value));
  };
  const changeCompare = (name: string, compare: FilterCompare) => {
    onRun(writeMetricCompare(sql, filters, name, compare));
  };
  const slots = choice === null ? null : slotsFor(choice.typeId, choice.variationId);
  const typeMeta = choice === null ? null : echartType(choice.typeId);
  const variationMeta =
    typeMeta === null || choice === null
      ? null
      : (typeMeta.variations.find((item) => item.id === choice.variationId) ?? null);
  const typeButtonLabel =
    typeMeta === null || variationMeta === null
      ? "Choose a type"
      : `Change type, ${typeMeta.label}, ${variationMeta.label}`;
  const shownTypeId = browsingId ?? choice?.typeId ?? null;
  const shownType = shownTypeId === null ? null : echartType(shownTypeId);
  const built = useMemo(() => {
    if (result === null || result.rows.length === 0 || choice === null) return null;
    return buildChartOption({
      typeId: choice.typeId,
      variationId: choice.variationId,
      rows: result.rows,
      selection: choice.selection,
      theme,
      color,
      title,
    });
  }, [result, choice, theme, color, title]);
  const filterLooks = defaultFilterLooks(filters, metricNames);
  const code = useChartCode(
    built?.option ?? null,
    choice?.typeId ?? null,
    choice?.variationId ?? null,
    choice?.selection ?? null,
    result,
    filterLooks,
  );
  const looks = mergeFilterLooks(filterLooks, readFilterLooks(code.editedOption));
  const savedLook = built === null ? undefined : withFilterLooks(stripChartValues(code.option ?? built.option), looks);
  const codeTitle = chartTitleText(code.option);
  const heading = codeTitle !== "" ? codeTitle : title;

  return (
    <article className="flex w-full flex-col gap-4">
      <h3 className="text-2xl font-semibold tracking-tight text-fg" style={chartTitleStyle(code.editedOption)}>
        {heading}
      </h3>
      <div className="flex h-[min(24rem,70dvh)] min-h-64 flex-col overflow-hidden rounded-xl border border-hairline bg-raised shadow-sm 2xl:h-[min(28rem,calc(100dvh-12rem))]">
        <div className="flex flex-wrap items-center justify-end gap-2 border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-1.5">
            <FaceButton pressed={face === "chart"} onClick={() => setFace("chart")} icon={BarChart3} label="Chart" />
            <FaceButton pressed={face === "query"} onClick={() => setFace("query")} icon={Terminal} label="Query" />
            {face === "query" && (
              <button
                type="button"
                onClick={() => onRun(sql)}
                disabled={running}
                className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Run
              </button>
            )}
            <FaceButton pressed={face === "code"} onClick={() => setFace("code")} icon={Braces} label="Code" />
            {built !== null && choice !== null && (
              <SaveChartButton
                draft={chartSaveDraft({
                  title: chartTitleText(code.option ?? built.option),
                  query: sql,
                  connectionId,
                  typeId: choice.typeId,
                  variationId: choice.variationId,
                  selection: choice.selection,
                  look: savedLook,
                })}
              />
            )}
          </div>
        </div>
        {filters.length > 0 && (running || columns === null || slots === null) && (
          <QueryFilterBar
            filters={filters}
            metrics={metricNames}
            disabled={running}
            looks={looks}
            onChange={changeFilter}
            onCompare={changeCompare}
            onClear={() => onRun(clearQueryFilters(sql))}
          />
        )}
        {error !== null && (
          <label className="block border-b border-hairline px-3 py-2">
            <span className="text-xs text-fg-muted">SQL</span>
            <textarea
              aria-label="Query SQL"
              value={sql}
              wrap="soft"
              rows={4}
              onChange={(event) => onSqlChange(event.target.value)}
              className="mt-1 w-full resize-y whitespace-pre-wrap break-words rounded border border-hairline-strong bg-canvas p-2 font-mono text-xs text-fg"
            />
          </label>
        )}
        <div className="relative min-h-0 flex-1">
          <div className={cn("absolute inset-0", face !== "query" && "invisible")} aria-hidden={face !== "query"}>
            <QueryEditor
              value={sql}
              documentId={title}
              databaseType={databaseType}
              schemaContext={schemaContext}
              wordWrap
              onContentChange={onSqlChange}
            />
          </div>
          {face === "chart" && (
            <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
              {error !== null && (
                <p role="alert" className="px-3 py-2 text-xs text-danger">
                  {error}
                </p>
              )}
              {running && <p className="px-3 py-6 text-center text-xs text-fg-muted">Running the query…</p>}
              {!running && columns !== null && (
                <div className="border-b border-hairline px-3 py-2">
                  <button
                    type="button"
                    aria-expanded={typesOpen}
                    aria-label={typeButtonLabel}
                    onClick={() => setTypesOpen((open) => !open)}
                    className="rounded border border-hairline-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-raised"
                  >
                    {typeMeta === null || variationMeta === null
                      ? "Choose a type"
                      : `${typeMeta.label} · ${variationMeta.label}`}
                  </button>
                  {typesOpen && (
                    <div className="mt-2 flex flex-col gap-2">
                      <fieldset aria-label="Chart types" className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
                        {ECHART_TYPES.map((item) => {
                          const pressed = (browsingId ?? choice?.typeId) === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              aria-pressed={pressed}
                              onClick={() => setBrowsingId((current) => (current === item.id ? current : item.id))}
                              className={cn(
                                "rounded border px-2 py-0.5 text-xs",
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
                      {shownType !== null && (
                        <fieldset
                          aria-label="Chart variations"
                          className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0"
                        >
                          {shownType.variations.map((item) => {
                            const pressed = choice?.typeId === shownType.id && choice.variationId === item.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                aria-pressed={pressed}
                                onClick={() => {
                                  const classified = columns;
                                  setChoice((current) => {
                                    if (current?.typeId === shownType.id && current.variationId === item.id) {
                                      return current;
                                    }
                                    return assistChoiceForVariation(shownType.id, item.id, classified) ?? current;
                                  });
                                }}
                                className={cn(
                                  "rounded border px-2 py-0.5 text-xs",
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
                    </div>
                  )}
                </div>
              )}
              {!running && result !== null && slots !== null && columns !== null && (
                <div className="flex flex-wrap gap-3 border-b border-hairline px-3 py-2">
                  {slots.map((slot) => {
                    const pool = slot.kind === "metric" ? columns.metrics : columns.dimensions;
                    const selected = new Set(choice?.selection[slot.id] ?? []);
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
                                  if (current === null) return current;
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
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                                pressed
                                  ? "border-transparent bg-brand-tint/15 text-brand"
                                  : "border-hairline-strong text-fg-secondary hover:bg-raised",
                              )}
                            >
                              {name}
                              {pressed && <X className="size-3" />}
                            </button>
                          );
                        })}
                      </fieldset>
                    );
                  })}
                  <ChartFilterShelf
                    columns={columns.dimensions}
                    metrics={columns.metrics}
                    rows={result.rows}
                    sql={sql}
                    disabled={running}
                    clearClassName="border-0 bg-transparent px-1 font-medium text-brand hover:bg-transparent hover:underline"
                    looks={looks}
                    onSql={onRun}
                  />
                </div>
              )}
              {!running && built !== null && (
                <div className="flex min-h-0 flex-1 flex-col">
                  {code.option !== null && (
                    <div className="flex items-center justify-between gap-2 px-3 py-1">
                      <p className="text-xs text-fg-muted">Showing your chart code.</p>
                      <button
                        type="button"
                        onClick={code.reset}
                        className="text-xs font-medium text-fg-secondary underline"
                      >
                        Use generated chart
                      </button>
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <AssistChartCanvas
                      option={code.option ?? built.option}
                      notes={code.option === null ? built.notes : []}
                    />
                  </div>
                </div>
              )}
              {!running && built === null && choice !== null && result !== null && result.rows.length > 0 && (
                <p className="px-3 py-6 text-center text-xs text-fg-muted">Choose the columns this chart needs.</p>
              )}
              {!running && built === null && result !== null && result.rows.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-fg-muted">The query returned no rows.</p>
              )}
              {!running && built === null && choice === null && result !== null && result.rows.length > 0 && (
                <ResultTable result={result} />
              )}
              {!running && error === null && result === null && (
                <p className="px-3 py-6 text-center text-xs text-fg-muted">
                  The SQL editor is behind this chart. Open Query to edit it, or Code to edit the chart.
                </p>
              )}
            </div>
          )}
          {face === "code" && (
            <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
              <ChartCodeEditor
                value={code.text}
                error={code.error}
                edited={code.edited}
                onChange={code.onChange}
                onReset={code.reset}
              />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
