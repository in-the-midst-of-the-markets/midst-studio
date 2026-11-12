import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { UserPayload } from "@/lib/auth";
import { assertReadOnlyStatementIsBounded } from "@/lib/db/providers/sql/duckdb";
import { isDuckDbConnectionType } from "@/lib/db/providers/sql/duckdb/connection-type";
import {
  CUSTOM_FILTER_SCRIPT,
  DEFAULT_DASHBOARD_BLOCK_WIDTH,
  DEFAULT_DASHBOARD_FILTER_HEIGHT,
  freshDashboard,
  withChart,
} from "@/lib/dashboards/dashboard";
import { chartPublicId, filterPublicId } from "@/lib/dashboards/public-id";
import { writeShareTables, type ShareSheet } from "@/lib/dashboards/share-file";
import { ShareError } from "@/lib/dashboards/share-limits";
import {
  planDashboardShare,
  shareRefreshSeconds,
  sourceForFields,
  withSnapshotQueries,
  type SharePlan,
} from "@/lib/dashboards/share-plan";
import { newShareId, readShare, writeShare, type ShareRecord } from "@/lib/dashboards/share-record";
import { runShareSource } from "@/lib/dashboards/share-source";
import { readMcpUrl, type McpSetting } from "@/lib/mcp/config";
import { queryEventRequest } from "@/lib/query-events/route-events";
import { CROSS_DB_JOINS_ID } from "@/lib/saved-join/connection";
import { sourceReadRefusal } from "@/lib/saved-join/source-guard";
import { savedQueryTableIdError } from "@/lib/saved-query-id";
import { readsSqlText } from "@/lib/sql/grammar";
import { SeedConnectionError, resolveConnection } from "@/lib/seed/resolve-connection";
import { getStorageProvider } from "@/lib/storage/factory";
import { storageOwnerKey } from "@/lib/storage/owner-key";
import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";
import type {
  DashboardFilter,
  DashboardFilterControl,
  DashboardNote,
  DatabaseConnection,
  DatabaseType,
  SavedChartConfig,
  SavedDashboard,
  SavedQuery,
} from "@/lib/types";
import { newMcpCorrelationId, recordMcpDecision, type McpCallRecord, type McpToolAuditReason } from "../audit";
import type { McpConnectionContext, McpToolCall } from "../context";
import { MCP_CANCELLED_TEXT, ownWordsError, plainResult, recordOrRefuse, type ToolResult } from "../output";

/**
 * The tools that write this account's studio, beside the read-only database tools.
 *
 * Each one files its change under the token's storage owner. Server storage has to be
 * on: a browser-only deployment keeps dashboards in that browser, where this server
 * cannot reach them. SQL is one read. JavaScript is stored for the sandboxed frame
 * and is not run here. A share link is the same snapshot the dashboard page publishes.
 */

export const AUTHORING_TOOLS = [
  "write_duckdb_query",
  "create_dashboard",
  "edit_dashboard_code",
  "create_dashboard_filter",
  "share_dashboard",
] as const;

export type McpAuthoringTool = (typeof AUTHORING_TOOLS)[number];

const SQL_CAP = 8_000;
const SCRIPT_CAP = 8_000;
const NAME_CAP = 120;

export const WORKSPACE_UNAVAILABLE =
  "Server storage is off, so this account's queries and dashboards are not on the server. An operator sets STORAGE_PROVIDER to sqlite or postgres.";

const STORAGE_UNREADABLE = "This account's saved queries and dashboards could not be read.";

const MCP_AUTHORING_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false } as const;

export const WRITE_DUCKDB_QUERY_DESCRIPTION =
  "Write one read-only DuckDB statement and save it on this account. Use it for a saved join, a vector rank, a vector join, a recursive walk, or pagerank on Cross_DB_Joins. No writes and no files. Pass query_id to replace a DuckDB query this account already saved. Server storage has to be on.";

export const CREATE_DASHBOARD_DESCRIPTION =
  "Create a dashboard on this account. Pass sql to place one chart that runs that read. Pass note_script to place a JavaScript note, and note_sql when that note reads a query. connection_id is the connection the statement reads. Server storage has to be on.";

export const EDIT_DASHBOARD_CODE_DESCRIPTION =
  "Edit the SQL or JavaScript on a chart, a note, or a filter of a dashboard this account owns. sql replaces the query and has to be one read. script replaces the JavaScript on a note or a custom filter. A chart has SQL only. The JavaScript is stored and runs later in the dashboard's sandboxed frame. Server storage has to be on.";

export const CREATE_DASHBOARD_FILTER_DESCRIPTION =
  "Add an interactive filter to a dashboard this account owns. name is the id a query writes as {{name}}: a letter or underscore, then letters, digits and underscores, at most 40 characters. control is select, slider, search or custom. A select can take a query or values, one choice per line. A custom filter takes script. Charts that contain {{name}} update when the value changes. Server storage has to be on.";

export const SHARE_DASHBOARD_DESCRIPTION =
  "Copy a dashboard this account owns into a snapshot and return the share link. The link does not include database credentials. A filter written as a column comparison stays interactive on the shared page. Server storage has to be on.";

const WriteDuckdbQueryInputSchema = z.object({
  name: z.string().trim().min(1).max(NAME_CAP),
  sql: z.string().trim().min(1).max(SQL_CAP),
  query_id: z.string().trim().min(1).max(80).optional(),
  table_id: z.string().trim().min(1).max(128).optional(),
});

const CreateDashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(NAME_CAP),
  sql: z.string().trim().min(1).max(SQL_CAP).optional(),
  chart_name: z.string().trim().min(1).max(NAME_CAP).optional(),
  connection_id: z.string().trim().min(1).max(200).optional(),
  note_text: z.string().max(2_000).optional(),
  note_script: z.string().max(SCRIPT_CAP).optional(),
  note_sql: z.string().trim().min(1).max(SQL_CAP).optional(),
});

const EditDashboardCodeInputSchema = z
  .object({
    dashboard_id: z.string().trim().min(1).max(80),
    kind: z.enum(["chart", "note", "filter"]),
    id: z.string().trim().min(1).max(80),
    sql: z.string().trim().min(1).max(SQL_CAP).optional(),
    script: z.string().min(1).max(SCRIPT_CAP).optional(),
  })
  .refine((value) => value.sql !== undefined || value.script !== undefined, {
    message: "Provide sql or script.",
  });

const CreateDashboardFilterInputSchema = z.object({
  dashboard_id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(NAME_CAP).optional(),
  control: z.enum(["select", "slider", "search", "custom"]).optional(),
  query: z.string().trim().min(1).max(SQL_CAP).optional(),
  values: z.string().max(4_000).optional(),
  connection_id: z.string().trim().min(1).max(200).optional(),
  value: z.string().max(200).optional(),
  script: z.string().min(1).max(SCRIPT_CAP).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
});

const ShareDashboardInputSchema = z.object({
  dashboard_id: z.string().trim().min(1).max(80),
});

export const AUTHORING_INPUT_SCHEMAS = {
  write_duckdb_query: WriteDuckdbQueryInputSchema,
  create_dashboard: CreateDashboardInputSchema,
  edit_dashboard_code: EditDashboardCodeInputSchema,
  create_dashboard_filter: CreateDashboardFilterInputSchema,
  share_dashboard: ShareDashboardInputSchema,
} as const;

const FILTER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

interface AccountLists {
  readonly queries: SavedQuery[];
  readonly charts: SavedChartConfig[];
  readonly dashboards: SavedDashboard[];
  readonly connections: DatabaseConnection[];
}

type Refusal = { readonly ok: false; readonly reason: McpToolAuditReason; readonly text: string };

export interface ShareDeps {
  resolve(
    body: { connection?: DatabaseConnection; connectionId?: string },
    session: UserPayload,
  ): Promise<DatabaseConnection>;
  runSource(
    session: UserPayload,
    connection: DatabaseConnection,
    sql: string,
    label: string,
    signal: AbortSignal,
  ): Promise<{ fields: string[]; rows: Record<string, unknown>[] }>;
  writeTables(id: string, sheets: readonly ShareSheet[]): Promise<void>;
  writeRecord(record: ShareRecord): void;
  readRecord(id: string): ShareRecord | null;
  newId(): string;
  mcpUrl(): McpSetting<string>;
  plan(
    dashboard: SavedDashboard,
    charts: readonly SavedChartConfig[],
    connections: readonly Pick<DatabaseConnection, "id" | "type">[],
  ): SharePlan | string;
}

interface Ready {
  readonly owner: string;
  readonly account: AccountLists;
  readonly provider: ServerStorageProvider;
}

function sessionOf(caller: McpToolCall["context"]["caller"]): UserPayload {
  return { username: caller.username, role: caller.role };
}

function ownerOf(caller: McpToolCall["context"]["caller"]): string | Refusal {
  try {
    return storageOwnerKey(sessionOf(caller));
  } catch (error) {
    const text = error instanceof Error ? error.message : STORAGE_UNREADABLE;
    return { ok: false, reason: "mcp_workspace_unavailable", text };
  }
}

async function readList<T>(
  provider: ServerStorageProvider,
  owner: string,
  collection: StorageCollection,
): Promise<T[] | "bad"> {
  const value = await provider.getCollection(owner, collection);
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]) : "bad";
}

async function loadAccount(provider: ServerStorageProvider, owner: string): Promise<AccountLists | Refusal> {
  try {
    const queries = await readList<SavedQuery>(provider, owner, "saved_queries");
    const charts = await readList<SavedChartConfig>(provider, owner, "saved_charts");
    const dashboards = await readList<SavedDashboard>(provider, owner, "saved_dashboards");
    const connections = await readList<DatabaseConnection>(provider, owner, "connections");
    if (queries === "bad" || charts === "bad" || dashboards === "bad" || connections === "bad") {
      return { ok: false, reason: "mcp_workspace_unavailable", text: STORAGE_UNREADABLE };
    }
    return { queries, charts, dashboards, connections };
  } catch {
    return { ok: false, reason: "mcp_workspace_unavailable", text: STORAGE_UNREADABLE };
  }
}

function isRefusal(value: object): value is Refusal {
  return "ok" in value && value.ok === false;
}

function readableRefusal(sql: string, type: DatabaseType): string | null {
  const refused = sourceReadRefusal(type, sql);
  if (refused === null) return null;
  if (refused.startsWith("A saved query in a join has to be a read")) return "The SQL has to be a read.";
  if (refused.startsWith("A saved query in a join has to be one statement")) return "The SQL has to be one statement.";
  if (refused.startsWith("A saved query in a join cannot include a comment")) {
    return "The SQL cannot include a comment the database executes.";
  }
  return refused;
}

function fileReadRefusal(sql: string): string | null {
  try {
    assertReadOnlyStatementIsBounded(sql);
  } catch (error) {
    return error instanceof Error ? error.message : "The SQL was refused.";
  }
  return null;
}

/** A DuckDB read, including the file-reading names a read-only handle does not itself refuse. */
function duckdbReadRefusal(sql: string): string | null {
  return statementRefusal(sql, "duckdb");
}

function statementRefusal(sql: string, type: DatabaseType | null): string | null {
  if (type === null) return duckdbReadRefusal(sql);
  const refused = readableRefusal(sql, type);
  if (refused !== null) return refused;
  if (!readsSqlText(type)) return null;
  return fileReadRefusal(sql);
}

function engineOf(id: string | undefined, connections: readonly DatabaseConnection[]): DatabaseType | null {
  if (id === undefined || id === "" || id === CROSS_DB_JOINS_ID) return "duckdb";
  return connections.find((item) => item.id === id)?.type ?? null;
}

function tableIdFor(name: string, requested: string | undefined, taken: ReadonlySet<string>): string | Refusal {
  if (requested !== undefined) {
    const error = savedQueryTableIdError(requested);
    if (error !== null) return { ok: false, reason: "mcp_statement_refused", text: error };
    if (taken.has(requested.toLowerCase())) {
      return { ok: false, reason: "mcp_workspace_missing", text: `The ID ${requested} is already a saved query.` };
    }
    return requested;
  }
  const cleaned = name.replace(/[^\p{L}\p{Nl}\p{N}_]+/gu, "_").replace(/^[\p{N}_]+/u, "");
  const candidate = cleaned.slice(0, 128);
  if (savedQueryTableIdError(candidate) === null && !taken.has(candidate.toLowerCase())) return candidate;
  return `q_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function answer(
  record: McpCallRecord,
  outcome: Refusal | { readonly ok: true; readonly value: Record<string, unknown> },
): ToolResult {
  if (!outcome.ok) {
    return recordOrRefuse(() => recordMcpDecision(record, outcome.reason)) ?? ownWordsError(outcome.text);
  }
  return recordOrRefuse(() => recordMcpDecision(record)) ?? plainResult(outcome.value);
}

function cancelled(record: McpCallRecord): ToolResult {
  return recordOrRefuse(() => recordMcpDecision(record, "mcp_cancelled")) ?? ownWordsError(MCP_CANCELLED_TEXT);
}

async function ready(
  call: McpToolCall,
  provider: ServerStorageProvider | null,
  record: McpCallRecord,
): Promise<Ready | ToolResult> {
  if (call.signal.aborted) return cancelled(record);
  if (provider === null) {
    return answer(record, { ok: false, reason: "mcp_workspace_unavailable", text: WORKSPACE_UNAVAILABLE });
  }
  const owner = ownerOf(call.context.caller);
  if (typeof owner !== "string") return answer(record, owner);
  const account = await loadAccount(provider, owner);
  if (isRefusal(account)) return answer(record, account);
  return { owner, account, provider };
}

function isReady(value: Ready | ToolResult): value is Ready {
  return "account" in value;
}

function dashboardById(account: AccountLists, id: string): SavedDashboard | Refusal {
  return (
    account.dashboards.find((item) => item.id === id) ?? {
      ok: false,
      reason: "mcp_workspace_missing",
      text: "That dashboard is not on this account.",
    }
  );
}

async function save<K extends StorageCollection>(
  provider: ServerStorageProvider,
  owner: string,
  collection: K,
  data: StorageData[K],
): Promise<Refusal | null> {
  try {
    await provider.setCollection(owner, collection, data);
    return null;
  } catch {
    return { ok: false, reason: "mcp_workspace_unavailable", text: STORAGE_UNREADABLE };
  }
}

function opened(call: McpToolCall, action: McpAuthoringTool): McpCallRecord {
  return { action, user: call.context.caller.username, correlationId: newMcpCorrelationId() };
}

export async function writeDuckdbQuery(
  args: z.infer<typeof WriteDuckdbQueryInputSchema>,
  call: McpToolCall,
  provider: ServerStorageProvider | null,
): Promise<ToolResult> {
  const record = opened(call, "write_duckdb_query");
  const loaded = await ready(call, provider, record);
  if (!isReady(loaded)) return loaded;
  const { account, owner } = loaded;
  const existing = args.query_id === undefined ? undefined : account.queries.find((item) => item.id === args.query_id);
  if (args.query_id !== undefined && existing === undefined) {
    return answer(record, {
      ok: false,
      reason: "mcp_workspace_missing",
      text: "That saved query is not on this account.",
    });
  }
  if (existing !== undefined && !isDuckDbConnectionType(existing.connectionType)) {
    return answer(record, {
      ok: false,
      reason: "mcp_statement_refused",
      text: "That saved query is not a DuckDB query.",
    });
  }
  const refused = duckdbReadRefusal(args.sql);
  if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
  const taken = new Set(
    account.queries
      .filter((item) => item.id !== existing?.id)
      .map((item) => item.tableId?.toLowerCase())
      .filter((item): item is string => item !== undefined),
  );
  const tableId = tableIdFor(args.name, args.table_id, taken);
  if (typeof tableId !== "string") return answer(record, tableId);
  const now = new Date();
  const saved: SavedQuery = {
    id: existing?.id ?? crypto.randomUUID(),
    name: args.name,
    tableId,
    query: args.sql,
    connectionType: "duckdb",
    ...(existing?.connectionId === undefined ? {} : { connectionId: existing.connectionId }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const queries =
    existing === undefined
      ? [...account.queries, saved]
      : account.queries.map((item) => (item.id === saved.id ? saved : item));
  const failed = await save(loaded.provider, owner, "saved_queries", queries);
  if (failed !== null) return answer(record, failed);
  return answer(record, {
    ok: true,
    value: { query_id: saved.id, table_id: tableId, name: saved.name, connection_type: "duckdb" },
  });
}

export async function createDashboard(
  args: z.infer<typeof CreateDashboardInputSchema>,
  call: McpToolCall,
  provider: ServerStorageProvider | null,
): Promise<ToolResult> {
  const record = opened(call, "create_dashboard");
  const loaded = await ready(call, provider, record);
  if (!isReady(loaded)) return loaded;
  const { account, owner } = loaded;
  const type = engineOf(args.connection_id, account.connections);
  if (args.sql !== undefined) {
    const refused = statementRefusal(args.sql, type);
    if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
  }
  if (args.note_sql !== undefined) {
    const refused = statementRefusal(args.note_sql, type);
    if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
  }
  let dashboard = freshDashboard(args.name);
  let chartId: string | null = null;
  const charts = [...account.charts];
  if (args.sql !== undefined) {
    const now = new Date();
    const chart: SavedChartConfig = {
      id: crypto.randomUUID(),
      token: chartPublicId(),
      name: args.chart_name ?? args.name,
      chartType: "bar",
      xAxis: "",
      yAxis: [],
      query: args.sql,
      ...(args.connection_id === undefined ? {} : { connectionId: args.connection_id }),
      createdAt: now,
    };
    charts.push(chart);
    chartId = chart.id;
    dashboard = withChart(dashboard, chart.id, 1600);
  }
  let noteId: string | null = null;
  if (args.note_text !== undefined || args.note_script !== undefined || args.note_sql !== undefined) {
    const note: DashboardNote = {
      id: crypto.randomUUID(),
      text: args.note_text ?? "",
      ...(args.note_script === undefined ? {} : { script: args.note_script }),
      ...(args.note_sql === undefined ? {} : { query: args.note_sql }),
      ...(args.connection_id !== undefined && args.note_sql !== undefined ? { connectionId: args.connection_id } : {}),
    };
    noteId = note.id;
    dashboard = { ...dashboard, notes: [note] };
  }
  const chartsFailed = await save(loaded.provider, owner, "saved_charts", charts);
  if (chartsFailed !== null) return answer(record, chartsFailed);
  const boardsFailed = await save(loaded.provider, owner, "saved_dashboards", [...account.dashboards, dashboard]);
  if (boardsFailed !== null) return answer(record, boardsFailed);
  return answer(record, {
    ok: true,
    value: { dashboard_id: dashboard.id, name: dashboard.name, chart_id: chartId, note_id: noteId },
  });
}

async function replaceDashboard(
  provider: ServerStorageProvider,
  owner: string,
  account: AccountLists,
  dashboard: SavedDashboard,
): Promise<Refusal | null> {
  return save(
    provider,
    owner,
    "saved_dashboards",
    account.dashboards.map((item) => (item.id === dashboard.id ? dashboard : item)),
  );
}

export async function editDashboardCode(
  args: z.infer<typeof EditDashboardCodeInputSchema>,
  call: McpToolCall,
  provider: ServerStorageProvider | null,
): Promise<ToolResult> {
  const record = opened(call, "edit_dashboard_code");
  const loaded = await ready(call, provider, record);
  if (!isReady(loaded)) return loaded;
  const { account, owner } = loaded;
  const dashboard = dashboardById(account, args.dashboard_id);
  if (isRefusal(dashboard)) return answer(record, dashboard);
  if (args.kind === "chart") {
    if (args.script !== undefined) {
      return answer(record, { ok: false, reason: "mcp_statement_refused", text: "A chart has SQL, not JavaScript." });
    }
    const chart = account.charts.find((item) => item.id === args.id);
    if (chart === undefined || !dashboard.charts.some((frame) => frame.chartId === chart.id)) {
      return answer(record, {
        ok: false,
        reason: "mcp_workspace_missing",
        text: "That chart is not on this dashboard.",
      });
    }
    const sql = args.sql ?? chart.query ?? "";
    const refused = statementRefusal(sql, engineOf(chart.connectionId, account.connections));
    if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
    const next = { ...chart, query: sql };
    const failed = await save(
      loaded.provider,
      owner,
      "saved_charts",
      account.charts.map((item) => (item.id === chart.id ? next : item)),
    );
    if (failed !== null) return answer(record, failed);
    return answer(record, { ok: true, value: { dashboard_id: dashboard.id, kind: "chart", id: chart.id } });
  }
  if (args.kind === "note") {
    const note = (dashboard.notes ?? []).find((item) => item.id === args.id);
    if (note === undefined) {
      return answer(record, {
        ok: false,
        reason: "mcp_workspace_missing",
        text: "That note is not on this dashboard.",
      });
    }
    if (args.sql !== undefined) {
      const refused = statementRefusal(args.sql, engineOf(note.connectionId, account.connections));
      if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
    }
    const next: DashboardNote = {
      ...note,
      ...(args.sql === undefined ? {} : { query: args.sql }),
      ...(args.script === undefined ? {} : { script: args.script }),
    };
    const failed = await replaceDashboard(loaded.provider, owner, account, {
      ...dashboard,
      updatedAt: new Date(),
      notes: (dashboard.notes ?? []).map((item) => (item.id === note.id ? next : item)),
    });
    if (failed !== null) return answer(record, failed);
    return answer(record, { ok: true, value: { dashboard_id: dashboard.id, kind: "note", id: note.id } });
  }
  const filter = (dashboard.filters ?? []).find((item) => item.id === args.id);
  if (filter === undefined) {
    return answer(record, {
      ok: false,
      reason: "mcp_workspace_missing",
      text: "That filter is not on this dashboard.",
    });
  }
  if (args.sql !== undefined) {
    const refused = statementRefusal(args.sql, engineOf(filter.connectionId, account.connections));
    if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
  }
  const next: DashboardFilter = {
    ...filter,
    ...(args.sql === undefined ? {} : { query: args.sql }),
    ...(args.script === undefined ? {} : { script: args.script, control: "custom" }),
  };
  const failed = await replaceDashboard(loaded.provider, owner, account, {
    ...dashboard,
    updatedAt: new Date(),
    filters: (dashboard.filters ?? []).map((item) => (item.id === filter.id ? next : item)),
  });
  if (failed !== null) return answer(record, failed);
  return answer(record, { ok: true, value: { dashboard_id: dashboard.id, kind: "filter", id: filter.id } });
}

export async function createDashboardFilter(
  args: z.infer<typeof CreateDashboardFilterInputSchema>,
  call: McpToolCall,
  provider: ServerStorageProvider | null,
): Promise<ToolResult> {
  const record = opened(call, "create_dashboard_filter");
  const loaded = await ready(call, provider, record);
  if (!isReady(loaded)) return loaded;
  const { account, owner } = loaded;
  const dashboard = dashboardById(account, args.dashboard_id);
  if (isRefusal(dashboard)) return answer(record, dashboard);
  if (!FILTER_NAME.test(args.name)) {
    return answer(record, {
      ok: false,
      reason: "mcp_statement_refused",
      text: "A filter name starts with a letter or underscore and then uses letters, digits and underscores.",
    });
  }
  if ((dashboard.filters ?? []).some((item) => item.name === args.name)) {
    return answer(record, {
      ok: false,
      reason: "mcp_workspace_missing",
      text: `This dashboard already has a filter named ${args.name}.`,
    });
  }
  const control: DashboardFilterControl = args.script !== undefined ? "custom" : (args.control ?? "select");
  if (args.query !== undefined) {
    const refused = statementRefusal(args.query, engineOf(args.connection_id, account.connections));
    if (refused !== null) return answer(record, { ok: false, reason: "mcp_statement_refused", text: refused });
  }
  const filter: DashboardFilter = {
    id: filterPublicId(),
    name: args.name,
    ...(args.label === undefined ? {} : { label: args.label }),
    query: args.query ?? "",
    value: args.value ?? "",
    control,
    ...(args.connection_id === undefined ? {} : { connectionId: args.connection_id }),
    ...(args.values === undefined ? {} : { choiceSource: "values", valuesText: args.values }),
    ...(control === "custom" ? { script: args.script ?? CUSTOM_FILTER_SCRIPT } : {}),
    ...(args.min === undefined ? {} : { min: args.min }),
    ...(args.max === undefined ? {} : { max: args.max }),
    ...(args.step === undefined ? {} : { step: args.step }),
    width: DEFAULT_DASHBOARD_BLOCK_WIDTH,
    height: DEFAULT_DASHBOARD_FILTER_HEIGHT,
  };
  const failed = await replaceDashboard(loaded.provider, owner, account, {
    ...dashboard,
    updatedAt: new Date(),
    filters: [...(dashboard.filters ?? []), filter],
  });
  if (failed !== null) return answer(record, failed);
  return answer(record, {
    ok: true,
    value: { dashboard_id: dashboard.id, filter_id: filter.id, name: filter.name, token: `{{${filter.name}}}` },
  });
}

/** The share helpers the registered tool uses. Tests pass their own. */
export function shareDependencies(overrides: Partial<ShareDeps> = {}): ShareDeps {
  return {
    resolve: overrides.resolve ?? resolveConnection,
    runSource:
      overrides.runSource ??
      ((session, connection, sql, label, signal) =>
        runShareSource(
          session,
          connection,
          sql,
          label,
          signal,
          queryEventRequest("editor", session, { headers: new Headers() }),
        )),
    writeTables: overrides.writeTables ?? writeShareTables,
    writeRecord: overrides.writeRecord ?? writeShare,
    readRecord: overrides.readRecord ?? readShare,
    newId: overrides.newId ?? newShareId,
    mcpUrl: overrides.mcpUrl ?? readMcpUrl,
    plan: overrides.plan ?? planDashboardShare,
  };
}

function neededIds(dashboard: SavedDashboard, charts: readonly SavedChartConfig[]): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined, sql: string) => {
    if (sql.trim() === "" || id === undefined || id === "" || ids.includes(id)) return;
    ids.push(id);
  };
  for (const frame of dashboard.charts) {
    const chart = charts.find((item) => item.id === frame.chartId);
    add(chart?.connectionId, chart?.query ?? "");
  }
  for (const filter of dashboard.filters ?? []) {
    add(filter.connectionId, filter.choiceSource === "values" ? "" : filter.query);
  }
  for (const note of dashboard.notes ?? []) add(note.connectionId, note.query ?? "");
  return ids;
}

export async function shareDashboard(
  args: z.infer<typeof ShareDashboardInputSchema>,
  call: McpToolCall,
  provider: ServerStorageProvider | null,
  deps: ShareDeps = shareDependencies(),
): Promise<ToolResult> {
  const record = opened(call, "share_dashboard");
  const loaded = await ready(call, provider, record);
  if (!isReady(loaded)) return loaded;
  const { account, owner } = loaded;
  const dashboard = dashboardById(account, args.dashboard_id);
  if (isRefusal(dashboard)) return answer(record, dashboard);
  const session = sessionOf(call.context.caller);
  const resolved: DatabaseConnection[] = [];
  for (const id of neededIds(dashboard, account.charts)) {
    try {
      const stored = account.connections.find((item) => item.id === id);
      // oxlint-disable-next-line no-await-in-loop -- one connection after the previous, under the one snapshot.
      const connection = await deps.resolve(
        id.startsWith("seed:") ? { connectionId: id } : { connection: stored },
        session,
      );
      resolved.push(connection);
    } catch (error) {
      const text =
        error instanceof SeedConnectionError
          ? error.message
          : "A connection on this dashboard is not available to this token.";
      return answer(record, { ok: false, reason: "mcp_execution_failed", text });
    }
  }
  const plan = deps.plan(dashboard, account.charts, resolved);
  if (typeof plan === "string") return answer(record, { ok: false, reason: "mcp_statement_refused", text: plan });
  let shareId = dashboard.shareId;
  let createdAt = new Date().toISOString();
  if (shareId !== undefined) {
    const existing = deps.readRecord(shareId);
    if (existing !== null && existing.ownerKey !== owner) {
      return answer(record, {
        ok: false,
        reason: "mcp_workspace_missing",
        text: "That share link belongs to another account.",
      });
    }
    if (existing === null) shareId = deps.newId();
    else createdAt = existing.createdAt;
  } else {
    shareId = deps.newId();
  }
  const columns = new Map<string, string[]>();
  const sheets: ShareSheet[] = [];
  try {
    for (const source of plan.sources) {
      const connection = resolved.find((item) => item.id === source.connectionId);
      if (connection === undefined) {
        throw new ShareError("A connection on this dashboard is not available to this token.");
      }
      // oxlint-disable-next-line no-await-in-loop -- each chart runs after the previous one, under the one snapshot budget.
      let rows = await deps.runSource(session, connection, source.openedSql, source.label, call.signal);
      const picked = sourceForFields(source, rows.fields);
      if (picked.sql !== source.openedSql) {
        // oxlint-disable-next-line no-await-in-loop -- the baked query runs only when the opened rows cannot answer a filter.
        rows = await deps.runSource(session, connection, picked.sql, source.label, call.signal);
      }
      columns.set(source.table, rows.fields);
      sheets.push({ table: source.table, fields: rows.fields, rows: rows.rows });
    }
    const finished = withSnapshotQueries(plan, columns);
    const now = new Date().toISOString();
    const refreshSeconds = shareRefreshSeconds(
      account.charts,
      plan.dashboard.charts.map((frame) => frame.chartId),
    );
    const name = plan.dashboard.name.trim() || "Dashboard";
    const published: ShareRecord = {
      id: shareId,
      name,
      createdAt,
      updatedAt: now,
      refreshedAt: now,
      ownerKey: owner,
      owner: { username: session.username, role: session.role },
      dashboard: { ...plan.dashboard, id: shareId, name },
      charts: finished.charts,
      sources: finished.sources,
      tables: finished.sources.map((source) => source.table),
      ...(refreshSeconds === undefined ? {} : { refreshSeconds }),
    };
    await deps.writeTables(shareId, sheets);
    deps.writeRecord(published);
    const url = deps.mcpUrl();
    if (!url.ok) return answer(record, { ok: false, reason: "mcp_workspace_unavailable", text: url.problem });
    const root = url.value.slice(0, -"/api/mcp".length);
    const failed = await replaceDashboard(loaded.provider, owner, account, {
      ...dashboard,
      shareId,
      updatedAt: new Date(),
    });
    if (failed !== null) return answer(record, failed);
    return answer(record, {
      ok: true,
      value: {
        dashboard_id: dashboard.id,
        share_id: shareId,
        url: `${root}/share/${shareId}`,
        frozen: finished.frozen.map((item) => ({ chart: item.chart, reason: item.reason })),
      },
    });
  } catch (error) {
    const text = error instanceof ShareError ? error.message : "The dashboard could not be shared.";
    return answer(record, { ok: false, reason: "mcp_execution_failed", text });
  }
}

type ToolHandler = (args: Record<string, unknown>, ctx: { mcpReq: { signal: AbortSignal } }) => Promise<ToolResult>;

export function registerAuthoringTools(server: McpServer, context: McpConnectionContext): void {
  const callOf = (signal: AbortSignal): McpToolCall => ({ context, signal });
  const bind =
    <T>(
      run: (args: T, toolCall: McpToolCall, provider: ServerStorageProvider | null) => Promise<ToolResult>,
    ): ToolHandler =>
    async (args, ctx) =>
      run(args as T, callOf(ctx.mcpReq.signal), await getStorageProvider());

  server.registerTool(
    "write_duckdb_query",
    {
      title: "Write a DuckDB query",
      description: WRITE_DUCKDB_QUERY_DESCRIPTION,
      inputSchema: WriteDuckdbQueryInputSchema,
      annotations: MCP_AUTHORING_ANNOTATIONS,
    },
    bind(writeDuckdbQuery),
  );
  server.registerTool(
    "create_dashboard",
    {
      title: "Create a dashboard",
      description: CREATE_DASHBOARD_DESCRIPTION,
      inputSchema: CreateDashboardInputSchema,
      annotations: MCP_AUTHORING_ANNOTATIONS,
    },
    bind(createDashboard),
  );
  server.registerTool(
    "edit_dashboard_code",
    {
      title: "Edit JavaScript or SQL",
      description: EDIT_DASHBOARD_CODE_DESCRIPTION,
      inputSchema: EditDashboardCodeInputSchema,
      annotations: MCP_AUTHORING_ANNOTATIONS,
    },
    bind(editDashboardCode),
  );
  server.registerTool(
    "create_dashboard_filter",
    {
      title: "Create a dashboard filter",
      description: CREATE_DASHBOARD_FILTER_DESCRIPTION,
      inputSchema: CreateDashboardFilterInputSchema,
      annotations: MCP_AUTHORING_ANNOTATIONS,
    },
    bind(createDashboardFilter),
  );
  server.registerTool(
    "share_dashboard",
    {
      title: "Share a dashboard",
      description: SHARE_DASHBOARD_DESCRIPTION,
      inputSchema: ShareDashboardInputSchema,
      annotations: MCP_AUTHORING_ANNOTATIONS,
    },
    async (args, ctx) =>
      shareDashboard(args, callOf(ctx.mcpReq.signal), await getStorageProvider(), shareDependencies()),
  );
}
