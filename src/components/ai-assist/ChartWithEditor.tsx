"use client";

import { useEffect, useMemo, useState } from "react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
import { QueryEditor } from "@/components/QueryEditor";
import { assistChoiceForVariation, nextAssistChoice, type AssistChartChoice } from "@/lib/ai/assist-chart";
import type { AssistChart } from "@/lib/ai/assist-plan";
import { classifyColumns, ECHART_TYPES, echartType, slotsFor, toggleSlot } from "@/lib/charts/echarts-catalog";
import { buildChartOption } from "@/lib/charts/echarts-option";
import { chartTheme } from "@/lib/charts/palette";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import type { DatabaseType, QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const PREVIEW_ROWS = 8;
const PREVIEW_COLUMNS = 6;

export interface ChartWithEditorProps {
  readonly title: string;
  readonly sql: string;
  readonly connectionName?: string;
  readonly databaseType?: DatabaseType;
  readonly schemaContext?: string;
  readonly result: QueryResult | null;
  readonly error: string | null;
  readonly chart: AssistChart | null;
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
 * A chart the assistant drew, with the SQL editor behind it.
 * Query hides the chart and leaves the editor, which was mounted underneath the whole time.
 */
export function ChartWithEditor({
  title,
  sql,
  connectionName,
  databaseType,
  schemaContext,
  result,
  error,
  chart,
  running,
  onSqlChange,
  onRun,
}: ChartWithEditorProps) {
  const [tracked, setTracked] = useState({ result, error });
  const [face, setFace] = useState<"chart" | "query">("chart");
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
    const previous = seen.chart === chart ? choice : null;
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
    });
  }, [result, choice, theme]);

  return (
    <article className="flex h-[28rem] flex-col overflow-hidden rounded-lg border border-hairline-strong bg-raised">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h3>
        {connectionName !== undefined && connectionName !== "" && (
          <span className="text-xs text-fg-subtle">{connectionName}</span>
        )}
        {result !== null && (
          <span className="text-xs text-fg-muted">
            {result.rowCount} rows · {result.executionTime} ms
          </span>
        )}
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-lg border border-hairline bg-sunken p-0.5">
            <button
              type="button"
              aria-pressed={face === "chart"}
              onClick={() => setFace("chart")}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium",
                face === "chart" ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
              )}
            >
              Chart
            </button>
            <button
              type="button"
              aria-pressed={face === "query"}
              onClick={() => setFace("query")}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium",
                face === "query" ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
              )}
            >
              Query
            </button>
          </div>
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
        </div>
      </div>
      {chart?.caption ? <p className="px-3 pt-2 text-xs text-fg-muted">{chart.caption}</p> : null}
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", face === "chart" && "invisible")} aria-hidden={face === "chart"}>
          <QueryEditor
            value={sql}
            documentId={title}
            databaseType={databaseType}
            schemaContext={schemaContext}
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
                      <fieldset aria-label="Chart variations" className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
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
            {!running && slots !== null && columns !== null && (
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
            )}
            {!running && built !== null && (
              <div className="min-h-0 flex-1">
                <AssistChartCanvas option={built.option} notes={built.notes} />
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
                The SQL editor is behind this chart. Open Query to read it.
              </p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
