"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BarChart3,
  Bookmark,
  ChartColumn,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  ListFilter,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
import { QueryFilterBar } from "@/components/charts/QueryFilterBar";
import { Button } from "@/components/ui/button";
import { appFetch } from "@/lib/config/base-path";
import {
  dashboardName,
  dragResize,
  freshDashboard,
  MIN_DASHBOARD_CHART_WIDTH,
  withChart,
  withFrame,
  withName,
  withoutChart,
} from "@/lib/dashboards/dashboard";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { classifyColumns, echartType } from "@/lib/charts/echarts-catalog";
import {
  clearQueryFilters,
  readQueryFilters,
  writeMetricCompare,
  writeMetricFilter,
  writeQueryFilter,
} from "@/lib/charts/query-filters";
import { loadSavedChart, optionForSavedChart, type SavedChartView } from "@/lib/charts/saved-chart-run";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTheme } from "@/lib/charts/palette";
import { storage } from "@/lib/storage";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

const CHART_GLYPH: Record<string, LucideIcon> = {
  line: LineChart,
  bar: BarChart3,
};

const fieldClass = "h-9 w-full rounded-lg border border-hairline-strong bg-canvas px-2 text-sm text-fg";

function boardWidth(board: HTMLElement | null): number {
  const measured = board?.clientWidth ?? 0;
  return measured >= MIN_DASHBOARD_CHART_WIDTH ? measured : window.innerWidth;
}

function chartsLabel(count: number): string {
  return `${count} ${count === 1 ? "chart" : "charts"}`;
}

function ChartGlyph({ typeId }: { readonly typeId: string | undefined }) {
  const Icon = (typeId !== undefined ? CHART_GLYPH[typeId] : undefined) ?? ChartColumn;
  return <Icon className="size-3.5 text-fg-muted" />;
}

/**
 * Compiles dashboards from saved charts.
 * Each chart keeps the size the user dragged it to, and a chart with a query can
 * rerun that query on its own schedule.
 */
export function DashboardStudio() {
  const boardRef = useRef<HTMLDivElement>(null);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>(() => storage.getSavedDashboards());
  const [activeId, setActiveId] = useState<string | null>(() => storage.getActiveDashboardId());
  const [charts, setCharts] = useState<SavedChartConfig[]>(() => storage.getSavedCharts());
  const [connections] = useState<DatabaseConnection[]>(() => storage.getConnections());
  const [picked, setPicked] = useState("");
  const active = dashboards.find((item) => item.id === activeId) ?? null;

  const remember = (next: SavedDashboard) => {
    storage.saveDashboard(next);
    setDashboards(storage.getSavedDashboards());
  };

  const choose = (id: string | null) => {
    storage.setActiveDashboardId(id);
    setActiveId(id);
  };

  const create = () => {
    const dashboard = freshDashboard(dashboardName(dashboards));
    remember(dashboard);
    choose(dashboard.id);
    setPicked("");
  };

  const placed = active === null ? [] : active.charts;
  const available = charts.filter((chart) => !placed.some((frame) => frame.chartId === chart.id));
  const onDashboard = placed.flatMap((frame) => {
    const chart = charts.find((item) => item.id === frame.chartId);
    return chart === undefined ? [] : [chart];
  });

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 lg:w-64 lg:border-r lg:border-hairline lg:pr-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <LayoutDashboard className="size-4 text-fg-muted" />
          Your dashboard
        </div>
        {dashboards.length > 0 && (
          <label className="mt-4 block text-xs text-fg-muted">
            Dashboard
            <select
              aria-label="Dashboard"
              value={active?.id ?? ""}
              onChange={(event) => choose(event.target.value === "" ? null : event.target.value)}
              className={`mt-1.5 ${fieldClass}`}
            >
              {active === null && <option value="">Choose a dashboard</option>}
              {dashboards.map((dashboard) => (
                <option key={dashboard.id} value={dashboard.id}>
                  {dashboard.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={create}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand"
        >
          <Plus className="size-3.5" />
          New dashboard
        </button>
        {active !== null && (
          <>
            <div className="mt-5 border-t border-hairline pt-5">
              <label className="block text-xs text-fg-muted">
                Dashboard name
                <input
                  aria-label="Dashboard name"
                  value={active.name}
                  onChange={(event) => remember(withName(active, event.target.value))}
                  className={`mt-1.5 ${fieldClass}`}
                />
              </label>
              <p className="mt-1.5 text-xs text-fg-muted">Choose a name to make this dashboard easy to find.</p>
            </div>
            <div className="mt-5 border-t border-hairline pt-5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium tracking-wide text-fg-muted">ON THIS DASHBOARD</span>
                <span className="text-xs text-fg-muted">{onDashboard.length}</span>
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {onDashboard.map((chart) => (
                  <li key={chart.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-fg">
                    <span className="flex size-6 items-center justify-center rounded bg-fill-subtle">
                      <ChartGlyph typeId={chart.typeId} />
                    </span>
                    <span className="truncate">{chart.name}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-5 rounded-xl bg-brand-tint/10 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <LayoutGrid className="size-4 text-brand" />
                Make it your own
              </div>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Add saved charts, filter the data, and switch dashboards for a different view.
              </p>
            </div>
            <div className="mt-5 border-t border-hairline pt-4">
              <button
                type="button"
                onClick={() => {
                  storage.deleteDashboard(active.id);
                  const remaining = storage.getSavedDashboards();
                  setDashboards(remaining);
                  choose(remaining[0]?.id ?? null);
                }}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-danger"
              >
                <Trash2 className="size-3.5" />
                Delete dashboard
              </button>
            </div>
          </>
        )}
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Create</h1>
          {active !== null && (
            <span className="rounded-full bg-brand-tint/15 px-2 py-0.5 text-xs font-medium text-brand">
              {active.name}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          Compile a dashboard from saved charts. Save more than one, and switch when you want a different view.
        </p>
        {dashboards.length === 0 ? (
          <p className="mt-6 text-sm text-fg-muted">You have no dashboards yet.</p>
        ) : active === null ? (
          <p className="mt-6 text-sm text-fg-muted">Choose a dashboard.</p>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-raised px-4 py-3 shadow-sm">
              <span className="text-sm text-fg-secondary">Saved charts</span>
              <select
                aria-label="Saved chart"
                value={picked}
                onChange={(event) => setPicked(event.target.value)}
                className="h-9 w-56 max-w-full rounded-lg border border-hairline-strong bg-canvas px-2 text-sm text-fg"
              >
                <option value="">Choose a chart</option>
                {available.map((chart) => (
                  <option key={chart.id} value={chart.id}>
                    {chart.name}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                onClick={() => {
                  remember(withChart(active, picked, boardWidth(boardRef.current)));
                  setPicked("");
                }}
                disabled={picked === ""}
                className="h-9 rounded-lg px-3"
              >
                <Plus />
                Add chart
              </Button>
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-muted">
                <LayoutGrid className="size-3.5" />
                {chartsLabel(onDashboard.length)}
              </span>
            </div>
            {charts.length === 0 && (
              <p className="text-sm text-fg-muted">Save a chart from the editor or AI Assist, then add it here.</p>
            )}
            {charts.length > 0 && placed.length === 0 && (
              <p className="text-sm text-fg-muted">Add a saved chart to this dashboard.</p>
            )}
            <div ref={boardRef} className="flex flex-col items-start gap-4">
              {placed.map((frame) => {
                const chart = charts.find((item) => item.id === frame.chartId);
                if (chart === undefined) return null;
                return (
                  <DashboardChart
                    key={chart.id}
                    chart={chart}
                    width={frame.width}
                    height={frame.height}
                    connections={connections}
                    onRemove={() => remember(withoutChart(active, chart.id))}
                    onResize={(size) => remember(withFrame(active, chart.id, size))}
                    onQuery={(query) => {
                      storage.saveChart({ ...chart, query });
                      setCharts(storage.getSavedCharts());
                    }}
                    onUnsave={() => {
                      storage.deleteChart(chart.id);
                      setCharts(storage.getSavedCharts());
                      setDashboards(storage.getSavedDashboards());
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardChart({
  chart,
  width,
  height,
  connections,
  onRemove,
  onResize,
  onQuery,
  onUnsave,
}: {
  readonly chart: SavedChartConfig;
  readonly width: number;
  readonly height: number;
  readonly connections: readonly DatabaseConnection[];
  readonly onRemove: () => void;
  readonly onResize: (size: { width: number; height: number }) => void;
  readonly onQuery: (query: string) => void;
  readonly onUnsave: () => void;
}) {
  const theme = chartTheme(useEffectiveTheme());
  const [view, setView] = useState<SavedChartView | { kind: "loading" }>({ kind: "loading" });
  const query = chart.query;
  const connectionId = chart.connectionId;
  const refreshSeconds = chart.refreshSeconds;
  const run = useCallback(
    () => loadSavedChart({ query, connectionId }, connections, appFetch),
    [query, connectionId, connections],
  );

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      void run().then((next) => {
        if (!stopped) setView(next);
      });
    };
    tick();
    const delay = refreshDelayMs(refreshSeconds);
    if (delay === null) {
      return () => {
        stopped = true;
      };
    }
    const id = window.setInterval(tick, delay);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [run, refreshSeconds]);

  const built = view.kind === "result" ? optionForSavedChart(chart, view.result, theme) : null;
  const missingShelves = chart.typeId === undefined || chart.variationId === undefined;
  const sql = chart.query ?? "";
  const filters = readQueryFilters(sql);
  const metrics = view.kind === "result" ? classifyColumns(view.result.fields, view.result.rows).metrics : [];
  const kind = chart.typeId === undefined ? null : echartType(chart.typeId);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.focus();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { width, height };
    const move = (ev: PointerEvent) => {
      onResize(dragResize(start, ev.clientX - startX, ev.clientY - startY, window.innerWidth));
    };
    const up = (ev: PointerEvent) => {
      move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta: Record<string, [number, number]> = {
      ArrowRight: [step, 0],
      ArrowLeft: [-step, 0],
      ArrowDown: [0, step],
      ArrowUp: [0, -step],
    };
    const next = delta[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onResize(dragResize({ width, height }, next[0], next[1], window.innerWidth));
  };

  return (
    <article
      data-testid={`dashboard-chart-${chart.id}`}
      style={{ width, height }}
      className="relative flex max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-raised shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold text-fg">
          {chart.name}
          {kind !== null && <span className="ml-2 text-xs font-normal text-fg-muted">{kind.label} chart</span>}
        </h2>
        <div className="flex shrink-0 items-center gap-4">
          <button
            type="button"
            aria-label={`Unsave ${chart.name}`}
            onClick={onUnsave}
            className="inline-flex items-center gap-1.5 text-xs text-fg-secondary hover:text-fg"
          >
            <Bookmark className="size-3.5" />
            Unsave chart
          </button>
          <button
            type="button"
            aria-label={`Remove ${chart.name}`}
            onClick={onRemove}
            className="inline-flex items-center gap-1.5 text-xs text-fg-secondary hover:text-fg"
          >
            <X className="size-3.5" />
            Remove
          </button>
        </div>
      </div>
      {filters.length > 0 && (
        <QueryFilterBar
          filters={filters}
          metrics={metrics}
          label={
            <>
              <ListFilter className="size-3.5" />
              Filter by
            </>
          }
          className="border-0 px-4 py-3"
          clearClassName="border-0 bg-transparent px-1 font-medium text-brand hover:bg-transparent hover:underline"
          onChange={(name, value) =>
            onQuery(metrics.includes(name) ? writeMetricFilter(sql, name, value) : writeQueryFilter(sql, name, value))
          }
          onCompare={(name, compare) => onQuery(writeMetricCompare(sql, filters, name, compare))}
          onClear={() => onQuery(clearQueryFilters(sql))}
        />
      )}
      <div className="min-h-0 flex-1">
        {view.kind === "loading" && <p className="p-3 text-xs text-fg-muted">Running the query…</p>}
        {view.kind === "empty" && <p className="p-3 text-xs text-fg-muted">{view.message}</p>}
        {view.kind === "error" && (
          <p role="alert" className="p-3 text-xs text-danger">
            {view.message}
          </p>
        )}
        {view.kind === "result" && missingShelves && (
          <p className="p-3 text-xs text-fg-muted">Save this chart again from the chart view.</p>
        )}
        {view.kind === "result" && !missingShelves && built === null && (
          <p className="p-3 text-xs text-fg-muted">Those columns do not have numbers to chart.</p>
        )}
        {built !== null && <AssistChartCanvas option={built.option} notes={built.notes} />}
      </div>
      <button
        type="button"
        aria-label={`Resize ${chart.name}`}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="absolute right-0 bottom-0 h-4 w-4 cursor-se-resize"
      />
    </article>
  );
}
