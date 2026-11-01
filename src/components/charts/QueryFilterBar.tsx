"use client";

import { useState } from "react";
import {
  addQueryFilter,
  isNumericFilterValue,
  metricFilterValue,
  readQueryFilters,
  removeQueryFilter,
  writeMetricFilter,
  writeQueryFilter,
  type FilterCompare,
  type QueryFilter,
} from "@/lib/charts/query-filters";
import { cn } from "@/lib/utils";

interface FilterControlProps {
  readonly filter: QueryFilter;
  readonly disabled: boolean;
  readonly hideName?: boolean;
  /** A metric is a number plus >=, <=, or =, rather than a list of category values. */
  readonly numeric?: boolean;
  readonly onChange: (name: string, value: string) => void;
  readonly onCompare?: (name: string, compare: FilterCompare) => void;
}

function FilterControl({
  filter,
  disabled,
  hideName = false,
  numeric = false,
  onChange,
  onCompare,
}: FilterControlProps) {
  const [draft, setDraft] = useState(filter.value);
  const [seen, setSeen] = useState(filter.value);
  if (seen !== filter.value) {
    setSeen(filter.value);
    setDraft(filter.value);
  }
  const commit = (value: string) => {
    if (numeric && !isNumericFilterValue(value)) {
      setDraft(filter.value);
      return;
    }
    if (value === filter.value) return;
    onChange(filter.name, value);
  };
  if (numeric) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
        {hideName ? null : filter.name}
        <select
          aria-label={`${filter.name} comparison`}
          disabled={disabled}
          value={filter.compare}
          onChange={(event) => {
            const next = event.target.value;
            if (next !== ">=" && next !== "<=" && next !== "=") return;
            onCompare?.(filter.name, next);
          }}
          className="rounded border border-hairline-strong bg-raised px-1 py-0.5 text-xs text-fg disabled:opacity-50"
        >
          <option value=">=">&gt;=</option>
          <option value="<=">&lt;=</option>
          <option value="=">=</option>
        </select>
        <input
          type="number"
          inputMode="decimal"
          step="any"
          aria-label={filter.name}
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit(draft);
          }}
          className="w-24 rounded border border-hairline-strong bg-raised px-2 py-0.5 text-xs text-fg disabled:opacity-50"
        />
      </span>
    );
  }
  if (filter.options.length > 0) {
    const choices = filter.options.includes(filter.value) ? filter.options : [filter.value, ...filter.options];
    return (
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        {hideName ? null : filter.name}
        <select
          aria-label={filter.name}
          disabled={disabled}
          value={filter.value}
          onChange={(event) => commit(event.target.value)}
          className="rounded border border-hairline-strong bg-raised px-2 py-0.5 text-xs text-fg disabled:opacity-50"
        >
          {choices.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      {hideName ? null : filter.name}
      <input
        aria-label={filter.name}
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit(draft);
        }}
        className="w-28 rounded border border-hairline-strong bg-raised px-2 py-0.5 text-xs text-fg disabled:opacity-50"
      />
    </label>
  );
}

export interface QueryFilterBarProps {
  readonly filters: readonly QueryFilter[];
  readonly metrics?: readonly string[];
  readonly disabled?: boolean;
  /** Sits in the Dimension and Metric row, so it has no bar of its own. */
  readonly embedded?: boolean;
  readonly hideNames?: boolean;
  readonly onChange: (name: string, value: string) => void;
  readonly onCompare?: (name: string, compare: FilterCompare) => void;
}

/** The controls for the placeholders in the query behind this chart. */
export function QueryFilterBar({
  filters,
  metrics = EMPTY_METRICS,
  disabled = false,
  embedded = false,
  hideNames = false,
  onChange,
  onCompare,
}: QueryFilterBarProps) {
  const metricNames = new Set(metrics);
  return (
    <div
      className={embedded ? "contents" : "flex flex-wrap items-center gap-3 border-b border-hairline px-3 py-2"}
      aria-label={embedded ? undefined : "Query filters"}
    >
      {embedded ? null : <span className="text-xs font-medium text-fg-secondary">Filters</span>}
      {filters.map((filter) => (
        <FilterControl
          key={filter.name}
          filter={filter}
          disabled={disabled}
          hideName={hideNames}
          numeric={metricNames.has(filter.name)}
          onChange={onChange}
          onCompare={onCompare}
        />
      ))}
    </div>
  );
}

const CHOICE_CAP = 24;
const EMPTY_METRICS: readonly string[] = [];

function choicesFor(column: string, rows: readonly Record<string, unknown>[]): string[] {
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    const text = String(value).trim();
    if (text === "" || text.length > 80 || /[|}\r\n]/.test(text) || seen.has(text)) continue;
    seen.add(text);
    choices.push(text);
    if (choices.length === CHOICE_CAP) break;
  }
  return choices;
}

export interface ChartFilterShelfProps {
  readonly columns: readonly string[];
  /** Numeric columns. Selecting one edits a number with >=, <=, or =. */
  readonly metrics?: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly sql: string;
  readonly disabled?: boolean;
  readonly onSql: (sql: string) => void;
}

/** A Filter control in the same row as Dimension and Metric. Each column toggles a comparison. */
export function ChartFilterShelf({
  columns,
  metrics = EMPTY_METRICS,
  rows,
  sql,
  disabled = false,
  onSql,
}: ChartFilterShelfProps) {
  const filters = readQueryFilters(sql);
  const names = columns.filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name));
  const named = new Set(names);
  const metricNames = new Set(metrics);
  const toggle = (name: string) => {
    if (filters.some((filter) => filter.name === name)) onSql(removeQueryFilter(sql, name));
    else if (metricNames.has(name)) onSql(addQueryFilter(sql, name, metricFilterValue(rows, name)));
    else {
      const choices = choicesFor(name, rows);
      onSql(addQueryFilter(sql, name, choices[0] ?? "", choices));
    }
  };
  return (
    <fieldset aria-label="Filter" className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <span className="text-xs text-fg-muted">Filter</span>
      {names.map((name) => {
        const filter = filters.find((item) => item.name === name);
        const pressed = filter !== undefined;
        return (
          <span key={name} className="inline-flex items-center gap-1">
            <button
              type="button"
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => toggle(name)}
              className={cn(
                "rounded border px-2 py-0.5 text-xs",
                pressed
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-hairline-strong text-fg-secondary hover:bg-raised",
              )}
            >
              {name}
            </button>
            {filter !== undefined && (
              <FilterControl
                filter={filter}
                disabled={disabled}
                hideName
                numeric={metricNames.has(name)}
                onCompare={(filterName, compare) => onSql(writeMetricFilter(sql, filterName, filter.value, compare))}
                onChange={(filterName, value) =>
                  onSql(
                    metricNames.has(name)
                      ? writeMetricFilter(sql, filterName, value)
                      : writeQueryFilter(sql, filterName, value),
                  )
                }
              />
            )}
          </span>
        );
      })}
      <QueryFilterBar
        embedded
        filters={filters.filter((filter) => !named.has(filter.name))}
        disabled={disabled}
        onChange={(name, value) => onSql(writeQueryFilter(sql, name, value))}
      />
    </fieldset>
  );
}
