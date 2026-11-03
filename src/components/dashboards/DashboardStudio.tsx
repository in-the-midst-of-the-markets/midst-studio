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
  Braces,
  ChartColumn,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  ListFilter,
  Plus,
  Search,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import { AssistChartCanvas } from "@/components/ai-assist/AssistChartCanvas";
import { JsCodeEditor } from "@/components/editor/JsCodeEditor";
import { ChartCodeEditor, useChartCode } from "@/components/charts/ChartCodeEditor";
import { QueryFilterBar } from "@/components/charts/QueryFilterBar";
import { QueryEditor } from "@/components/QueryEditor";
import { appFetch } from "@/lib/config/base-path";
import {
  dashboardName,
  dragResize,
  CUSTOM_FILTER_SCRIPT,
  filterChoices,
  filterControlPatch,
  filterFrameDocument,
  filterFrameMessage,
  filterReference,
  filterSlider,
  freshDashboard,
  freshDashboardChart,
  MIN_DASHBOARD_CHART_WIDTH,
  queryWithDashboardFilters,
  withChart,
  withFilter,
  withFilterFields,
  withFrame,
  withName,
  withNote,
  withNoteText,
  withoutChart,
  withoutFilter,
  withoutNote,
} from "@/lib/dashboards/dashboard";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { formatChartCode, parseChartCode, stripChartValues } from "@/lib/charts/chart-code";
import { classifyColumns, defaultSelection, ECHART_TYPES } from "@/lib/charts/echarts-catalog";
import { buildChartOption } from "@/lib/charts/echarts-option";
import { defaultFilterLooks, mergeFilterLooks, readFilterLooks } from "@/lib/charts/filter-look";
import {
  clearQueryFilters,
  readQueryFilters,
  writeMetricCompare,
  writeMetricFilter,
  writeQueryFilter,
} from "@/lib/charts/query-filters";
import { axesFromSelection, storedChartLook } from "@/lib/charts/save-chart";
import { loadSavedChart, optionForSavedChart, type SavedChartView } from "@/lib/charts/saved-chart-run";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTheme } from "@/lib/charts/palette";
import { storage } from "@/lib/storage";
import type {
  DashboardFilter,
  DashboardFilterControl,
  DashboardNote,
  DatabaseConnection,
  DatabaseType,
  SavedChartConfig,
  SavedDashboard,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const CHART_GLYPH: Record<string, LucideIcon> = {
  line: LineChart,
  bar: BarChart3,
};

const fieldClass = "h-9 w-full rounded-lg border border-hairline-strong bg-canvas px-2 text-sm text-fg";

function boardWidth(board: HTMLElement | null): number {
  const measured = board?.clientWidth ?? 0;
  return measured >= MIN_DASHBOARD_CHART_WIDTH ? measured : window.innerWidth;
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>(() => storage.getSavedDashboards());
  const [activeId, setActiveId] = useState<string | null>(() => storage.getActiveDashboardId());
  const [charts, setCharts] = useState<SavedChartConfig[]>(() => storage.getSavedCharts());
  const [connections] = useState<DatabaseConnection[]>(() => storage.getConnections());
  const [menu, setMenu] = useState<null | "root" | "charts">(null);
  const active = dashboards.find((item) => item.id === activeId) ?? null;

  useEffect(() => {
    if (menu === null) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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
    setMenu(null);
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
                Add a saved chart, start one from scratch, or add a filter other queries can use.
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
          <div className="mt-8 flex flex-col items-start gap-6">
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-label="Add content"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={() => setMenu((current) => (current === null ? "root" : null))}
                className="text-brand"
              >
                <Plus className="size-16" strokeWidth={1.5} />
              </button>
              {menu !== null && (
                <AddContentMenu
                  menu={menu}
                  charts={available}
                  onCharts={() => setMenu("charts")}
                  onBack={() => setMenu("root")}
                  onAddChart={(chartId) => {
                    remember(withChart(active, chartId, boardWidth(boardRef.current)));
                    setMenu(null);
                  }}
                  onMakeChart={() => {
                    const chart = freshDashboardChart(charts, connections[0]?.id);
                    storage.saveChart(chart);
                    setCharts(storage.getSavedCharts());
                    remember(withChart(active, chart.id, boardWidth(boardRef.current)));
                    setMenu(null);
                  }}
                  onText={() => {
                    remember(withNote(active));
                    setMenu(null);
                  }}
                  onFilter={() => {
                    remember(withFilter(active, connections[0]?.id));
                    setMenu(null);
                  }}
                />
              )}
            </div>
            <div ref={boardRef} className="flex w-full flex-col items-start gap-4">
              {(active.filters ?? []).map((filter) => (
                <DashboardFilterCard
                  key={filter.id}
                  filter={filter}
                  connections={connections}
                  onChange={(patch) => remember(withFilterFields(active, filter.id, patch))}
                  onRemove={() => remember(withoutFilter(active, filter.id))}
                />
              ))}
              {(active.notes ?? []).map((note) => (
                <DashboardNoteCard
                  key={note.id}
                  note={note}
                  onText={(text) => remember(withNoteText(active, note.id, text))}
                  onRemove={() => remember(withoutNote(active, note.id))}
                />
              ))}
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
                    filters={active.filters ?? []}
                    onRemove={() => remember(withoutChart(active, chart.id))}
                    onResize={(size) => remember(withFrame(active, chart.id, size))}
                    onQuery={(query) => {
                      storage.saveChart({ ...chart, query });
                      setCharts(storage.getSavedCharts());
                    }}
                    onLook={(look) => {
                      const next = { ...chart };
                      if (look === undefined) delete next.look;
                      else next.look = look;
                      storage.saveChart(next);
                      setCharts(storage.getSavedCharts());
                    }}
                    onShape={(patch) => {
                      storage.saveChart({ ...chart, ...patch });
                      setCharts(storage.getSavedCharts());
                    }}
                    onConnection={(connectionId) => {
                      const next = { ...chart };
                      if (connectionId === undefined) delete next.connectionId;
                      else next.connectionId = connectionId;
                      storage.saveChart(next);
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

function FaceButton({
  pressed,
  label,
  icon: Icon,
  onClick,
}: {
  readonly pressed: boolean;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md",
        pressed ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function DashboardChart({
  chart,
  width,
  height,
  connections,
  filters,
  onRemove,
  onResize,
  onQuery,
  onLook,
  onShape,
  onConnection,
  onUnsave,
}: {
  readonly chart: SavedChartConfig;
  readonly width: number;
  readonly height: number;
  readonly connections: readonly DatabaseConnection[];
  readonly filters: readonly DashboardFilter[];
  readonly onRemove: () => void;
  readonly onResize: (size: { width: number; height: number }) => void;
  readonly onQuery: (query: string) => void;
  readonly onLook: (look: Record<string, unknown> | undefined) => void;
  readonly onShape: (
    patch: Pick<SavedChartConfig, "chartType" | "typeId" | "variationId" | "selection" | "xAxis" | "yAxis">,
  ) => void;
  readonly onConnection: (connectionId: string | undefined) => void;
  readonly onUnsave: () => void;
}) {
  const theme = chartTheme(useEffectiveTheme());
  const [view, setView] = useState<SavedChartView | { kind: "loading" }>({ kind: "loading" });
  const [face, setFace] = useState<"chart" | "query" | "code">(() =>
    chart.query === undefined || chart.query === "" ? "query" : "chart",
  );
  const [pending, setPending] = useState<"unsave" | "remove" | null>(null);
  const query = queryWithDashboardFilters(chart.query ?? "", filters);
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
  const [sqlDraft, setSqlDraft] = useState(sql);
  const [seenSql, setSeenSql] = useState(sql);
  if (seenSql !== sql) {
    setSeenSql(sql);
    setSqlDraft(sql);
  }
  const queryFilters = readQueryFilters(sql);
  const metrics = view.kind === "result" ? classifyColumns(view.result.fields, view.result.rows).metrics : [];
  const filterLooks = mergeFilterLooks(defaultFilterLooks(queryFilters, metrics), readFilterLooks(chart.look));
  const shelf =
    view.kind === "result" && chart.typeId !== undefined && chart.variationId !== undefined
      ? buildChartOption({
          typeId: chart.typeId,
          variationId: chart.variationId,
          rows: view.result.rows,
          selection: chart.selection ?? {},
          title: "",
          theme,
        })
      : null;
  const storedLook = storedChartLook(chart.look);
  const code = useChartCode(
    shelf?.option ?? null,
    chart.typeId ?? null,
    chart.variationId ?? null,
    chart.selection ?? null,
    view.kind === "result" ? view.result : null,
    filterLooks,
    storedLook === undefined ? null : formatChartCode(storedLook),
  );
  const databaseType: DatabaseType | undefined = connections.find((item) => item.id === connectionId)?.type;
  const runDraft = () => {
    onQuery(sqlDraft);
    setFace("chart");
  };
  const onCodeChange = (text: string) => {
    code.onChange(text);
    const parsed = parseChartCode(text);
    if (!parsed.ok) return;
    onLook(storedChartLook(stripChartValues(parsed.option)));
  };

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
      {/*
        The name keeps its own width, up to the card. When that no longer fits
        beside the actions, the actions wrap onto the line below it.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4">
        <h2 className="min-w-[min(100%,max-content)] flex-1 break-words text-sm font-semibold text-fg">{chart.name}</h2>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-3">
          <div className="flex items-center rounded-lg border border-hairline bg-canvas p-0.5">
            <FaceButton pressed={face === "chart"} label="Chart" icon={BarChart3} onClick={() => setFace("chart")} />
            <FaceButton pressed={face === "query"} label="Query" icon={Terminal} onClick={() => setFace("query")} />
            <FaceButton pressed={face === "code"} label="Code" icon={Braces} onClick={() => setFace("code")} />
          </div>
          {face === "query" && (
            <button
              type="button"
              aria-label={`Run ${chart.name}`}
              onClick={runDraft}
              className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
            >
              Run
            </button>
          )}
          <button
            type="button"
            aria-label={`Unsave ${chart.name}`}
            title={`Unsave ${chart.name}`}
            aria-pressed="true"
            onClick={() => setPending((current) => (current === "unsave" ? null : "unsave"))}
            className="inline-flex size-7 items-center justify-center rounded-md bg-brand-solid text-white"
          >
            <Bookmark className="size-3.5 fill-current" aria-hidden="true" />
          </button>
          {pending === "unsave" && (
            <button
              type="button"
              aria-label={`Confirm unsave ${chart.name}`}
              onClick={onUnsave}
              className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
            >
              Confirm
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${chart.name}`}
            title={`Remove ${chart.name}`}
            aria-pressed={pending === "remove"}
            onClick={() => setPending((current) => (current === "remove" ? null : "remove"))}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md",
              pending === "remove" ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
            )}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
          {pending === "remove" && (
            <button
              type="button"
              aria-label={`Confirm remove ${chart.name}`}
              onClick={onRemove}
              className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
            >
              Confirm
            </button>
          )}
        </div>
      </div>
      {face === "chart" && queryFilters.length > 0 && (
        <QueryFilterBar
          filters={queryFilters}
          metrics={metrics}
          label={
            <>
              <ListFilter className="size-3.5" />
              Filter by
            </>
          }
          className="border-0 px-4 py-3"
          looks={filterLooks}
          clearClassName="border-0 bg-transparent px-1 font-medium text-brand hover:bg-transparent hover:underline"
          onChange={(name, value) =>
            onQuery(metrics.includes(name) ? writeMetricFilter(sql, name, value) : writeQueryFilter(sql, name, value))
          }
          onCompare={(name, compare) => onQuery(writeMetricCompare(sql, queryFilters, name, compare))}
          onClear={() => onQuery(clearQueryFilters(sql))}
        />
      )}
      <div className="min-h-0 flex-1">
        {face === "query" && (
          <div className="flex h-full min-h-0 flex-col">
            <label className="px-4 pt-3 text-xs text-fg-muted">
              Connection
              <select
                aria-label={`Connection for ${chart.name}`}
                value={connectionId ?? ""}
                onChange={(event) => onConnection(event.target.value === "" ? undefined : event.target.value)}
                className={`mt-1.5 ${fieldClass}`}
              >
                <option value="">Choose a connection</option>
                {connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="min-h-0 flex-1">
              <QueryEditor
                value={sqlDraft}
                documentId={chart.id}
                databaseType={databaseType}
                wordWrap
                onContentChange={setSqlDraft}
              />
            </div>
          </div>
        )}
        {face === "code" && (
          <ChartCodeEditor
            value={code.text}
            error={code.error}
            edited={code.edited || storedLook !== undefined}
            onChange={onCodeChange}
            onReset={() => {
              code.reset();
              onLook(undefined);
            }}
          />
        )}
        {face === "chart" && view.kind === "loading" && <p className="p-3 text-xs text-fg-muted">Running the query…</p>}
        {face === "chart" && view.kind === "empty" && <p className="p-3 text-xs text-fg-muted">{view.message}</p>}
        {face === "chart" && view.kind === "error" && (
          <p role="alert" className="p-3 text-xs text-danger">
            {view.message}
          </p>
        )}
        {face === "chart" && view.kind === "result" && missingShelves && (
          <ChartTypePicker result={view.result} onShape={onShape} />
        )}
        {face === "chart" && view.kind === "result" && !missingShelves && built === null && (
          <p className="p-3 text-xs text-fg-muted">Those columns do not have numbers to chart.</p>
        )}
        {face === "chart" && built !== null && <AssistChartCanvas option={built.option} notes={built.notes} />}
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

const ADD_ITEMS: readonly {
  id: "chart" | "make" | "text" | "filter";
  label: string;
  detail: string;
  icon: LucideIcon;
}[] = [
  { id: "chart", label: "Add chart", detail: "Choose from your saved charts", icon: BarChart3 },
  { id: "make", label: "Make a chart", detail: "Create a new chart from your data", icon: ChartColumn },
  { id: "text", label: "Text box", detail: "Add a title, note, or context", icon: Type },
  { id: "filter", label: "Component", detail: "Dropdown, slider, search, or custom", icon: ListFilter },
];

function AddContentMenu({
  menu,
  charts,
  onCharts,
  onBack,
  onAddChart,
  onMakeChart,
  onText,
  onFilter,
}: {
  readonly menu: "root" | "charts";
  readonly charts: readonly SavedChartConfig[];
  readonly onCharts: () => void;
  readonly onBack: () => void;
  readonly onAddChart: (chartId: string) => void;
  readonly onMakeChart: () => void;
  readonly onText: () => void;
  readonly onFilter: () => void;
}) {
  const choose = (id: (typeof ADD_ITEMS)[number]["id"]) => {
    if (id === "chart") onCharts();
    else if (id === "make") onMakeChart();
    else if (id === "text") onText();
    else onFilter();
  };
  return (
    <div
      role="menu"
      aria-label="Add content"
      className="absolute top-1/2 left-full z-20 ml-4 w-72 -translate-y-1/2 rounded-xl border border-hairline bg-raised shadow-lg"
    >
      <div className="border-b border-hairline px-4 py-3 text-sm font-semibold text-fg">Add content</div>
      {menu === "root" ? (
        <div className="flex flex-col gap-0.5 p-1.5">
          {ADD_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-label={item.label}
              onClick={() => choose(item.id)}
              className="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-brand-tint/15"
            >
              <MenuIcon icon={item.icon} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fg">{item.label}</span>
                <span className="block text-xs text-fg-muted">{item.detail}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-1.5">
          <button type="button" onClick={onBack} className="px-2 py-1.5 text-left text-xs font-medium text-brand">
            Back
          </button>
          {charts.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-muted">
              Save a chart from the editor or AI Assist, then add it here.
            </p>
          ) : (
            charts.map((chart) => (
              <button
                key={chart.id}
                type="button"
                role="menuitem"
                onClick={() => onAddChart(chart.id)}
                className="rounded-lg px-2 py-2 text-left text-sm text-fg hover:bg-brand-tint/15"
              >
                {chart.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChartTypePicker({
  result,
  onShape,
}: {
  readonly result: { fields: string[]; rows: Record<string, unknown>[] };
  readonly onShape: (
    patch: Pick<SavedChartConfig, "chartType" | "typeId" | "variationId" | "selection" | "xAxis" | "yAxis">,
  ) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 p-3">
      {ECHART_TYPES.map((type) => {
        const variationId = type.variations[0]?.id ?? type.id;
        return (
          <button
            key={type.id}
            type="button"
            aria-label={`Use ${type.label} chart`}
            onClick={() => {
              const columns = classifyColumns(result.fields, result.rows);
              const picked = defaultSelection(type.id, variationId, columns);
              const selection: Record<string, string[]> = {};
              for (const [slot, names] of Object.entries(picked)) selection[slot] = [...names];
              const axes = axesFromSelection(picked);
              onShape({
                chartType: type.id,
                typeId: type.id,
                variationId,
                selection,
                xAxis: axes.xAxis,
                yAxis: axes.yAxis,
              });
            }}
            className="rounded-lg bg-brand-tint/15 px-2.5 py-1 text-xs font-medium text-brand"
          >
            {type.label}
          </button>
        );
      })}
    </div>
  );
}

function DashboardNoteCard({
  note,
  onText,
  onRemove,
}: {
  readonly note: DashboardNote;
  readonly onText: (text: string) => void;
  readonly onRemove: () => void;
}) {
  return (
    <article className="w-full max-w-xl rounded-xl border border-hairline bg-raised p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">Text</h2>
        <button
          type="button"
          aria-label="Remove text"
          onClick={onRemove}
          className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:text-fg"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <textarea
        aria-label="Text box"
        value={note.text}
        placeholder="Add a title, note, or context"
        onChange={(event) => onText(event.target.value)}
        className="min-h-24 w-full resize-y rounded-lg border border-hairline-strong bg-canvas px-3 py-2 text-sm text-fg"
      />
    </article>
  );
}

function MenuIcon({ icon: Icon }: { readonly icon: LucideIcon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-tint/20 text-brand">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

const FILTER_CONTROLS: readonly {
  id: DashboardFilterControl;
  label: string;
  detail: string;
  icon: LucideIcon;
}[] = [
  { id: "select", label: "Dropdown", detail: "Choose from a list", icon: ListFilter },
  { id: "slider", label: "Slider", detail: "Pick a number in a range", icon: SlidersHorizontal },
  { id: "search", label: "Search", detail: "Text box for search", icon: Search },
  { id: "custom", label: "Custom", detail: "Start from scratch in JavaScript", icon: Braces },
];

function DashboardFilterCard({
  filter,
  connections,
  onChange,
  onRemove,
}: {
  readonly filter: DashboardFilter;
  readonly connections: readonly DatabaseConnection[];
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
  readonly onRemove: () => void;
}) {
  const [face, setFace] = useState<"filter" | "choices" | "design">(filter.control === undefined ? "design" : "filter");
  const [draft, setDraft] = useState(filter.query);
  const [seenQuery, setSeenQuery] = useState(filter.query);
  const [choices, setChoices] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  if (seenQuery !== filter.query) {
    setSeenQuery(filter.query);
    setDraft(filter.query);
  }
  const reference = filterReference(filter.name);
  const caption = filter.label?.trim() || filter.name || "Filter";

  useEffect(() => {
    const query = filter.query.trim();
    const connectionId = filter.connectionId;
    if (query === "" || connectionId === undefined || connectionId === "") return;
    let stopped = false;
    void loadSavedChart({ query, connectionId }, connections, appFetch).then((view) => {
      if (stopped) return;
      if (view.kind !== "result") {
        setChoices([]);
        setStatus(view.message);
        return;
      }
      const next = filterChoices(view.result.rows, view.result.fields);
      setChoices(next);
      setStatus(next.length === 0 ? "That query did not return any choices." : null);
    });
    return () => {
      stopped = true;
    };
  }, [connections, filter.connectionId, filter.query]);

  useEffect(() => {
    if (filter.control !== "custom") return;
    const onMessage = (event: MessageEvent) => {
      const next = filterFrameMessage(event.data);
      if (next === null || next.id !== filter.id || next.value === filter.value) return;
      onChange({ value: next.value });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [filter.control, filter.id, filter.value, onChange]);

  const runChoices = () => {
    onChange({ query: draft });
    if (draft.trim() === "" || filter.connectionId === undefined || filter.connectionId === "") {
      setChoices([]);
      setStatus("Add a connection and a query to fill the choices.");
    }
  };

  return (
    <article
      data-testid={`dashboard-filter-${filter.id}`}
      className="w-full max-w-xl rounded-xl border border-hairline bg-raised p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-fg">{caption}</h2>
        {filter.control !== undefined && (
          <div className="ml-auto flex items-center rounded-lg border border-hairline bg-canvas p-0.5">
            <FaceButton
              pressed={face === "filter"}
              label="Filter"
              icon={ListFilter}
              onClick={() => setFace("filter")}
            />
            <FaceButton
              pressed={face === "choices"}
              label="Choices"
              icon={Terminal}
              onClick={() => setFace("choices")}
            />
            <FaceButton pressed={face === "design"} label="Design" icon={Braces} onClick={() => setFace("design")} />
          </div>
        )}
        <button
          type="button"
          aria-label={`Remove ${filter.name} filter`}
          onClick={onRemove}
          className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:text-fg"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {filter.control === undefined || face === "design" ? (
        <FilterDesign
          filter={filter}
          reference={reference}
          onChange={onChange}
          onPick={(control) => setFace(control === "custom" ? "design" : "filter")}
        />
      ) : null}
      {filter.control !== undefined && face === "choices" && (
        <FilterChoices
          filter={filter}
          draft={draft}
          connections={connections}
          status={status}
          onDraft={setDraft}
          onChange={onChange}
          onRun={runChoices}
        />
      )}
      {filter.control !== undefined && face === "filter" && (
        <FilterSurface filter={filter} choices={choices} caption={caption} onChange={onChange} />
      )}
      {status !== null && face !== "choices" && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {status}
        </p>
      )}
    </article>
  );
}

function FilterDesign({
  filter,
  reference,
  onChange,
  onPick,
}: {
  readonly filter: DashboardFilter;
  readonly reference: string | null;
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
  readonly onPick: (control: DashboardFilterControl) => void;
}) {
  const slider = filterSlider(filter);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1">
        {FILTER_CONTROLS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter.control === item.id}
            aria-label={item.label}
            onClick={() => {
              onChange(filterControlPatch(item.id, filter));
              onPick(item.id);
            }}
            className={cn(
              "flex items-center gap-3 rounded-lg px-2 py-2 text-left",
              filter.control === item.id ? "bg-brand-tint/15" : "hover:bg-brand-tint/15",
            )}
          >
            <MenuIcon icon={item.icon} />
            <span>
              <span className="block text-sm font-medium text-fg">{item.label}</span>
              <span className="block text-xs text-fg-muted">{item.detail}</span>
            </span>
          </button>
        ))}
      </div>
      {filter.control !== undefined && (
        <>
          <label className="block text-xs text-fg-muted">
            Label
            <input
              aria-label="Filter label"
              value={filter.label ?? ""}
              onChange={(event) => onChange({ label: event.target.value })}
              className={`mt-1.5 ${fieldClass}`}
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Name
            <input
              aria-label="Filter name"
              value={filter.name}
              onChange={(event) => onChange({ name: event.target.value })}
              className={`mt-1.5 ${fieldClass}`}
            />
          </label>
          <p className="text-xs text-fg-muted">
            {reference === null
              ? "Use a name like region so a query can reference it."
              : `Reference this selection in a query as ${reference}.`}
          </p>
          {(filter.control === "search" || filter.control === "custom") && (
            <label className="block text-xs text-fg-muted">
              Placeholder
              <input
                aria-label="Filter placeholder"
                value={filter.placeholder ?? ""}
                onChange={(event) => onChange({ placeholder: event.target.value })}
                className={`mt-1.5 ${fieldClass}`}
              />
            </label>
          )}
          {filter.control === "slider" && (
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-fg-muted">
                Min
                <input
                  aria-label="Filter minimum"
                  value={String(slider.min)}
                  onChange={(event) => onChange({ min: Number(event.target.value) })}
                  className={`mt-1.5 ${fieldClass}`}
                />
              </label>
              <label className="text-xs text-fg-muted">
                Max
                <input
                  aria-label="Filter maximum"
                  value={String(slider.max)}
                  onChange={(event) => onChange({ max: Number(event.target.value) })}
                  className={`mt-1.5 ${fieldClass}`}
                />
              </label>
              <label className="text-xs text-fg-muted">
                Step
                <input
                  aria-label="Filter step"
                  value={String(slider.step)}
                  onChange={(event) => onChange({ step: Number(event.target.value) })}
                  className={`mt-1.5 ${fieldClass}`}
                />
              </label>
            </div>
          )}
          {filter.control === "custom" && (
            <div>
              <p className="mb-1.5 text-xs text-fg-muted">
                JavaScript can read value and choices, call setValue, and draw into #root.
              </p>
              <JsCodeEditor value={filter.script ?? CUSTOM_FILTER_SCRIPT} onChange={(script) => onChange({ script })} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterChoices({
  filter,
  draft,
  connections,
  status,
  onDraft,
  onChange,
  onRun,
}: {
  readonly filter: DashboardFilter;
  readonly draft: string;
  readonly connections: readonly DatabaseConnection[];
  readonly status: string | null;
  readonly onDraft: (value: string) => void;
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
  readonly onRun: () => void;
}) {
  return (
    <div>
      <label className="block text-xs text-fg-muted">
        Connection
        <select
          aria-label="Filter connection"
          value={filter.connectionId ?? ""}
          onChange={(event) => onChange({ connectionId: event.target.value === "" ? undefined : event.target.value })}
          className={`mt-1.5 ${fieldClass}`}
        >
          <option value="">Choose a connection</option>
          {connections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-3 block text-xs text-fg-muted">
        Choices query
        <textarea
          aria-label="Filter query"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          className="mt-1.5 min-h-20 w-full rounded-lg border border-hairline-strong bg-canvas px-2 py-1.5 font-mono text-xs text-fg"
        />
      </label>
      <button
        type="button"
        onClick={onRun}
        className="mt-2 rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
      >
        Run choices
      </button>
      {status !== null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {status}
        </p>
      )}
    </div>
  );
}

function FilterSurface({
  filter,
  choices,
  caption,
  onChange,
}: {
  readonly filter: DashboardFilter;
  readonly choices: readonly string[];
  readonly caption: string;
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
}) {
  if (filter.control === "slider") {
    const slider = filterSlider(filter);
    return (
      <label className="flex items-center gap-3 text-sm text-fg">
        {caption}
        <input
          type="range"
          aria-label="Filter slider"
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={slider.value}
          onChange={(event) => onChange({ value: event.target.value })}
          className="w-full"
        />
      </label>
    );
  }
  if (filter.control === "search") {
    return (
      <label className="block text-sm text-fg">
        {caption}
        <input
          type="search"
          aria-label="Filter search"
          value={filter.value}
          placeholder={filter.placeholder?.trim() || "Search"}
          onChange={(event) => onChange({ value: event.target.value })}
          className={`mt-1.5 ${fieldClass}`}
        />
      </label>
    );
  }
  if (filter.control === "custom") {
    return (
      <iframe
        title="Custom filter"
        sandbox="allow-scripts"
        srcDoc={filterFrameDocument(filter.id, filter.script ?? CUSTOM_FILTER_SCRIPT, filter.value, choices)}
        className="h-28 w-full rounded-lg border border-hairline bg-canvas"
      />
    );
  }
  const options = filter.value !== "" && !choices.includes(filter.value) ? [filter.value, ...choices] : choices;
  return (
    <label className="block text-sm text-fg">
      {caption}
      <select
        aria-label="Filter selection"
        value={filter.value}
        onChange={(event) => onChange({ value: event.target.value })}
        className={`mt-1.5 ${fieldClass}`}
      >
        <option value="">Choose</option>
        {options.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    </label>
  );
}
