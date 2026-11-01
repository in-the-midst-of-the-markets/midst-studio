"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
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
import { loadSavedChart, optionForSavedChart, type SavedChartView } from "@/lib/charts/saved-chart-run";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTheme } from "@/lib/charts/palette";
import { storage } from "@/lib/storage";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

function boardWidth(board: HTMLElement | null): number {
  const measured = board?.clientWidth ?? 0;
  return measured >= MIN_DASHBOARD_CHART_WIDTH ? measured : window.innerWidth;
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
  const [charts] = useState<SavedChartConfig[]>(() => storage.getSavedCharts());
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

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium text-fg">Create</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Compile a dashboard from saved charts. Save more than one, and switch when you want a different view.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {dashboards.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            Dashboard
            <select
              aria-label="Dashboard"
              value={active?.id ?? ""}
              onChange={(event) => choose(event.target.value === "" ? null : event.target.value)}
              className="h-8 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
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
        <button type="button" onClick={create} className="text-xs font-medium text-brand underline">
          New dashboard
        </button>
      </div>
      {dashboards.length === 0 ? (
        <p className="text-sm text-fg-muted">You have no dashboards yet.</p>
      ) : active === null ? (
        <p className="text-sm text-fg-muted">Choose a dashboard.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Dashboard name"
              value={active.name}
              onChange={(event) => remember(withName(active, event.target.value))}
              className="h-8 max-w-sm rounded border border-hairline-strong bg-canvas px-2 text-sm text-fg"
            />
            <button
              type="button"
              onClick={() => {
                storage.deleteDashboard(active.id);
                const remaining = storage.getSavedDashboards();
                setDashboards(remaining);
                choose(remaining[0]?.id ?? null);
              }}
              className="text-xs font-medium text-danger underline"
            >
              Delete dashboard
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Saved chart"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              className="h-8 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
            >
              <option value="">Choose a chart</option>
              {available.map((chart) => (
                <option key={chart.id} value={chart.id}>
                  {chart.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                remember(withChart(active, picked, boardWidth(boardRef.current)));
                setPicked("");
              }}
              disabled={picked === ""}
              className="text-xs font-medium text-brand underline disabled:opacity-50"
            >
              Add chart
            </button>
          </div>
          {charts.length === 0 && (
            <p className="text-sm text-fg-muted">Save a chart from the editor or AI Assist, then add it here.</p>
          )}
          {charts.length > 0 && placed.length === 0 && (
            <p className="text-sm text-fg-muted">Add a saved chart to this dashboard.</p>
          )}
          <div ref={boardRef} className="flex flex-wrap items-start gap-3">
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
                />
              );
            })}
          </div>
        </div>
      )}
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
}: {
  readonly chart: SavedChartConfig;
  readonly width: number;
  readonly height: number;
  readonly connections: readonly DatabaseConnection[];
  readonly onRemove: () => void;
  readonly onResize: (size: { width: number; height: number }) => void;
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
      className="relative flex flex-col overflow-hidden rounded-lg border border-hairline-strong bg-raised"
    >
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-2 py-1">
        <h2 className="min-w-0 truncate text-xs font-medium text-fg">{chart.name}</h2>
        <button type="button" onClick={onRemove} className="text-xs text-fg-muted underline">
          Remove {chart.name}
        </button>
      </div>
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
