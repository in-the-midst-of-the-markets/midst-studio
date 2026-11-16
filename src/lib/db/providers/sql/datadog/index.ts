/**
 * Datadog provider.
 *
 * Datadog is a monitoring API, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): SELECT and COUNT(*) against monitors, hosts, or
 * dashboards. Each statement is one GET. Nothing is copied into another
 * database, and a write is refused before a request.
 *
 * The API key and application key are sent only to an official Datadog API
 * host, as `DD-API-KEY` and `DD-APPLICATION-KEY`, over TLS, on the shared HTTP
 * transport. That path does not use global fetch, so a proxy variable cannot
 * carry the keys. A redirect is not followed.
 */
import { SQLBaseProvider } from "../sql-base";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
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
import type { QueryWarning } from "@/lib/types";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  DATADOG_RESOURCES,
  type DatadogFilter,
  type DatadogResource,
  type DatadogStatement,
  translateDatadogSql,
} from "./translate";

const PROVIDER = "datadog" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "organization";
const DEFAULT_HOST = "api.datadoghq.com";
const HOST_REQUIRED = "The API host must be a Datadog site. The keys are sent only there.";
const API_KEY_REQUIRED = "The API key is required.";
const APP_KEY_REQUIRED = "The application key is required.";
const CREDENTIAL_LINE = "Datadog keys must be a single line of printable text.";
const REDIRECT_REFUSED = "Datadog answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Datadog's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Datadog does not bind parameters.";
const NOT_CONNECTED = "Not connected to Datadog.";
const PAGE_WARNING = "Datadog returned this page only. Raise OFFSET for the next page.";
const SLOW = "Datadog asked the connection to slow down.";
const NOT_JSON = "Datadog returned an answer that was not JSON.";
const NOT_LIST = "Datadog returned an answer that was not a list.";
const NOT_OBJECT = "Datadog returned an answer that was not a JSON object.";
const NO_TOTAL = "Datadog did not return a total.";
const REFUSED = "Datadog refused the request";
const SAFE_ERROR = /^[A-Za-z0-9 .,':_()/-]{1,80}$/;

/**
 * Official API hosts. A site name or the bare site domain maps to the API host.
 * `app.` hosts are the product site, and the keys are not sent there.
 */
const SITES: Readonly<Record<string, string>> = {
  "api.datadoghq.com": "api.datadoghq.com",
  "datadoghq.com": "api.datadoghq.com",
  us: "api.datadoghq.com",
  us1: "api.datadoghq.com",
  "api.us3.datadoghq.com": "api.us3.datadoghq.com",
  "us3.datadoghq.com": "api.us3.datadoghq.com",
  us3: "api.us3.datadoghq.com",
  "api.us5.datadoghq.com": "api.us5.datadoghq.com",
  "us5.datadoghq.com": "api.us5.datadoghq.com",
  us5: "api.us5.datadoghq.com",
  "api.datadoghq.eu": "api.datadoghq.eu",
  "datadoghq.eu": "api.datadoghq.eu",
  eu: "api.datadoghq.eu",
  eu1: "api.datadoghq.eu",
  "api.ap1.datadoghq.com": "api.ap1.datadoghq.com",
  "ap1.datadoghq.com": "api.ap1.datadoghq.com",
  ap1: "api.ap1.datadoghq.com",
  "api.ap2.datadoghq.com": "api.ap2.datadoghq.com",
  "ap2.datadoghq.com": "api.ap2.datadoghq.com",
  ap2: "api.ap2.datadoghq.com",
  "api.uk1.datadoghq.com": "api.uk1.datadoghq.com",
  "uk1.datadoghq.com": "api.uk1.datadoghq.com",
  uk1: "api.uk1.datadoghq.com",
  "api.ddog-gov.com": "api.ddog-gov.com",
  "ddog-gov.com": "api.ddog-gov.com",
  gov: "api.ddog-gov.com",
  "us1-fed": "api.ddog-gov.com",
  "api.us2.ddog-gov.com": "api.us2.ddog-gov.com",
  "us2.ddog-gov.com": "api.us2.ddog-gov.com",
  "us2-fed": "api.us2.ddog-gov.com",
};

const STATUS_TOKEN: Readonly<Record<string, string>> = {
  Alert: "alert",
  Warn: "warn",
  OK: "ok",
  "No Data": '"No Data"',
  Ignored: "ignored",
  Skipped: "skipped",
  Unknown: "unknown",
};

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Organization", labelPlural: "Organizations" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A Datadog organization",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A Datadog organization",
  attachedSegment: "required",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credential(value: string | undefined, empty: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(empty, PROVIDER);
  if (text.length > 200 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/** The REST API host. Empty uses the US1 site. The keys are sent only to an official API host. */
export function datadogHost(config: Pick<DatabaseConnection, "host">): string {
  const trimmed = config.host?.trim() ?? "";
  if (trimmed === "") return DEFAULT_HOST;
  let hostname = "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const schemeOk = url.protocol === "https:" || url.protocol === "http:";
    if (
      !schemeOk ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
    }
    if (url.pathname !== "" && url.pathname !== "/") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
    hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch (error) {
    if (error instanceof DatabaseConfigError) throw error;
    throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  }
  const host = SITES[hostname];
  if (host === undefined) throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return host;
}

/** The API key, from the user field. Sent as `DD-API-KEY`. */
export function datadogApiKey(config: Pick<DatabaseConnection, "user">): string {
  return credential(config.user, API_KEY_REQUIRED);
}

/** The application key, from the password field. Sent as `DD-APPLICATION-KEY`. */
export function datadogApplicationKey(config: Pick<DatabaseConnection, "password">): string {
  return credential(config.password, APP_KEY_REQUIRED);
}

/** Datadog connection. The keys read monitors, hosts and dashboards. */
export class DatadogProvider extends SQLBaseProvider {
  private ready = false;
  private api: NodeTransport | null = null;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    datadogHost(this.config);
    datadogApiKey(this.config);
    datadogApplicationKey(this.config);
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
    try {
      await this.get("/api/v1/validate", {}, "connect");
    } catch (error) {
      this.closeTransport();
      throw error;
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransport();
    this.ready = false;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateDatadogSql(sql);
    const result = await this.run(statement);
    return { ...result, executionTime: Date.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireReady();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: DATADOG_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return DATADOG_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = DATADOG_RESOURCES.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("Datadog has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: true,
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Datadog bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(bounded.map((object) => this.describeObject(object.path, kind)));
    return { details };
  }

  public getHealth(): Promise<HealthInfo> {
    return Promise.resolve({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  }

  public runMaintenance(): Promise<MaintenanceResult> {
    return Promise.reject(new QueryError("Datadog has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Datadog API V1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: DATADOG_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Datadog declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: DatadogStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") return this.count(statement);
    return this.page(statement);
  }

  private async page(
    statement: Extract<DatadogStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const body = await this.get(pathOf(statement.resource), queryOf(statement), "query");
    const rows = listedRows(body, listKey(statement.resource)).map((row) =>
      project(mapRow(statement.resource, row), fields),
    );
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length));
  }

  private async count(
    statement: Extract<DatadogStatement, { kind: "count" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount">> {
    const body = await this.get(pathOf(statement.resource), countQuery(statement), "query");
    const total = totalOf(body, statement.resource);
    return { rows: [{ [statement.alias]: total }], fields: [statement.alias], rowCount: 1 };
  }

  private async get(path: string, query: Record<string, string>, during: "connect" | "query"): Promise<unknown> {
    const apiKey = datadogApiKey(this.config);
    const appKey = datadogApplicationKey(this.config);
    const host = datadogHost(this.config);
    const url = endpointUrl(httpOrigin("https", host, 443), path, new URLSearchParams(query));
    let response: { status: number; text: string };
    try {
      response = await this.transport(apiKey, appKey, host).request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, apiKey, appKey, host, during);
    }
    return this.read(response, apiKey, appKey, during);
  }

  private read(
    response: { status: number; text: string },
    apiKey: string,
    appKey: string,
    during: "connect" | "query",
  ): unknown {
    const asQuery = during === "query";
    if (response.status >= 300 && response.status < 400) {
      throw asQuery ? new QueryError(REDIRECT_REFUSED, PROVIDER) : new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    }
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 401) throw new AuthenticationError("Datadog rejected the keys.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("Datadog refused this request.", PROVIDER);
    if (response.status === 429) throw asQuery ? new QueryError(SLOW, PROVIDER) : new ConnectionError(SLOW, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      const message = failureMessage(response.text, apiKey, appKey);
      throw asQuery ? new QueryError(message, PROVIDER) : new ConnectionError(message, PROVIDER);
    }
    if (response.text === "")
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    let body: unknown;
    try {
      body = JSON.parse(response.text) as unknown;
    } catch {
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    }
    if (during === "connect") {
      if (!isRecord(body) || body.valid !== true) throw new AuthenticationError("Datadog rejected the keys.", PROVIDER);
    }
    return body;
  }

  private transport(apiKey: string, appKey: string, host: string): NodeTransport {
    if (this.api !== null) return this.api;
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Accept: "application/json",
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": appKey,
        "user-agent": "KnowSQL",
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.api;
  }

  private closeTransport(): void {
    this.api?.close();
    this.api = null;
  }

  private wireFailure(
    error: unknown,
    apiKey: string,
    appKey: string,
    host: string,
    during: "connect" | "query",
  ): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") {
        return during === "query"
          ? new QueryError(REDIRECT_REFUSED, PROVIDER)
          : new ConnectionError(REDIRECT_REFUSED, PROVIDER, host);
      }
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, apiKey, appKey), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Datadog could not be reached.";
    return new ConnectionError(redactSecret(message, apiKey, appKey), PROVIDER, host);
  }
}

function pathOf(resource: DatadogResource): string {
  if (resource.name === "Monitor") return "/api/v1/monitor/search";
  if (resource.name === "Host") return "/api/v1/hosts";
  return "/api/v1/dashboard";
}

function listKey(resource: DatadogResource): string {
  if (resource.name === "Monitor") return "monitors";
  if (resource.name === "Host") return "host_list";
  return "dashboards";
}

function queryOf(statement: Extract<DatadogStatement, { kind: "list" }>): Record<string, string> {
  if (statement.resource.name === "Monitor") return monitorQuery(statement.filters, statement.limit, statement.offset);
  if (statement.resource.name === "Host") return hostQuery(statement.filters, statement.limit, statement.offset);
  return dashboardQuery(statement.filters, statement.limit, statement.offset);
}

function countQuery(statement: Extract<DatadogStatement, { kind: "count" }>): Record<string, string> {
  if (statement.resource.name === "Monitor") return monitorQuery(statement.filters, 1, 0);
  return hostQuery(statement.filters, 1, 0);
}

function monitorQuery(filters: readonly DatadogFilter[], limit: number, offset: number): Record<string, string> {
  const parts: string[] = [];
  for (const filter of filters) {
    if (filter.name === "Query") parts.push(filter.value);
    if (filter.name === "Status") parts.push(`status:${STATUS_TOKEN[filter.value] ?? filter.value}`);
  }
  const query: Record<string, string> = { page: String(offset / limit), per_page: String(limit) };
  const text = parts.join(" ").trim();
  if (text !== "") query.query = text;
  return query;
}

function hostQuery(filters: readonly DatadogFilter[], limit: number, offset: number): Record<string, string> {
  const query: Record<string, string> = {
    count: String(limit),
    start: String(offset),
    include_muted_hosts_data: "true",
    include_hosts_metadata: "true",
  };
  for (const filter of filters) query[filter.param] = filter.value;
  return query;
}

function dashboardQuery(filters: readonly DatadogFilter[], limit: number, offset: number): Record<string, string> {
  const query: Record<string, string> = { count: String(limit), start: String(offset) };
  for (const filter of filters) query[filter.param] = filter.value;
  return query;
}

function fieldsOf(statement: Extract<DatadogStatement, { kind: "list" }>): string[] {
  return uniqueFieldNames(
    statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
  );
}

function listedRows(body: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(body)) throw new QueryError(NOT_OBJECT, PROVIDER);
  const items = body[key];
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new QueryError(NOT_LIST, PROVIDER);
  return items.filter(isRecord);
}

function totalOf(body: unknown, resource: DatadogResource): number {
  if (!isRecord(body)) throw new QueryError(NOT_OBJECT, PROVIDER);
  const value =
    resource.name === "Monitor" && isRecord(body.metadata) ? body.metadata.total_count : body.total_matching;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new QueryError(NO_TOTAL, PROVIDER);
  return value;
}

function mapRow(resource: DatadogResource, row: Record<string, unknown>): Record<string, unknown> {
  if (resource.name === "Host") return hostRow(row);
  if (resource.name === "Dashboard") return dashboardRow(row);
  return monitorRow(row);
}

function withWarnings(
  result: Pick<QueryResult, "rows" | "fields" | "rowCount">,
  warnings: QueryWarning[],
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  return warnings.length === 0 ? result : { ...result, warnings };
}

function pageWarnings(statement: Extract<DatadogStatement, { kind: "list" }>, rows: number): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  if (statement.capped) {
    warnings.push({
      message: `Datadog returns at most ${statement.limit} rows in one page. This query asked for more, so the page is ${statement.limit}.`,
      severity: "WARNING",
    });
  }
  if (rows === statement.limit) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
  return warnings;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) projected[field] = row[field] ?? null;
  return projected;
}

function failureMessage(text: string, apiKey: string, appKey: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    const redacted = redactSecret(text, apiKey, appKey);
    return redacted === "" ? `${REFUSED}.` : redacted;
  }
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const first = errors.find((entry): entry is string => typeof entry === "string");
  if (first !== undefined) {
    const clean = redactSecret(first, apiKey, appKey);
    if (SAFE_ERROR.test(clean)) return `${REFUSED} (${clean}).`;
  }
  return `${REFUSED}.`;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value >= 1e12 ? value : value >= 1e9 ? value * 1000 : null;
    if (ms === null) return String(value);
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return asText(value);
}

function joined(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((item): item is string => typeof item === "string" && item !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

function hostTags(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const parts: string[] = [];
  for (const entry of Object.values(value)) {
    if (!Array.isArray(entry)) continue;
    for (const tag of entry) if (typeof tag === "string" && tag !== "") parts.push(tag);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

function monitorRow(row: Record<string, unknown>): Record<string, unknown> {
  const creator = isRecord(row.creator) ? row.creator : null;
  const notifications = Array.isArray(row.notifications) ? row.notifications : [];
  const handles = notifications
    .filter(isRecord)
    .map((entry) => entry.handle)
    .filter((handle): handle is string => typeof handle === "string" && handle !== "");
  return {
    Id: asText(row.id),
    Name: asText(row.name),
    Type: asText(row.type),
    Status: asText(row.status),
    Query: asText(row.query),
    Tags: joined(row.tags),
    Scopes: joined(row.scopes),
    Metrics: joined(row.metrics),
    CreatorName: asText(creator?.name),
    CreatorEmail: asText(creator?.handle),
    Notifications: handles.length === 0 ? null : handles.join(", "),
    LastTriggered: asTime(row.last_triggered_ts),
    Classification: asText(row.classification),
    OrgId: asText(row.org_id),
  };
}

function hostRow(row: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(row.meta) ? row.meta : null;
  const metrics = isRecord(row.metrics) ? row.metrics : null;
  return {
    Id: asText(row.id ?? row.aws_id),
    Name: asText(row.name),
    HostName: asText(row.host_name),
    AwsName: asText(row.aws_name),
    Aliases: joined(row.aliases),
    Apps: joined(row.apps),
    Sources: joined(row.sources),
    Tags: hostTags(row.tags_by_source),
    IsMuted: asText(row.is_muted),
    Up: asText(row.up),
    LastReported: asTime(row.last_reported_time),
    Cpu: asNum(metrics?.cpu),
    IoWait: asNum(metrics?.iowait),
    Load: asNum(metrics?.load),
    AgentVersion: asText(meta?.agent_version),
    Platform: asText(meta?.platform),
    Machine: asText(meta?.machine),
  };
}

function dashboardRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    Id: asText(row.id),
    Title: asText(row.title),
    Description: asText(row.description),
    AuthorHandle: asText(row.author_handle),
    LayoutType: asText(row.layout_type),
    IsReadOnly: asText(row.is_read_only),
    Url: asText(row.url),
    CreatedAt: asTime(row.created_at),
    ModifiedAt: asTime(row.modified_at),
  };
}
