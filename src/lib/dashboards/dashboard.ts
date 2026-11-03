import { ASSIST_SCHEMA_CAP } from "@/lib/ai/assist-plan";
import { writeQueryFilter } from "@/lib/charts/query-filters";
import type {
  DashboardFilter,
  DashboardFilterControl,
  DashboardFilterDesign,
  DashboardNote,
  SavedChartConfig,
  SavedDashboard,
  SavedDashboardComponent,
} from "@/lib/types";

/** The script a new custom filter opens with. `value` and `choices` are in scope, and `setValue` publishes the selection. */
export const CUSTOM_FILTER_SCRIPT = [
  'const root = document.getElementById("root");',
  "if (root !== null) root.textContent = value;",
  "setValue(value);",
  "",
].join("\n");

export const DEFAULT_DASHBOARD_CHART_WIDTH = 480;
export const DEFAULT_DASHBOARD_CHART_HEIGHT = 320;
export const MIN_DASHBOARD_CHART_WIDTH = 280;
export const MIN_DASHBOARD_CHART_HEIGHT = 220;
export const MAX_DASHBOARD_CHART_HEIGHT = 900;

/** The size a new text box uses until the user drags it. */
export const DEFAULT_DASHBOARD_BLOCK_WIDTH = 576;
export const DEFAULT_DASHBOARD_NOTE_HEIGHT = 220;
/** The size a new component uses until the user drags it. */
export const DEFAULT_DASHBOARD_FILTER_HEIGHT = 420;
export const MIN_DASHBOARD_BLOCK_WIDTH = 240;
export const MIN_DASHBOARD_BLOCK_HEIGHT = 120;
export const MAX_DASHBOARD_BLOCK_HEIGHT = 900;

/** A width the chart may grow to when the board has not been measured yet. */
const UNMEASURED_MAX_WIDTH = 1600;

interface FrameBounds {
  minWidth: number;
  minHeight: number;
  maxHeight: number;
  fallbackWidth: number;
  fallbackHeight: number;
}

/**
 * A size that fits the board.
 * A width that is not a number, or a board that is narrower than the minimum, falls back
 * so a drag cannot collapse the frame or stretch it past the screen.
 */
function frameSize(
  width: number,
  height: number,
  maxWidth: number,
  bounds: FrameBounds,
): { width: number; height: number } {
  const cap = Number.isFinite(maxWidth) && maxWidth >= bounds.minWidth ? maxWidth : UNMEASURED_MAX_WIDTH;
  const nextWidth = Number.isFinite(width) ? Math.round(width) : bounds.fallbackWidth;
  const nextHeight = Number.isFinite(height) ? Math.round(height) : bounds.fallbackHeight;
  return {
    width: Math.min(cap, Math.max(bounds.minWidth, nextWidth)),
    height: Math.min(bounds.maxHeight, Math.max(bounds.minHeight, nextHeight)),
  };
}

const CHART_BOUNDS: FrameBounds = {
  minWidth: MIN_DASHBOARD_CHART_WIDTH,
  minHeight: MIN_DASHBOARD_CHART_HEIGHT,
  maxHeight: MAX_DASHBOARD_CHART_HEIGHT,
  fallbackWidth: MIN_DASHBOARD_CHART_WIDTH,
  fallbackHeight: MIN_DASHBOARD_CHART_HEIGHT,
};

const BLOCK_BOUNDS: FrameBounds = {
  minWidth: MIN_DASHBOARD_BLOCK_WIDTH,
  minHeight: MIN_DASHBOARD_BLOCK_HEIGHT,
  maxHeight: MAX_DASHBOARD_BLOCK_HEIGHT,
  fallbackWidth: DEFAULT_DASHBOARD_BLOCK_WIDTH,
  fallbackHeight: DEFAULT_DASHBOARD_NOTE_HEIGHT,
};

/** A chart size that fits the board. */
export function chartFrameSize(width: number, height: number, maxWidth: number): { width: number; height: number } {
  return frameSize(width, height, maxWidth, CHART_BOUNDS);
}

/** A text box or component size that fits the board. */
export function blockFrameSize(width: number, height: number, maxWidth: number): { width: number; height: number } {
  return frameSize(width, height, maxWidth, BLOCK_BOUNDS);
}

/** The size after a drag from `start` by `dx` and `dy` pixels. */
export function dragResize(
  start: { width: number; height: number },
  dx: number,
  dy: number,
  maxWidth: number,
): { width: number; height: number } {
  return chartFrameSize(start.width + dx, start.height + dy, maxWidth);
}

/** The text box or component size after a drag from `start` by `dx` and `dy` pixels. */
export function dragBlockResize(
  start: { width: number; height: number },
  dx: number,
  dy: number,
  maxWidth: number,
): { width: number; height: number } {
  return blockFrameSize(start.width + dx, start.height + dy, maxWidth);
}

/** The next "Dashboard N" that is not already used. */
export function dashboardName(existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((item) => item.name));
  let index = existing.length + 1;
  let name = `Dashboard ${index}`;
  while (taken.has(name)) {
    index += 1;
    name = `Dashboard ${index}`;
  }
  return name;
}

export function freshDashboard(name: string, id = crypto.randomUUID()): SavedDashboard {
  const now = new Date();
  return { id, name, charts: [], createdAt: now, updatedAt: now };
}

/** Adds the chart at a size that fits `maxWidth`, or returns the dashboard when it is already there. */
export function withChart(dashboard: SavedDashboard, chartId: string, maxWidth: number): SavedDashboard {
  if (dashboard.charts.some((item) => item.chartId === chartId)) return dashboard;
  const size = chartFrameSize(DEFAULT_DASHBOARD_CHART_WIDTH, DEFAULT_DASHBOARD_CHART_HEIGHT, maxWidth);
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: [...dashboard.charts, { chartId, width: size.width, height: size.height }],
  };
}

export function withoutChart(dashboard: SavedDashboard, chartId: string): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: dashboard.charts.filter((item) => item.chartId !== chartId),
  };
}

export function withFrame(
  dashboard: SavedDashboard,
  chartId: string,
  size: { width: number; height: number },
): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    charts: dashboard.charts.map((item) => (item.chartId === chartId ? { ...item, ...size } : item)),
  };
}

export function withName(dashboard: SavedDashboard, name: string): SavedDashboard {
  return { ...dashboard, name, updatedAt: new Date() };
}

const FILTER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const CHOICE_CAP = 24;

function nextLabel(existing: readonly { name: string }[], base: string, gap: string): string {
  const taken = new Set(existing.map((item) => item.name));
  if (!taken.has(base)) return base;
  let index = 2;
  let name = `${base}${gap}${index}`;
  while (taken.has(name)) {
    index += 1;
    name = `${base}${gap}${index}`;
  }
  return name;
}

/** The next "Chart" or "Chart N" that is not already used. */
export function chartLabel(existing: readonly { name: string }[]): string {
  return nextLabel(existing, "Chart", " ");
}

/** The next `filter` or `filterN` that is a placeholder name and is not already used. */
export function filterLabel(existing: readonly { name: string }[]): string {
  return nextLabel(existing, "filter", "");
}

/** A saved chart with an empty query, ready for the user to write one. */
export function freshDashboardChart(
  existing: readonly { name: string }[],
  connectionId?: string,
  id = crypto.randomUUID(),
): SavedChartConfig {
  return {
    id,
    name: chartLabel(existing),
    chartType: "bar",
    xAxis: "",
    yAxis: [],
    query: "",
    createdAt: new Date(),
    ...(connectionId !== undefined && connectionId !== "" ? { connectionId } : {}),
  };
}

export function withNote(dashboard: SavedDashboard, id = crypto.randomUUID()): SavedDashboard {
  const note: DashboardNote = { id, text: "" };
  return { ...dashboard, updatedAt: new Date(), notes: [...(dashboard.notes ?? []), note] };
}

export function withoutNote(dashboard: SavedDashboard, id: string): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    notes: (dashboard.notes ?? []).filter((item) => item.id !== id),
  };
}

export function withNoteText(dashboard: SavedDashboard, id: string, text: string): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    notes: (dashboard.notes ?? []).map((item) => (item.id === id ? { ...item, text } : item)),
  };
}

export function withNoteFrame(
  dashboard: SavedDashboard,
  id: string,
  size: { width: number; height: number },
): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    notes: (dashboard.notes ?? []).map((item) => (item.id === id ? { ...item, ...size } : item)),
  };
}

/** The query the dashboard assistant revises: the latest chart that is still saved. */
export function dashboardEditorSql(
  dashboard: SavedDashboard | null,
  charts: readonly { id: string; query?: string }[],
): string {
  if (dashboard === null) return "";
  for (let index = dashboard.charts.length - 1; index >= 0; index -= 1) {
    const frame = dashboard.charts[index];
    const chart = charts.find((item) => item.id === frame?.chartId);
    if (chart === undefined) continue;
    return chart.query ?? "";
  }
  return "";
}

/** Charts, text, and components on the board, so the assistant can see what is already there. */
export function dashboardAssistContext(
  dashboard: SavedDashboard,
  charts: readonly { id: string; name: string; query?: string }[],
): string {
  const lines = [`Dashboard: ${dashboard.name}`];
  for (const frame of dashboard.charts) {
    const chart = charts.find((item) => item.id === frame.chartId);
    if (chart === undefined) continue;
    const query = chart.query?.trim() ?? "";
    lines.push(`Chart ${chart.name}: ${query === "" ? "(no query)" : query}`);
  }
  for (const note of dashboard.notes ?? []) {
    const text = note.text.trim();
    if (text !== "") lines.push(`Text: ${text}`);
  }
  for (const filter of dashboard.filters ?? []) {
    const label = filter.label?.trim() || filter.name.trim() || "Component";
    lines.push(`Component ${label} (${filter.control ?? "unset"}) = ${filter.value}`);
  }
  return lines.join("\n");
}

/** The schema text plus the board, kept inside the size a question allows. */
export function schemaWithDashboard(schemaContext: string, board: string): string {
  const trimmed = board.trim();
  if (trimmed === "") return schemaContext;
  const extra = `\n\nDashboard:\n${trimmed}`;
  const room = ASSIST_SCHEMA_CAP - schemaContext.length;
  if (room <= 0) return schemaContext;
  if (extra.length <= room) return schemaContext + extra;
  return schemaContext + extra.slice(0, room);
}

export function withFilter(dashboard: SavedDashboard, connectionId?: string, id = crypto.randomUUID()): SavedDashboard {
  const filters = dashboard.filters ?? [];
  const filter: DashboardFilter = {
    id,
    name: filterLabel(filters),
    query: "",
    value: "",
    ...(connectionId !== undefined && connectionId !== "" ? { connectionId } : {}),
  };
  return { ...dashboard, updatedAt: new Date(), filters: [...filters, filter] };
}

export function withoutFilter(dashboard: SavedDashboard, id: string): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    filters: (dashboard.filters ?? []).filter((item) => item.id !== id),
  };
}

export function withFilterFields(
  dashboard: SavedDashboard,
  id: string,
  patch: Partial<DashboardFilter>,
): SavedDashboard {
  return {
    ...dashboard,
    updatedAt: new Date(),
    filters: (dashboard.filters ?? []).map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

/** `{{name}}` when `name` can be a query placeholder, otherwise null. */
export function filterReference(name: string): string | null {
  const trimmed = name.trim();
  return FILTER_NAME.test(trimmed) ? `{{${trimmed}}}` : null;
}

/** One dashboard variable a query can insert. `token` is the id the filter gives the query. */
export interface DashboardVariable {
  id: string;
  label: string;
  token: string;
}

/** Variables on this dashboard whose names are query ids. `exceptId` is the filter being edited. */
export function dashboardVariables(filters: readonly DashboardFilter[], exceptId?: string): DashboardVariable[] {
  const variables: DashboardVariable[] = [];
  for (const filter of filters) {
    if (filter.id === exceptId) continue;
    const token = filterReference(filter.name);
    if (token === null) continue;
    variables.push({ id: filter.id, label: filter.label?.trim() || filter.name, token });
  }
  return variables;
}

/** The query with `token` written at the end, or the token alone when the query is blank. */
export function insertQueryVariable(sql: string, token: string): string {
  if (sql.trim() === "") return token;
  return `${sql}${/\s$/.test(sql) ? "" : " "}${token}`;
}

/** The library record for a filter. The placement id and the library link stay off the design. */
export function savedComponentFromFilter(filter: DashboardFilter, id: string): SavedDashboardComponent {
  const design: DashboardFilterDesign = { name: filter.name, query: filter.query, value: filter.value };
  if (filter.label !== undefined) design.label = filter.label;
  if (filter.placeholder !== undefined) design.placeholder = filter.placeholder;
  if (filter.connectionId !== undefined) design.connectionId = filter.connectionId;
  if (filter.control !== undefined) design.control = filter.control;
  if (filter.min !== undefined) design.min = filter.min;
  if (filter.max !== undefined) design.max = filter.max;
  if (filter.step !== undefined) design.step = filter.step;
  if (filter.choiceSource !== undefined) design.choiceSource = filter.choiceSource;
  if (filter.valuesText !== undefined) design.valuesText = filter.valuesText;
  if (filter.script !== undefined) design.script = filter.script;
  return {
    id,
    name: filter.label?.trim() || filter.name.trim() || "Component",
    createdAt: new Date(),
    filter: design,
  };
}

/** Places a saved component on a dashboard. A name already used there gets the next free one. */
export function placeSavedComponent(
  dashboard: SavedDashboard,
  component: SavedDashboardComponent,
  id = crypto.randomUUID(),
): SavedDashboard {
  const filters = dashboard.filters ?? [];
  const filter: DashboardFilter = {
    ...component.filter,
    id,
    name: nextLabel(filters, component.filter.name.trim() || "filter", ""),
    componentId: component.id,
  };
  return { ...dashboard, updatedAt: new Date(), filters: [...filters, filter] };
}

function choiceText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? null : text.slice(0, 80);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

/** Distinct non-empty lines, in order. A hardcoded choice list uses this instead of a query. */
export function filterValueList(text: string): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim().slice(0, 80);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    choices.push(value);
    if (choices.length === CHOICE_CAP) break;
  }
  return choices;
}

/** Distinct values of the first column, in the order they appear. */
export function filterChoices(rows: readonly Record<string, unknown>[], fields: readonly string[]): string[] {
  const field = fields[0];
  if (field === undefined || field === "") return [];
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const row of rows) {
    const text = choiceText(row[field]);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    choices.push(text);
    if (choices.length === CHOICE_CAP) break;
  }
  return choices;
}

/** The numbers a slider can use. A missing bound falls back, and the max stays above the min. */
export function filterSlider(filter: Pick<DashboardFilter, "min" | "max" | "step" | "value">): {
  min: number;
  max: number;
  step: number;
  value: string;
} {
  const min = typeof filter.min === "number" && Number.isFinite(filter.min) ? filter.min : 0;
  let max = typeof filter.max === "number" && Number.isFinite(filter.max) ? filter.max : 100;
  if (!(max > min)) max = min + 100;
  const step = typeof filter.step === "number" && Number.isFinite(filter.step) && filter.step > 0 ? filter.step : 1;
  const current = Number(filter.value);
  return { min, max, step, value: Number.isFinite(current) ? String(current) : String(min) };
}

/** The document a custom filter runs in a sandboxed frame. The script can call `setValue` and draw into `#root`. */
export function filterFrameDocument(id: string, script: string, value: string, choices: readonly string[]): string {
  const host = JSON.stringify({ id, value, choices }).replace(/</g, "\\u003c");
  const source = script.replace(/<\/script/gi, "<\\/script");
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
    '<div id="root"></div>',
    `<script>const host = ${host};const value = host.value;const choices = host.choices;`,
    'function setValue(next){parent.postMessage({source:"libredb-filter",id:host.id,value:next==null?"":String(next)},"*");}',
    "</script>",
    `<script>${source}</script>`,
    "</body></html>",
  ].join("");
}

/** The selection a custom filter published, or null when the message is not one of ours. */
export function filterFrameMessage(data: unknown): { id: string; value: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const source = "source" in data ? data.source : undefined;
  const id = "id" in data ? data.id : undefined;
  const value = "value" in data ? data.value : undefined;
  if (source !== "libredb-filter" || typeof id !== "string" || id === "" || typeof value !== "string") return null;
  return { id, value };
}

/** Fields stored when the user picks a control. A slider starts at 0 to 100. */
export function filterControlPatch(
  control: DashboardFilterControl,
  filter: Pick<DashboardFilter, "script" | "value">,
): Partial<DashboardFilter> {
  if (control === "slider") {
    const slider = filterSlider(filter);
    return { control, min: slider.min, max: slider.max, step: slider.step, value: slider.value };
  }
  if (control === "custom" && (filter.script === undefined || filter.script.trim() === "")) {
    return { control, script: CUSTOM_FILTER_SCRIPT };
  }
  return { control };
}

/**
 * The statement a chart runs, with each dashboard filter written into the placeholder
 * of the same name. A filter with no selection leaves the query's own default.
 */
export function queryWithDashboardFilters(
  sql: string,
  filters: readonly Pick<DashboardFilter, "name" | "value">[],
): string {
  return filters.reduce((current, filter) => {
    if (filterReference(filter.name) === null || filter.value.trim() === "") return current;
    return writeQueryFilter(current, filter.name.trim(), filter.value);
  }, sql);
}
