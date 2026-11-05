"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BarChart3,
  Bold,
  Bookmark,
  Braces,
  ChartColumn,
  Italic,
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
import { IdeQueryChat } from "@/components/ai-assist/IdeQueryChat";
import { assistDatabaseType, loadAssistCatalog } from "@/lib/ai/assist-catalog";
import { loadAssistSchema } from "@/lib/ai/assist-schema";
import { JsCodeEditor } from "@/components/editor/JsCodeEditor";
import { ChartCodeEditor, useChartCode } from "@/components/charts/ChartCodeEditor";
import { QueryFilterBar } from "@/components/charts/QueryFilterBar";
import { QueryEditor } from "@/components/QueryEditor";
import { appFetch } from "@/lib/config/base-path";
import {
  blockFrameSize,
  dashboardAssistContext,
  dashboardName,
  dashboardVariables,
  DEFAULT_DASHBOARD_BLOCK_WIDTH,
  DEFAULT_DASHBOARD_FILTER_HEIGHT,
  DEFAULT_DASHBOARD_NOTE_HEIGHT,
  dragBlockResize,
  dragResize,
  CUSTOM_FILTER_SCRIPT,
  DASHBOARD_FRAME_CSP,
  DASHBOARD_INSTRUCTIONS_CAP,
  filterChoices,
  filterControlPatch,
  filterFrameDocument,
  filterFrameMessage,
  filterReference,
  filterSlider,
  filterValueList,
  freshDashboard,
  freshDashboardChart,
  insertQueryVariable,
  MIN_DASHBOARD_CHART_WIDTH,
  NOTE_FONT_SIZES,
  NOTE_FONTS,
  NOTE_SCRIPT,
  noteFrameDocument,
  noteLook,
  noteTextFromRows,
  placeSavedComponent,
  queryWithDashboardFilters,
  savedComponentFromFilter,
  withChart,
  withFilter,
  withFilterFields,
  withFrame,
  withInstructions,
  withName,
  withNote,
  withNoteFields,
  withNoteFrame,
  withNoteText,
  withoutChart,
  withoutFilter,
  withoutNote,
} from "@/lib/dashboards/dashboard";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { formatChartCode, parseChartCode, stripChartValues } from "@/lib/charts/chart-code";
import { omitDrawnChartTitle } from "@/lib/charts/chart-title";
import { classifyColumns, defaultSelection, echartType, ECHART_TYPES } from "@/lib/charts/echarts-catalog";
import { useChartSettings } from "@/components/charts/use-chart-settings";
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
import { restampThemeChrome } from "@/lib/charts/theme-chrome";
import { storage } from "@/lib/storage";
import type {
  DashboardFilter,
  DashboardFilterControl,
  DashboardNote,
  DashboardNoteStyle,
  DatabaseConnection,
  DatabaseType,
  SavedChartConfig,
  SavedDashboard,
  SavedDashboardComponent,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const CHART_GLYPH: Record<string, LucideIcon> = {
  line: LineChart,
  bar: BarChart3,
};

const fieldClass = "h-9 w-full rounded-lg border border-hairline-strong bg-canvas px-2 text-sm text-fg";
const miniClass = "h-8 rounded-lg border border-hairline-strong bg-canvas px-2 text-xs text-fg";

const NOTE_ALIGNS: readonly {
  readonly id: "left" | "center" | "right";
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { id: "left", label: "Align left", icon: AlignLeft },
  { id: "center", label: "Align center", icon: AlignCenter },
  { id: "right", label: "Align right", icon: AlignRight },
];

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
 * Each chart, text box, and component keeps the size the user dragged it to, and a
 * chart with a query can rerun that query on its own schedule. Ask AI reads the
 * board as a cell inventory and places a chart or a text box from the reply.
 * The IDE is the page that waits for a click.
 */
export function DashboardStudio() {
  const boardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>(() => storage.getSavedDashboards());
  const [activeId, setActiveId] = useState<string | null>(() => storage.getActiveDashboardId());
  const [charts, setCharts] = useState<SavedChartConfig[]>(() => storage.getSavedCharts());
  const [connections] = useState<DatabaseConnection[]>(() => storage.getConnections());
  const [menu, setMenu] = useState<null | "root" | "charts" | "components">(null);
  const [components, setComponents] = useState<SavedDashboardComponent[]>(() => storage.getSavedComponents());
  const [schemaContext, setSchemaContext] = useState("[]");
  const [mode, setMode] = useState<"editor" | "viewer">("editor");
  const editing = mode === "editor";
  const active = dashboards.find((item) => item.id === activeId) ?? null;

  useEffect(() => {
    if (connections.length === 0) return;
    void loadAssistCatalog(connections, (connection) =>
      loadAssistSchema(
        connection,
        storage.getDataDictionary(connection.id),
        appFetch,
        storage.getActiveCatalog(connection.id),
      ),
    ).then((loaded) => {
      setSchemaContext(loaded.schemaContext);
    });
  }, [connections]);

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

  const ensureDashboard = (): SavedDashboard => active ?? freshDashboard(dashboardName(dashboards));

  const placeAssistantReply = (reply: { sql: string | null; text: string }) => {
    const sql = reply.sql?.trim() ?? "";
    const text = reply.text.trim();
    if (sql === "" && text === "") return;
    let current = ensureDashboard();
    if (sql !== "") {
      const chart = freshDashboardChart(charts, connections[0]?.id);
      const saved = { ...chart, query: sql };
      storage.saveChart(saved);
      setCharts(storage.getSavedCharts());
      current = withChart(current, saved.id, boardWidth(boardRef.current));
    }
    if (text !== "") {
      const noted = withNote(current);
      const created = (noted.notes ?? [])[(noted.notes ?? []).length - 1];
      current = withNoteText(noted, created?.id ?? "", text);
    }
    remember(current);
    if (active === null) choose(current.id);
  };

  return (
    <>
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
          {editing && (
            <button
              type="button"
              onClick={create}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand"
            >
              <Plus className="size-3.5" />
              New dashboard
            </button>
          )}
          {editing && active !== null && (
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
                <label className="mt-4 block text-xs text-fg-muted">
                  Instructions for AI
                  <textarea
                    aria-label="Instructions for AI"
                    value={active.instructions ?? ""}
                    maxLength={DASHBOARD_INSTRUCTIONS_CAP}
                    rows={4}
                    placeholder="Only a rule an example query cannot say"
                    onChange={(event) => remember(withInstructions(active, event.target.value))}
                    className="mt-1.5 min-h-20 w-full rounded-lg border border-hairline-strong bg-canvas px-2 py-1.5 text-sm text-fg"
                  />
                </label>
                <p className="mt-1.5 text-xs text-fg-muted">
                  The charts on this board are the examples. Write a rule here only when an example cannot say it, such
                  as which date to assume or when to ask a follow-up.
                </p>
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
                  Add a saved chart, start one from scratch, or add a filter other queries can use. Save a component to
                  place it on another dashboard.
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
          <div className="flex w-full items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              {editing ? "Create" : (active?.name ?? "Dash")}
            </h1>
            {editing && active !== null && (
              <span className="rounded-full bg-brand-tint/15 px-2 py-0.5 text-xs font-medium text-brand">
                {active.name}
              </span>
            )}
            <fieldset
              aria-label="Dashboard mode"
              className="ml-auto m-0 flex min-w-0 items-center rounded-lg border border-hairline bg-control p-0.5"
            >
              <button
                type="button"
                aria-pressed={editing}
                onClick={() => setMode("editor")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  editing ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
                )}
              >
                Editor
              </button>
              <button
                type="button"
                aria-pressed={!editing}
                onClick={() => setMode("viewer")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  editing ? "text-fg-muted hover:text-fg" : "bg-brand-solid text-white",
                )}
              >
                Viewer
              </button>
            </fieldset>
          </div>
          {editing && (
            <p className="mt-1 text-sm text-fg-muted">
              Compile a dashboard from saved charts. Save more than one, and switch when you want a different view.
            </p>
          )}
          {dashboards.length === 0 ? (
            <p className="mt-6 text-sm text-fg-muted">You have no dashboards yet.</p>
          ) : active === null ? (
            <p className="mt-6 text-sm text-fg-muted">Choose a dashboard.</p>
          ) : (
            <div className={cn("flex flex-col items-start gap-6", editing ? "mt-8" : "mt-6")}>
              {editing && (
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
                      components={components}
                      onComponents={() => setMenu("components")}
                      onAddComponent={(component) => {
                        remember(placeSavedComponent(active, component));
                        setMenu(null);
                      }}
                    />
                  )}
                </div>
              )}
              <div ref={boardRef} className="flex w-full flex-col items-start gap-4">
                {(active.filters ?? []).map((filter) => {
                  const size = blockFrameSize(
                    filter.width ?? DEFAULT_DASHBOARD_BLOCK_WIDTH,
                    filter.height ?? DEFAULT_DASHBOARD_FILTER_HEIGHT,
                    window.innerWidth,
                  );
                  return (
                    <DashboardFilterCard
                      key={filter.id}
                      filter={filter}
                      width={size.width}
                      height={size.height}
                      viewing={!editing}
                      connections={connections}
                      onChange={(patch) => remember(withFilterFields(active, filter.id, patch))}
                      onResize={(next) => remember(withFilterFields(active, filter.id, next))}
                      onRemove={() => remember(withoutFilter(active, filter.id))}
                      onSave={() => {
                        const libraryId = filter.componentId ?? crypto.randomUUID();
                        storage.saveComponent(savedComponentFromFilter(filter, libraryId));
                        setComponents(storage.getSavedComponents());
                        if (filter.componentId !== libraryId) {
                          remember(withFilterFields(active, filter.id, { componentId: libraryId }));
                        }
                      }}
                      onUnsave={() => {
                        if (filter.componentId === undefined) return;
                        storage.deleteComponent(filter.componentId);
                        setComponents(storage.getSavedComponents());
                        setDashboards(storage.getSavedDashboards());
                      }}
                    />
                  );
                })}
                {(active.notes ?? []).map((note) => {
                  const size = blockFrameSize(
                    note.width ?? DEFAULT_DASHBOARD_BLOCK_WIDTH,
                    note.height ?? DEFAULT_DASHBOARD_NOTE_HEIGHT,
                    window.innerWidth,
                  );
                  return (
                    <DashboardNoteCard
                      key={note.id}
                      note={note}
                      width={size.width}
                      height={size.height}
                      viewing={!editing}
                      connections={connections}
                      filters={active.filters ?? []}
                      onChange={(patch) => remember(withNoteFields(active, note.id, patch))}
                      onRemove={() => remember(withoutNote(active, note.id))}
                      onResize={(next) => remember(withNoteFrame(active, note.id, next))}
                    />
                  );
                })}
                {placed.map((frame) => {
                  const chart = charts.find((item) => item.id === frame.chartId);
                  if (chart === undefined) return null;
                  return (
                    <DashboardChart
                      key={chart.id}
                      chart={chart}
                      width={frame.width}
                      height={frame.height}
                      viewing={!editing}
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
                      onTitle={(name) => {
                        storage.saveChart({ ...chart, name });
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
      {editing && (
        <IdeQueryChat
          placement="fixed"
          conversationLabel="Dashboard conversation"
          sql=""
          promptLabel="Ask about this dashboard"
          promptPlaceholder="Ask a question about this dashboard"
          databaseType={assistDatabaseType(connections.map((item) => item.type))}
          schemaContext={schemaContext}
          boardContext={dashboardAssistContext(
            active,
            charts,
            connections.map((item) => ({ id: item.id, name: item.name })),
          )}
          onPlaceReply={placeAssistantReply}
        />
      )}
    </>
  );
}

function VariableInsert({
  filters,
  onInsert,
}: {
  readonly filters: readonly DashboardFilter[];
  readonly onInsert: (token: string) => void;
}) {
  const variables = dashboardVariables(filters);
  return (
    <label className="block px-4 pt-3 text-xs text-fg-muted">
      Variable
      <select
        aria-label="Insert variable"
        value=""
        disabled={variables.length === 0}
        onChange={(event) => {
          if (event.target.value === "") return;
          onInsert(event.target.value);
        }}
        className={`mt-1.5 ${fieldClass}`}
      >
        <option value="">{variables.length === 0 ? "No variables on this dashboard" : "Insert an id"}</option>
        {variables.map((variable) => (
          <option key={variable.id} value={variable.token}>
            {variable.label} {variable.token}
          </option>
        ))}
      </select>
    </label>
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

function ResizeHandle({
  label,
  width,
  height,
  onResize,
  resize,
}: {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly onResize: (size: { width: number; height: number }) => void;
  readonly resize: (
    start: { width: number; height: number },
    dx: number,
    dy: number,
    maxWidth: number,
  ) => { width: number; height: number };
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.focus();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { width, height };
    const move = (ev: PointerEvent) => {
      onResize(resize(start, ev.clientX - startX, ev.clientY - startY, window.innerWidth));
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
    onResize(resize({ width, height }, next[0], next[1], window.innerWidth));
  };

  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute right-1 bottom-1 z-10 size-3 cursor-se-resize border-r-2 border-b-2 border-fg-muted"
    />
  );
}

function DashboardChart({
  chart,
  width,
  height,
  viewing,
  connections,
  filters,
  onRemove,
  onResize,
  onQuery,
  onLook,
  onShape,
  onConnection,
  onUnsave,
  onTitle,
}: {
  readonly chart: SavedChartConfig;
  readonly width: number;
  readonly height: number;
  readonly viewing: boolean;
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
  readonly onTitle: (name: string) => void;
}) {
  const theme = chartTheme(useEffectiveTheme());
  const settings = useChartSettings();
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

  const built = view.kind === "result" ? optionForSavedChart(chart, view.result, theme, settings) : null;
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
          settings,
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
  // The code the user is editing is the chart. A saved look is that code, so a
  // background they set — including transparent — is what gets drawn.
  const painted =
    code.option !== null && shelf !== null
      ? restampThemeChrome(omitDrawnChartTitle(code.option, shelf.option), theme)
      : (built?.option ?? null);
  const runDraft = () => {
    onQuery(sqlDraft);
    setFace("chart");
  };
  const shownFace = viewing ? "chart" : face;
  const onCodeChange = (text: string) => {
    code.onChange(text);
    const parsed = parseChartCode(text);
    if (!parsed.ok) return;
    onLook(storedChartLook(stripChartValues(parsed.option)));
  };

  return (
    <article
      data-testid={`dashboard-chart-${chart.id}`}
      style={{ width, height }}
      className="relative flex max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-transparent shadow-sm"
    >
      {/*
        The name keeps its own width, up to the card. When that no longer fits
        beside the actions, the actions wrap onto the line below it.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4">
        {viewing ? (
          <h2 className="min-w-[min(100%,max-content)] flex-1 break-words text-sm font-semibold text-fg">
            {chart.name}
          </h2>
        ) : (
          <input
            aria-label="Chart title"
            value={chart.name}
            onChange={(event) => onTitle(event.target.value)}
            className="min-w-[min(100%,max-content)] flex-1 break-words bg-transparent text-sm font-semibold text-fg outline-none"
          />
        )}
        {!viewing && (
          <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-3">
            <div className="flex items-center rounded-lg border border-hairline bg-control p-0.5">
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
        )}
      </div>
      {shownFace === "chart" && !viewing && queryFilters.length > 0 && (
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
      <div className="flex min-h-0 flex-1 flex-col">
        {shownFace === "chart" && view.kind === "result" && !viewing && (
          <ChartTypePicker
            result={view.result}
            typeId={chart.typeId ?? null}
            variationId={chart.variationId ?? null}
            onShape={onShape}
          />
        )}
        <div className="relative min-h-0 flex-1">
          {painted !== null && (
            <AssistChartCanvas option={painted} notes={code.option === null ? (built?.notes ?? []) : []} />
          )}
          {shownFace === "query" && (
            <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-canvas">
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
              <VariableInsert
                filters={filters}
                onInsert={(token) => setSqlDraft((current) => insertQueryVariable(current, token))}
              />
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
          {shownFace === "code" && (
            <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-canvas">
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
            </div>
          )}
          {shownFace === "chart" && view.kind === "loading" && (
            <p className="p-3 text-xs text-fg-muted">Running the query…</p>
          )}
          {shownFace === "chart" && view.kind === "empty" && (
            <p className="p-3 text-xs text-fg-muted">{view.message}</p>
          )}
          {shownFace === "chart" && view.kind === "error" && (
            <p role="alert" className="p-3 text-xs text-danger">
              {view.message}
            </p>
          )}
          {shownFace === "chart" && view.kind === "result" && missingShelves && viewing && (
            <p className="p-3 text-xs text-fg-muted">This chart is not ready to view.</p>
          )}
          {shownFace === "chart" && view.kind === "result" && !missingShelves && built === null && (
            <p className="p-3 text-xs text-fg-muted">Those columns do not have numbers to chart.</p>
          )}
        </div>
      </div>
      {!viewing && (
        <ResizeHandle
          label={`Resize ${chart.name}`}
          width={width}
          height={height}
          onResize={onResize}
          resize={dragResize}
        />
      )}
    </article>
  );
}

const ADD_ITEMS: readonly {
  id: "chart" | "make" | "text" | "filter" | "saved";
  label: string;
  detail: string;
  icon: LucideIcon;
}[] = [
  { id: "chart", label: "Add chart", detail: "Choose from your saved charts", icon: BarChart3 },
  { id: "make", label: "Make a chart", detail: "Create a new chart from your data", icon: ChartColumn },
  { id: "text", label: "Text box", detail: "Add a note or context", icon: Type },
  { id: "filter", label: "Component", detail: "Dropdown, slider, search, or custom", icon: ListFilter },
  { id: "saved", label: "Saved component", detail: "Place a component you saved", icon: Bookmark },
];

function AddContentMenu({
  menu,
  charts,
  components,
  onCharts,
  onComponents,
  onBack,
  onAddChart,
  onAddComponent,
  onMakeChart,
  onText,
  onFilter,
}: {
  readonly menu: "root" | "charts" | "components";
  readonly charts: readonly SavedChartConfig[];
  readonly components: readonly SavedDashboardComponent[];
  readonly onCharts: () => void;
  readonly onComponents: () => void;
  readonly onBack: () => void;
  readonly onAddChart: (chartId: string) => void;
  readonly onAddComponent: (component: SavedDashboardComponent) => void;
  readonly onMakeChart: () => void;
  readonly onText: () => void;
  readonly onFilter: () => void;
}) {
  const choose = (id: (typeof ADD_ITEMS)[number]["id"]) => {
    if (id === "chart") onCharts();
    else if (id === "make") onMakeChart();
    else if (id === "text") onText();
    else if (id === "saved") onComponents();
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
          {menu === "charts" ? (
            charts.length === 0 ? (
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
            )
          ) : components.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-muted">Save a component from a dashboard, then add it here.</p>
          ) : (
            components.map((component) => (
              <button
                key={component.id}
                type="button"
                role="menuitem"
                onClick={() => onAddComponent(component)}
                className="rounded-lg px-2 py-2 text-left text-sm text-fg hover:bg-brand-tint/15"
              >
                {component.name}
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
  typeId,
  variationId,
  onShape,
}: {
  readonly result: { fields: string[]; rows: Record<string, unknown>[] };
  readonly typeId: string | null;
  readonly variationId: string | null;
  readonly onShape: (
    patch: Pick<SavedChartConfig, "chartType" | "typeId" | "variationId" | "selection" | "xAxis" | "yAxis">,
  ) => void;
}) {
  const [browsing, setBrowsing] = useState<string | null>(null);
  const shownTypeId = browsing ?? typeId;
  const type = shownTypeId === null ? null : echartType(shownTypeId);
  const chooseVariation = (nextVariationId: string) => {
    if (type === null) return;
    if (type.id === typeId && nextVariationId === variationId) {
      setBrowsing(null);
      return;
    }
    const columns = classifyColumns(result.fields, result.rows);
    const picked = defaultSelection(type.id, nextVariationId, columns);
    const selection: Record<string, string[]> = {};
    for (const [slot, names] of Object.entries(picked)) selection[slot] = [...names];
    const axes = axesFromSelection(picked);
    onShape({
      chartType: type.id,
      typeId: type.id,
      variationId: nextVariationId,
      selection,
      xAxis: axes.xAxis,
      yAxis: axes.yAxis,
    });
    setBrowsing(null);
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <fieldset aria-label="Chart types" className="m-0 flex flex-wrap gap-2 border-0 p-0">
        {ECHART_TYPES.map((item) => {
          const pressed = shownTypeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={pressed}
              aria-label={`Use ${item.label} chart`}
              onClick={() => setBrowsing(item.id)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium",
                pressed ? "bg-brand-solid text-white" : "bg-brand-tint/15 text-brand",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </fieldset>
      {type !== null && (
        <fieldset aria-label="Chart variations" className="m-0 flex flex-wrap gap-2 border-0 p-0">
          {type.variations.map((item) => {
            const pressed = type.id === typeId && item.id === variationId;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={pressed}
                aria-label={`Use ${type.label} ${item.label} chart`}
                onClick={() => chooseVariation(item.id)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-medium",
                  pressed ? "bg-brand-solid text-white" : "bg-brand-tint/15 text-brand",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}

function noteTextStyle(look: ReturnType<typeof noteLook>): CSSProperties {
  return {
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    textAlign: look.align,
    fontWeight: look.bold ? 700 : 400,
    fontStyle: look.italic ? "italic" : "normal",
    ...(look.color !== undefined ? { color: look.color } : {}),
    ...(look.background !== undefined ? { backgroundColor: look.background } : {}),
  };
}

function NoteStyleBar({
  note,
  onChange,
}: {
  readonly note: DashboardNote;
  readonly onChange: (patch: Partial<DashboardNote>) => void;
}) {
  const look = noteLook(note.style);
  const sizes = NOTE_FONT_SIZES.includes(look.fontSize)
    ? NOTE_FONT_SIZES
    : [...NOTE_FONT_SIZES, look.fontSize].sort((left, right) => left - right);
  const setStyle = (patch: Partial<DashboardNoteStyle>) => onChange({ style: { ...note.style, ...patch } });
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
      <select
        aria-label="Text font"
        value={look.fontFamily}
        onChange={(event) => setStyle({ fontFamily: event.target.value })}
        className={miniClass}
      >
        {NOTE_FONTS.map((font) => (
          <option key={font.id} value={font.id}>
            {font.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Text size"
        value={String(look.fontSize)}
        onChange={(event) => setStyle({ fontSize: Number(event.target.value) })}
        className={`${miniClass} w-16`}
      >
        {sizes.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        Color
        <input
          type="color"
          value={look.color ?? "#111827"}
          onChange={(event) => setStyle({ color: event.target.value })}
          className="h-8 w-8 cursor-pointer rounded border border-hairline bg-canvas"
        />
      </label>
      {look.color !== undefined && (
        <button
          type="button"
          aria-label="Default text color"
          onClick={() => setStyle({ color: undefined })}
          className="text-xs text-fg-muted"
        >
          Default
        </button>
      )}
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        Background
        <input
          type="color"
          value={look.background ?? "#ffffff"}
          onChange={(event) => setStyle({ background: event.target.value })}
          className="h-8 w-8 cursor-pointer rounded border border-hairline bg-canvas"
        />
      </label>
      {look.background !== undefined && (
        <button
          type="button"
          aria-label="Default background"
          onClick={() => setStyle({ background: undefined })}
          className="text-xs text-fg-muted"
        >
          Default
        </button>
      )}
      <button
        type="button"
        aria-label="Bold"
        aria-pressed={look.bold}
        onClick={() => setStyle({ bold: !look.bold })}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md",
          look.bold ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
        )}
      >
        <Bold className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Italic"
        aria-pressed={look.italic}
        onClick={() => setStyle({ italic: !look.italic })}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md",
          look.italic ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
        )}
      >
        <Italic className="size-3.5" aria-hidden="true" />
      </button>
      {NOTE_ALIGNS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={look.align === item.id}
            onClick={() => setStyle({ align: item.id })}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md",
              look.align === item.id ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function NoteDraft({
  note,
  textStyle,
  onChange,
  fill,
}: {
  readonly note: DashboardNote;
  readonly textStyle: CSSProperties;
  readonly onChange: (patch: Partial<Pick<DashboardNote, "text">>) => void;
  readonly fill: boolean;
}) {
  return (
    <textarea
      aria-label="Text box"
      value={note.text}
      placeholder="Add a note or context"
      onChange={(event) => onChange({ text: event.target.value })}
      style={textStyle}
      className={
        fill
          ? "h-full w-full resize-none rounded-lg border border-hairline-strong bg-canvas px-3 py-2 text-fg"
          : "min-h-16 w-full flex-1 resize-none rounded-lg border border-hairline-strong bg-canvas px-3 py-2 text-fg"
      }
    />
  );
}

function NoteBody({
  note,
  face,
  view,
  query,
  connectionId,
  databaseType,
  filters,
  connections,
  draft,
  textStyle,
  look,
  viewing,
  onChange,
  onDraft,
}: {
  readonly note: DashboardNote;
  readonly face: "text" | "query" | "code";
  readonly view: SavedChartView | { kind: "loading" } | null;
  readonly query: string;
  readonly connectionId: string | undefined;
  readonly databaseType: DatabaseType | undefined;
  readonly filters: readonly DashboardFilter[];
  readonly connections: readonly DatabaseConnection[];
  readonly draft: string;
  readonly textStyle: CSSProperties;
  readonly look: ReturnType<typeof noteLook>;
  readonly viewing: boolean;
  readonly onChange: (
    patch: Partial<Pick<DashboardNote, "text" | "query" | "connectionId" | "style" | "script">>,
  ) => void;
  readonly onDraft: (value: string) => void;
}) {
  if (face === "query") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p className="text-xs text-fg-muted">The result of this query is the text. Include the words in the SQL.</p>
        <label className="mt-3 block text-xs text-fg-muted">
          Connection
          <select
            aria-label="Text connection"
            value={connectionId ?? ""}
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
        <VariableInsert filters={filters} onInsert={(token) => onDraft(insertQueryVariable(draft, token))} />
        <div className="mt-3 min-h-24 flex-1 overflow-hidden rounded-lg border border-hairline-strong">
          <QueryEditor
            value={draft}
            documentId={note.id}
            databaseType={databaseType}
            wordWrap
            onContentChange={onDraft}
          />
        </div>
      </div>
    );
  }
  if (face === "code") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <p className="mb-2 text-xs text-fg-muted">JavaScript can read text, rows, and fields, and draw into #root.</p>
        <JsCodeEditor value={note.script ?? NOTE_SCRIPT} onChange={(script) => onChange({ script })} />
      </div>
    );
  }
  if (query !== "" && (connectionId === undefined || connectionId === "")) {
    return <p className="text-xs text-fg-muted">Choose a connection for this text.</p>;
  }
  if (query !== "" && (view === null || view.kind === "loading")) {
    return <p className="text-xs text-fg-muted">Running the query…</p>;
  }
  if (query !== "" && view !== null && view.kind !== "loading" && view.kind !== "result") {
    return (
      <p role="alert" className="text-xs text-danger">
        {view.message}
      </p>
    );
  }
  const result = query !== "" && view?.kind === "result" ? view.result : null;
  const words = result !== null ? noteTextFromRows(result.rows, result.fields) : note.text;
  const script = note.script?.trim() ?? "";
  if (script !== "") {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        {result === null && !viewing ? (
          <NoteDraft note={note} textStyle={textStyle} onChange={onChange} fill={false} />
        ) : null}
        <iframe
          title="Text script"
          sandbox="allow-scripts"
          csp={DASHBOARD_FRAME_CSP}
          srcDoc={noteFrameDocument(script, words, result?.rows ?? [], result?.fields ?? [], look)}
          className="min-h-16 w-full flex-1 rounded-lg border border-hairline bg-canvas"
        />
      </div>
    );
  }
  if (result === null) {
    if (viewing) {
      if (note.text === "") return null;
      return <NoteResult text={note.text} style={textStyle} />;
    }
    return <NoteDraft note={note} textStyle={textStyle} onChange={onChange} fill />;
  }
  return <NoteResult text={words} style={textStyle} />;
}

function DashboardNoteCard({
  note,
  width,
  height,
  viewing,
  connections,
  filters,
  onChange,
  onRemove,
  onResize,
}: {
  readonly note: DashboardNote;
  readonly width: number;
  readonly height: number;
  readonly viewing: boolean;
  readonly connections: readonly DatabaseConnection[];
  readonly filters: readonly DashboardFilter[];
  readonly onChange: (
    patch: Partial<Pick<DashboardNote, "text" | "query" | "connectionId" | "style" | "script">>,
  ) => void;
  readonly onRemove: () => void;
  readonly onResize: (size: { width: number; height: number }) => void;
}) {
  const sql = note.query ?? "";
  const [face, setFace] = useState<"text" | "query" | "code">("text");
  const [draft, setDraft] = useState(sql);
  const [seen, setSeen] = useState(sql);
  const [settled, setSettled] = useState<{ readonly key: string; readonly view: SavedChartView } | null>(null);
  if (seen !== sql) {
    setSeen(sql);
    setDraft(sql);
  }
  const liveQuery = queryWithDashboardFilters(sql, filters);
  const connectionId = note.connectionId;
  const look = noteLook(note.style);
  const databaseType = connections.find((item) => item.id === connectionId)?.type;
  const viewKey = `${connectionId ?? ""}\0${liveQuery}`;
  const view =
    sql.trim() === "" || connectionId === undefined || connectionId === ""
      ? null
      : settled !== null && settled.key === viewKey
        ? settled.view
        : { kind: "loading" as const };

  useEffect(() => {
    if (liveQuery.trim() === "" || connectionId === undefined || connectionId === "") return;
    let stopped = false;
    const key = `${connectionId}\0${liveQuery}`;
    void loadSavedChart({ query: liveQuery, connectionId }, connections, appFetch).then((next) => {
      if (stopped) return;
      setSettled({ key, view: next });
    });
    return () => {
      stopped = true;
    };
  }, [connections, connectionId, liveQuery]);

  const query = sql.trim();
  const textStyle = noteTextStyle(look);
  const runDraft = () => {
    onChange({ query: draft });
    setFace("text");
  };

  return (
    <article
      style={{ width, height }}
      className="relative flex max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-raised shadow-sm"
    >
      {!viewing && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <div className="flex items-center rounded-lg border border-hairline bg-control p-0.5">
            <FaceButton pressed={face === "text"} label="Text" icon={Type} onClick={() => setFace("text")} />
            <FaceButton
              pressed={face === "query"}
              label="Text query"
              icon={Terminal}
              onClick={() => setFace("query")}
            />
            <FaceButton pressed={face === "code"} label="Text code" icon={Braces} onClick={() => setFace("code")} />
          </div>
          {face === "query" && (
            <button
              type="button"
              aria-label="Run text query"
              onClick={runDraft}
              className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
            >
              Run
            </button>
          )}
          <button
            type="button"
            aria-label="Remove text"
            onClick={onRemove}
            className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:text-fg"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {!viewing && face === "text" && <NoteStyleBar note={note} onChange={onChange} />}
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-4">
        <NoteBody
          note={note}
          face={viewing ? "text" : face}
          viewing={viewing}
          view={view}
          query={query}
          connectionId={connectionId}
          databaseType={databaseType}
          filters={filters}
          connections={connections}
          draft={draft}
          textStyle={textStyle}
          look={look}
          onChange={onChange}
          onDraft={setDraft}
        />
      </div>
      {!viewing && (
        <ResizeHandle
          label="Resize text box"
          width={width}
          height={height}
          onResize={onResize}
          resize={dragBlockResize}
        />
      )}
    </article>
  );
}

function NoteResult({ text, style }: { readonly text: string; readonly style: CSSProperties }) {
  if (text === "") return <p className="text-xs text-fg-muted">That query did not return any text.</p>;
  return (
    <div aria-label="Text box" style={style} className="whitespace-pre-wrap break-words text-fg">
      {text}
    </div>
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
  width,
  height,
  viewing,
  connections,
  onChange,
  onResize,
  onRemove,
  onSave,
  onUnsave,
}: {
  readonly filter: DashboardFilter;
  readonly width: number;
  readonly height: number;
  readonly viewing: boolean;
  readonly connections: readonly DatabaseConnection[];
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
  readonly onResize: (size: { width: number; height: number }) => void;
  readonly onRemove: () => void;
  readonly onSave: () => void;
  readonly onUnsave: () => void;
}) {
  const saved = filter.componentId !== undefined;
  const [pendingUnsave, setPendingUnsave] = useState(false);
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
  const listed = filter.choiceSource === "values" ? filterValueList(filter.valuesText ?? "") : null;
  const shownStatus = listed === null ? status : null;

  useEffect(() => {
    if (filter.choiceSource === "values") return;
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
  }, [connections, filter.choiceSource, filter.connectionId, filter.query]);

  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (filter.control !== "custom") return;
    const onMessage = (event: MessageEvent) => {
      // The text-box frame and any other window can post the same shape. Only this filter's frame may set its value.
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
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
      style={{ width, height }}
      className="relative flex max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-raised shadow-sm"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pt-4">
        {viewing ? (
          <h2 className="min-w-0 flex-1 break-words text-sm font-semibold text-fg">{caption}</h2>
        ) : (
          <input
            aria-label="Component title"
            value={caption}
            onChange={(event) => onChange({ label: event.target.value })}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-fg outline-none"
          />
        )}
        {!viewing && filter.control !== undefined && (
          <div className="ml-auto flex items-center rounded-lg border border-hairline bg-control p-0.5">
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
        {!viewing && (
          <button
            type="button"
            aria-label={saved ? `Unsave ${caption} component` : `Save ${caption} component`}
            title={saved ? `Unsave ${caption} component` : `Save ${caption} component`}
            aria-pressed={saved}
            onClick={() => {
              if (!saved) {
                onSave();
                return;
              }
              setPendingUnsave((current) => !current);
            }}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md",
              saved ? "bg-brand-solid text-white" : "text-fg-muted hover:text-fg",
            )}
          >
            <Bookmark className={cn("size-3.5", saved && "fill-current")} aria-hidden="true" />
          </button>
        )}
        {!viewing && saved && pendingUnsave && (
          <button
            type="button"
            aria-label={`Confirm unsave ${caption} component`}
            onClick={() => {
              setPendingUnsave(false);
              onUnsave();
            }}
            className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
          >
            Confirm
          </button>
        )}
        {!viewing && (
          <button
            type="button"
            aria-label={`Remove ${filter.name} filter`}
            onClick={onRemove}
            className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:text-fg"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-4">
        {!viewing && (filter.control === undefined || face === "design") ? (
          <FilterDesign filter={filter} reference={reference} onChange={onChange} />
        ) : null}
        {!viewing && filter.control !== undefined && face === "choices" && (
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
        {(viewing ? filter.control !== undefined : filter.control !== undefined && face === "filter") && (
          <FilterSurface filter={filter} choices={listed ?? choices} frameRef={frameRef} onChange={onChange} />
        )}
        {viewing && filter.control === undefined && (
          <p className="text-xs text-fg-muted">This filter is not ready to view.</p>
        )}
        {shownStatus !== null && (viewing || face !== "choices") && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {shownStatus}
          </p>
        )}
      </div>
      {!viewing && (
        <ResizeHandle
          label={`Resize ${caption}`}
          width={width}
          height={height}
          onResize={onResize}
          resize={dragBlockResize}
        />
      )}
    </article>
  );
}

function FilterDesign({
  filter,
  reference,
  onChange,
}: {
  readonly filter: DashboardFilter;
  readonly reference: string | null;
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
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
            onClick={() => onChange(filterControlPatch(item.id, filter))}
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
  const fromValues = filter.choiceSource === "values";
  const databaseType = connections.find((item) => item.id === filter.connectionId)?.type;
  return (
    <div>
      <div className="mb-3 flex items-center rounded-lg border border-hairline bg-control p-0.5">
        <button
          type="button"
          aria-pressed={!fromValues}
          onClick={() => onChange({ choiceSource: "query" })}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium",
            fromValues ? "text-fg-muted" : "bg-brand-solid text-white",
          )}
        >
          From a query
        </button>
        <button
          type="button"
          aria-pressed={fromValues}
          onClick={() => onChange({ choiceSource: "values" })}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium",
            fromValues ? "bg-brand-solid text-white" : "text-fg-muted",
          )}
        >
          Hardcoded values
        </button>
      </div>
      {fromValues ? (
        <label className="block text-xs text-fg-muted">
          One value per line
          <textarea
            aria-label="Value list"
            value={filter.valuesText ?? ""}
            onChange={(event) => onChange({ valuesText: event.target.value })}
            className="mt-1.5 min-h-20 w-full rounded-lg border border-hairline-strong bg-canvas px-2 py-1.5 font-mono text-xs text-fg"
          />
        </label>
      ) : (
        <>
          <label className="block text-xs text-fg-muted">
            Connection
            <select
              aria-label="Filter connection"
              value={filter.connectionId ?? ""}
              onChange={(event) =>
                onChange({ connectionId: event.target.value === "" ? undefined : event.target.value })
              }
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
          <div className="mt-3">
            <p className="text-xs text-fg-muted">Choices query</p>
            <div className="mt-1.5 h-40 overflow-hidden rounded-lg border border-hairline-strong">
              <QueryEditor
                value={draft}
                documentId={filter.id}
                databaseType={databaseType}
                wordWrap
                onContentChange={onDraft}
              />
            </div>
          </div>
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
        </>
      )}
    </div>
  );
}

function FilterSurface({
  filter,
  choices,
  frameRef,
  onChange,
}: {
  readonly filter: DashboardFilter;
  readonly choices: readonly string[];
  readonly frameRef: RefObject<HTMLIFrameElement | null>;
  readonly onChange: (patch: Partial<DashboardFilter>) => void;
}) {
  if (filter.control === "slider") {
    const slider = filterSlider(filter);
    return (
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
    );
  }
  if (filter.control === "search") {
    return (
      <input
        type="search"
        aria-label="Filter search"
        value={filter.value}
        placeholder={filter.placeholder?.trim() || "Search"}
        onChange={(event) => onChange({ value: event.target.value })}
        className={fieldClass}
      />
    );
  }
  if (filter.control === "custom") {
    return (
      <iframe
        ref={frameRef}
        title="Custom filter"
        sandbox="allow-scripts"
        csp={DASHBOARD_FRAME_CSP}
        srcDoc={filterFrameDocument(filter.id, filter.script ?? CUSTOM_FILTER_SCRIPT, filter.value, choices)}
        className="h-full min-h-28 w-full rounded-lg border border-hairline bg-canvas"
      />
    );
  }
  const options = filter.value !== "" && !choices.includes(filter.value) ? [filter.value, ...choices] : choices;
  return (
    <select
      aria-label="Filter selection"
      value={filter.value}
      onChange={(event) => onChange({ value: event.target.value })}
      className={fieldClass}
    >
      <option value="">Choose</option>
      {options.map((choice) => (
        <option key={choice} value={choice}>
          {choice}
        </option>
      ))}
    </select>
  );
}
