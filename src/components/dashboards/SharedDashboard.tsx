"use client";

import { useEffect, useState } from "react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
import { appFetch } from "@/lib/config/base-path";
import { useChartSettings } from "@/components/charts/use-chart-settings";
import { chartTheme } from "@/lib/charts/palette";
import { applyQueryFilters } from "@/lib/charts/query-filters";
import { optionForSavedChart } from "@/lib/charts/saved-chart-run";
import {
  filterChoiceState,
  filterSlider,
  filterValueList,
  queryWithDashboardFilters,
} from "@/lib/dashboards/dashboard";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import type { DashboardFilter, QueryResult, SavedChartConfig, SavedDashboard } from "@/lib/types";

interface PublicShare {
  readonly name: string;
  readonly dashboard: SavedDashboard;
  readonly charts: readonly SavedChartConfig[];
  readonly refreshedAt: string;
}

interface ShareQuery {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

async function runShareQuery(id: string, sql: string): Promise<ShareQuery | string> {
  const response = await appFetch(`/api/share/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = (await response.json()) as ShareQuery & { error?: unknown };
  if (!response.ok) return typeof body.error === "string" ? body.error : "The snapshot could not answer.";
  return body;
}

/**
 * The shared dashboard. Every query on this page runs against the snapshot,
 * never against the databases the dashboard was built from.
 */
export function SharedDashboard({ id }: { readonly id: string }) {
  const [share, setShare] = useState<PublicShare | null>(null);
  const [missing, setMissing] = useState(false);
  const [filters, setFilters] = useState<readonly DashboardFilter[]>([]);

  useEffect(() => {
    let stopped = false;
    void appFetch(`/api/share/${id}`)
      .then(async (response) => {
        if (stopped) return;
        if (!response.ok) {
          setMissing(true);
          return;
        }
        const body = (await response.json()) as PublicShare;
        setShare(body);
        setFilters(body.dashboard.filters ?? []);
      })
      .catch(() => {
        if (!stopped) setMissing(true);
      });
    return () => {
      stopped = true;
    };
  }, [id]);

  if (missing) return <p className="mt-6 text-sm text-fg-muted">This shared dashboard is no longer available.</p>;
  if (share === null) return <p className="mt-6 text-sm text-fg-muted">Loading the dashboard.</p>;

  const charts = share.charts;
  return (
    <div className="mt-6 flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{share.name}</h1>
        <p className="mt-1 text-xs text-fg-muted">Updated {new Date(share.refreshedAt).toLocaleString()}</p>
      </div>
      {filters.map((filter) => (
        <SharedFilter
          key={filter.id}
          id={id}
          filter={filter}
          onChange={(value) =>
            setFilters((current) => current.map((item) => (item.id === filter.id ? { ...item, value } : item)))
          }
        />
      ))}
      {(share.dashboard.charts ?? []).map((frame) => {
        const chart = charts.find((item) => item.id === frame.chartId);
        if (chart === undefined) return null;
        return (
          <div key={frame.chartId} style={{ width: "100%", maxWidth: frame.width, height: frame.height }}>
            <SharedChart id={id} chart={chart} filters={filters} />
          </div>
        );
      })}
      {(share.dashboard.notes ?? []).map((note) => (
        <p key={note.id} className="max-w-xl text-sm text-fg">
          {note.text}
        </p>
      ))}
    </div>
  );
}

function SharedFilter({
  id,
  filter,
  onChange,
}: {
  readonly id: string;
  readonly filter: DashboardFilter;
  readonly onChange: (value: string) => void;
}) {
  const [choices, setChoices] = useState<readonly string[]>(() =>
    filter.choiceSource === "values" ? filterValueList(filter.valuesText ?? "") : [],
  );
  useEffect(() => {
    if (filter.choiceSource === "values" || filter.query.trim() === "") return;
    let stopped = false;
    void runShareQuery(id, filter.query)
      .then((result) => {
        if (stopped || typeof result === "string") return;
        setChoices(filterChoiceState(result.rows, result.fields, filter.choiceField).choices);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [filter.choiceField, filter.choiceSource, filter.query, id]);

  const label = filter.label?.trim() || filter.name;
  if (filter.control === "slider") {
    const slider = filterSlider(filter);
    return (
      <label className="flex max-w-xl flex-col gap-1 text-xs text-fg-muted">
        {label}
        <input
          type="range"
          aria-label={label}
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={slider.value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  if (filter.control === "search") {
    return (
      <label className="flex max-w-xl flex-col gap-1 text-xs text-fg-muted">
        {label}
        <input
          type="search"
          aria-label={label}
          value={filter.value}
          placeholder={filter.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-sm text-fg"
        />
      </label>
    );
  }
  return (
    <label className="flex max-w-xl flex-col gap-1 text-xs text-fg-muted">
      {label}
      <select
        aria-label={label}
        value={filter.value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-sm text-fg"
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    </label>
  );
}

function SharedChart({
  id,
  chart,
  filters,
}: {
  readonly id: string;
  readonly chart: SavedChartConfig;
  readonly filters: readonly DashboardFilter[];
}) {
  const theme = chartTheme(useEffectiveTheme());
  const settings = useChartSettings();
  const query = applyQueryFilters(queryWithDashboardFilters(chart.query ?? "", filters));
  const [loaded, setLoaded] = useState<{ query: string; value: QueryResult | string } | null>(null);

  useEffect(() => {
    if (query.trim() === "") return;
    let stopped = false;
    void runShareQuery(id, query)
      .then((result) => {
        if (stopped) return;
        setLoaded({
          query,
          value:
            typeof result === "string"
              ? result
              : { rows: result.rows, fields: result.fields, rowCount: result.rowCount, executionTime: 0 },
        });
      })
      .catch(() => {
        if (!stopped) setLoaded({ query, value: "The snapshot could not answer." });
      });
    return () => {
      stopped = true;
    };
  }, [id, query]);

  if (query.trim() === "") return <p className="text-sm text-fg-muted">This chart has no query in the snapshot.</p>;
  const view = loaded !== null && loaded.query === query ? loaded.value : null;
  if (typeof view === "string") return <p className="text-sm text-fg-muted">{view}</p>;
  if (view === null) return <p className="text-sm text-fg-muted">Loading {chart.name}.</p>;
  const built = optionForSavedChart(chart, view, theme, settings);
  return (
    <div className="flex h-full flex-col rounded-xl border border-hairline bg-surface p-3">
      <h2 className="text-sm font-medium text-fg">{chart.name}</h2>
      <div className="min-h-0 flex-1">
        {built === null ? (
          <p className="text-sm text-fg-muted">This chart has no shelves.</p>
        ) : (
          <AssistChartCanvas option={built.option} notes={built.notes} />
        )}
      </div>
    </div>
  );
}
