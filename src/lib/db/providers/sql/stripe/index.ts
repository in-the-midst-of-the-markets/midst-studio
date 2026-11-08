/**
 * Stripe provider.
 *
 * Stripe is not a SQL server. The editor runs Sigma SQL, and Studio sends that text to a
 * query run on the Queries and Reports API. A REPORT statement runs a report template.
 * Nothing is copied into another database. A write is refused before a request.
 *
 * The secret key is sent only to api.stripe.com, over TLS, on the shared HTTP transport.
 * That path does not use global fetch, so a proxy variable cannot carry the key. A redirect
 * is not followed. A result file is left where Stripe stored it: Studio reads inline rows
 * and does not open the download URL.
 */
import { SQLBaseProvider } from "../sql-base";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  callerBoundTruncationReason,
  findKind,
  type ContainerPathShapeEngine,
  type ObjectPathShapeEngine,
} from "@/lib/db/object-kinds";
import type {
  ActiveSessionDetails,
  Container,
  ContainerLevels,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { ColumnSchema, QueryWarning } from "@/lib/types";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, assignOwnField, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { prepareStripeStatement, type StripeReport, type StripeStatement } from "./translate";

const PROVIDER = "stripe" as const;
const DEFAULT_HOST = "api.stripe.com";
const STRIPE_VERSION = "2026-10-28.preview";
const MAX_SOCKETS = 4;
const POLL_MS = 250;
const MAX_PAGES = 50;
const INLINE_LIMIT = "1000";
const SQL_LIMIT = 100_000;
const DATASET = "analytical";
const REPORTS = "reports";
const EXACT_HOST = "The API host must be api.stripe.com. The secret key is sent only there.";
const KEY_REQUIRED = "A Stripe secret key is required.";
const KEY_LINE = "A Stripe secret key must be a single line of printable text.";
const REDIRECT_REFUSED = "Stripe answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Stripe's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Stripe does not bind parameters.";
const NOT_CONNECTED = "Not connected to Stripe.";
const PAGE_REFUSED = "Stripe's next page was not on api.stripe.com, so it was not read.";
const FILE_REFUSED = "Stripe returned a file instead of rows. Studio does not download that file.";
const RUN_ID_REFUSED = "Stripe returned a run id Studio will not request.";
const MORE_ROWS = "Stripe has more rows than this page of 1000. Narrow the query with WHERE or LIMIT.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Dataset", labelPlural: "Datasets" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
  { id: "report", role: "relation", label: "Report", labelPlural: "Reports", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Stripe", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Stripe", attachedSegment: "required" };

interface StripeClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: StripeClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface ListedTable {
  id: string;
  name: string;
  columns: ColumnSchema[] | null;
}

interface ReportParameter {
  name: string;
  type: string;
  required: boolean;
}

interface ListedReport {
  id: string;
  name: string;
  parameters: ReportParameter[] | null;
}

interface InlinePage {
  columns: string[];
  rows: Record<string, unknown>[];
  more: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the secret key is sent to. Only api.stripe.com is accepted. */
export function stripeApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "stripe.com", DEFAULT_HOST, PROVIDER);
  if (host !== DEFAULT_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The secret key, refused when it could split an HTTP header or is too long to send. */
function stripeToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return token;
}

function stripeMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message;
  }
  const details = isRecord(body.status_details) ? body.status_details : undefined;
  const errors = details === undefined ? undefined : details.query_errors;
  if (Array.isArray(errors)) {
    const lines = errors.flatMap((entry) =>
      isRecord(entry) && typeof entry.message === "string" && entry.message !== "" ? [entry.message] : [],
    );
    if (lines.length > 0) return lines.join(" ");
  }
  if (details !== undefined && typeof details.message === "string" && details.message !== "") return details.message;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  return undefined;
}

function runId(body: unknown): string {
  if (!isRecord(body) || typeof body.id !== "string" || !/^[A-Za-z0-9_]+$/.test(body.id)) {
    throw new QueryError(RUN_ID_REFUSED, PROVIDER);
  }
  return body.id;
}

function runStatus(body: unknown): string {
  if (!isRecord(body) || typeof body.status !== "string" || body.status === "") {
    throw new QueryError("Stripe did not return a run.", PROVIDER);
  }
  return body.status;
}

export class StripeProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private tables: ListedTable[] = [];
  private reports: ListedReport[] = [];

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
    private readonly clock: StripeClock = SYSTEM_CLOCK,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    stripeToken(this.config);
    stripeApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote:
          "This table has more fields than a select list can usefully show. Type a field name and completion fills it in.",
      },
      supportsInlineRowEdit: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      supportsTestDataGeneration: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      identifierQuoting: "double",
      containerLevels: CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      entityName: "Table",
      entityNamePlural: "Tables",
      searchPlaceholder: "Search tables or fields...",
    };
  }

  public async connect(): Promise<void> {
    if (this.ready) return;
    let schemaError: unknown;
    try {
      this.tables = await this.collectPages(
        "/v2/data/schemas",
        {
          dataset: DATASET,
          limit: "100",
          "include[0]": "columns",
        },
        readTable,
      );
    } catch (error) {
      this.tables = [];
      if (!(error instanceof PermissionDeniedError)) {
        this.closeTransport();
        throw error;
      }
      schemaError = error;
    }
    try {
      this.reports = await this.collectPages(
        "/v2/data/reports",
        { limit: "100", "include[0]": "parameters" },
        readReport,
      );
    } catch (error) {
      this.reports = [];
      if (!(error instanceof PermissionDeniedError)) {
        this.closeTransport();
        throw error;
      }
      if (schemaError !== undefined) {
        this.closeTransport();
        throw schemaError;
      }
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransport();
    this.ready = false;
    this.tables = [];
    this.reports = [];
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = this.clock.now();
    const statement = prepareStripeStatement(sql);
    const result = await this.runStatement(statement, sql);
    return { ...result, executionTime: this.clock.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireReady();
    if (parent !== undefined && parent.length > 0) return [];
    return [
      { path: [DATASET], name: DATASET, level: 0 },
      { path: [REPORTS], name: REPORTS, level: 0 },
    ];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    if (container[0] === REPORTS) return { report: { count: this.reports.length } };
    return { table: { count: this.tables.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    if (kind === "report") {
      if (container[0] !== REPORTS) return [];
      return this.reports.map((report) => ({ path: [...container, report.name], name: report.name, kind }));
    }
    if (container[0] === REPORTS) return [];
    return this.tables.map((table) => ({ path: [...container, table.name], name: table.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    if (kind === "report") return { path, columns: await this.reportColumns(name), indexes: [], foreignKeys: [] };
    return { path, columns: await this.tableColumns(name), indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Stripe bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(bounded.map((object) => this.describeObject(object.path, kind)));
    if (limit !== undefined && objects.length > limit) {
      return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
    }
    return { details };
  }

  public getHealth(): Promise<HealthInfo> {
    return Promise.resolve({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  }

  public runMaintenance(): Promise<MaintenanceResult> {
    return Promise.reject(new QueryError("Stripe has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Stripe Data API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.tables.length,
      indexCount: 0,
    };
  }

  public getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return Promise.resolve({});
  }

  public getSlowQueries(): Promise<SlowQueryStats[]> {
    return Promise.resolve([]);
  }

  public getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return Promise.resolve([]);
  }

  public getTableStats(): Promise<TableStats[]> {
    return Promise.resolve([]);
  }

  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve([]);
  }

  public getStorageStats(): Promise<StorageStats[]> {
    return Promise.resolve([]);
  }

  private requireReady(): void {
    if (!this.ready) throw new QueryError(NOT_CONNECTED, PROVIDER);
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Stripe declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async tableColumns(name: string): Promise<ColumnSchema[]> {
    const table = this.tables.find((entry) => entry.name === name);
    if (table === undefined) throw new QueryError(`Stripe has no table named ${name}.`, PROVIDER);
    if (table.columns !== null) return table.columns;
    const body = await this.call("GET", `/v2/data/schemas/${encodeURIComponent(table.id)}`);
    const columns = readColumns(isRecord(body) ? body.columns : undefined) ?? [];
    table.columns = columns;
    return columns;
  }

  private async reportColumns(name: string): Promise<ColumnSchema[]> {
    const report = this.reports.find((entry) => entry.name === name);
    if (report === undefined) throw new QueryError(`Stripe has no report named ${name}.`, PROVIDER);
    if (report.parameters !== null) return parameterColumns(report.parameters);
    const body = await this.call("GET", `/v2/data/reports/${encodeURIComponent(report.id)}`);
    const parameters = readParameters(isRecord(body) ? body.parameters : undefined) ?? [];
    report.parameters = parameters;
    return parameterColumns(parameters);
  }

  private async runStatement(
    statement: StripeStatement,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "query") return this.runQuery(statement.sql, sql);
    const report = statement.kind === "report" ? statement : this.previewReport(statement.name, sql);
    return this.runReport(report);
  }

  private previewReport(name: string, sql: string): StripeReport {
    const report = this.reports.find((entry) => entry.name === name);
    const missing = report?.parameters?.filter((parameter) => parameter.required) ?? [];
    if (missing.length > 0) {
      const list = missing.map((parameter) => `${parameter.name} => '...'`).join(", ");
      throw new QueryError(`Report ${name} needs ${list}. Write REPORT ${name} (${list}).`, PROVIDER, sql);
    }
    return { kind: "report", name, parameters: {} };
  }

  private async runQuery(
    querySql: string,
    original: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (querySql.length > SQL_LIMIT) {
      throw new QueryError("Stripe accepts a query of at most 100000 characters.", PROVIDER, original);
    }
    const created = await this.call(
      "POST",
      "/v2/data/query_runs",
      {},
      {
        query: { sql: querySql },
        dataset: DATASET,
        format: "csv",
      },
    );
    const finished = await this.waitForRun(created, "query_runs", original);
    return this.inlineResult(finished, "query_runs");
  }

  private async runReport(
    report: StripeReport,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const created = await this.call(
      "POST",
      "/v2/data/report_runs",
      {},
      {
        report: { name: report.name },
        parameters: report.parameters,
        format: "csv",
      },
    );
    const finished = await this.waitForRun(created, "report_runs", report.name);
    return this.inlineResult(finished, "report_runs");
  }

  private async waitForRun(created: unknown, collection: "query_runs" | "report_runs", sql: string): Promise<unknown> {
    let body = created;
    const deadline = this.clock.now() + this.queryTimeout;
    while (runStatus(body) === "running") {
      if (this.clock.now() >= deadline)
        throw new TimeoutError("Stripe did not finish the run in time.", PROVIDER, this.queryTimeout, sql);
      await this.clock.wait(Math.min(POLL_MS, Math.max(0, deadline - this.clock.now())));
      if (this.clock.now() >= deadline)
        throw new TimeoutError("Stripe did not finish the run in time.", PROVIDER, this.queryTimeout, sql);
      body = await this.call("GET", `/v2/data/${collection}/${runId(body)}`);
    }
    const status = runStatus(body);
    if (status === "succeeded") return body;
    if (status === "canceled") throw new QueryError("Stripe canceled the run.", PROVIDER, sql);
    const message = redactSecret(stripeMessage(body) ?? `Stripe run ${status}.`, stripeToken(this.config));
    throw new QueryError(message, PROVIDER, sql);
  }

  private async inlineResult(
    finished: unknown,
    collection: "query_runs" | "report_runs",
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const id = runId(finished);
    const body = await this.call("GET", `/v2/data/${collection}/${id}`, {
      "include[0]": "result.inline",
      limit: INLINE_LIMIT,
    });
    const page = readInline(body);
    const warnings: QueryWarning[] | undefined = page.more ? [{ message: MORE_ROWS, severity: "WARNING" }] : undefined;
    return {
      rows: page.rows,
      fields: uniqueFieldNames(page.columns),
      rowCount: page.rows.length,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  private async collectPages<T>(
    path: string,
    query: Record<string, string>,
    read: (entry: unknown) => T | undefined,
  ): Promise<T[]> {
    const rows: T[] = [];
    let next: { path: string; query?: Record<string, string> } | undefined = { path, query };
    for (let page = 0; page < MAX_PAGES && next !== undefined; page += 1) {
      const current = next;
      // oxlint-disable-next-line no-await-in-loop -- the next page's address is in this page's answer.
      const body = await this.call("GET", current.path, current.query);
      const list = readList(body);
      for (const entry of list.rows) {
        const item = read(entry);
        if (item !== undefined) rows.push(item);
      }
      next = list.next === null ? undefined : apiPage(list.next);
    }
    if (next !== undefined)
      throw new QueryError("Stripe has more pages than Studio reads in one connection.", PROVIDER);
    return rows;
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = stripeApiHost(this.config);
    const token = stripeToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}`, "Stripe-Version": STRIPE_VERSION },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.transport;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
  }

  private wireFailure(error: unknown, token: string, host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, token), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Stripe could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    payload?: unknown,
  ): Promise<unknown> {
    const token = stripeToken(this.config);
    const host = stripeApiHost(this.config);
    const transport = this.ensureTransport();
    const params = new URLSearchParams(query);
    const url = endpointUrl(httpOrigin("https", host, 443), path, params.size === 0 ? undefined : params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method,
        url,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    const text = response.text;
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(stripeMessage(body) ?? `Stripe answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function readList(body: unknown): { rows: unknown[]; next: string | null } {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new QueryError("Stripe did not return a list.", PROVIDER);
  const next = typeof body.next_page_url === "string" && body.next_page_url !== "" ? body.next_page_url : null;
  return { rows: body.data, next };
}

/** A next page Studio will request. Anything off api.stripe.com is refused, and the refusal does not repeat it. */
function apiPage(value: string): { path: string; query: Record<string, string> } {
  let url: URL;
  try {
    url = new URL(value, "https://api.stripe.com");
  } catch {
    throw new ConnectionError(PAGE_REFUSED, PROVIDER);
  }
  const port = url.port === "" ? "" : url.port;
  const onApi =
    url.protocol === "https:" &&
    url.hostname === DEFAULT_HOST &&
    url.username === "" &&
    (port === "" || port === "443");
  if (!onApi || !url.pathname.startsWith("/v2/data/")) throw new ConnectionError(PAGE_REFUSED, PROVIDER);
  const query: Record<string, string> = {};
  for (const [key, item] of url.searchParams) query[key] = item;
  return { path: url.pathname, query };
}

function readTable(entry: unknown): ListedTable | undefined {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || entry.name === "")
    return undefined;
  if (!/^[A-Za-z0-9_]+$/.test(entry.id)) return undefined;
  return { id: entry.id, name: entry.name, columns: readColumns(entry.columns) };
}

function readReport(entry: unknown): ListedReport | undefined {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || entry.name === "")
    return undefined;
  if (!/^[A-Za-z0-9_]+$/.test(entry.id)) return undefined;
  return { id: entry.id, name: entry.name, parameters: readParameters(entry.parameters) };
}

function readColumns(value: unknown): ColumnSchema[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return [];
  const columns: ColumnSchema[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
    columns.push({
      name: entry.name,
      type: typeof entry.type === "string" && entry.type !== "" ? entry.type : "varchar",
      nullable: entry.is_primary_key !== true,
      isPrimary: entry.is_primary_key === true,
    });
  }
  return columns;
}

function readParameters(value: unknown): ReportParameter[] | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return [];
  const parameters: ReportParameter[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (name === "" || !isRecord(entry)) continue;
    parameters.push({
      name,
      type: typeof entry.type === "string" && entry.type !== "" ? entry.type : "varchar",
      required: entry.required === true,
    });
  }
  return parameters;
}

function parameterColumns(parameters: readonly ReportParameter[]): ColumnSchema[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    type: parameter.type,
    nullable: !parameter.required,
    isPrimary: false,
  }));
}

function readInline(body: unknown): InlinePage {
  if (!isRecord(body) || !isRecord(body.result)) throw new QueryError(FILE_REFUSED, PROVIDER);
  const inline = body.result.inline;
  if (!isRecord(inline) || !Array.isArray(inline.rows)) throw new QueryError(FILE_REFUSED, PROVIDER);
  const declared = Array.isArray(inline.columns)
    ? inline.columns.flatMap((column) =>
        isRecord(column) && typeof column.name === "string" && column.name !== "" ? [column.name] : [],
      )
    : [];
  const rows = inline.rows.map((entry) => readInlineRow(entry, declared));
  const columns = declared.length > 0 ? declared : uniqueFieldNames(rows.flatMap((row) => Object.keys(row)));
  return { columns, rows, more: typeof inline.next_page_url === "string" && inline.next_page_url !== "" };
}

function readInlineRow(entry: unknown, columns: readonly string[]): Record<string, unknown> {
  const source = isRecord(entry) && isRecord(entry.data) ? entry.data : isRecord(entry) ? entry : {};
  const names = columns.length > 0 ? columns : Object.keys(source);
  const row: Record<string, unknown> = {};
  for (const name of names) assignOwnField(row, name, scalar(source[name]));
  return row;
}

function scalar(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value === undefined) return null;
  return JSON.stringify(value);
}
