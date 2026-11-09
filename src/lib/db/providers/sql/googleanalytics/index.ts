/**
 * Google Analytics provider.
 *
 * Google Analytics is the Data API, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): one SELECT against `report` becomes one `runReport`.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * An access token is sent only to analyticsdata.googleapis.com. A service-account
 * key is exchanged only at oauth2.googleapis.com, and the private key is not sent
 * to the Data API. Both calls use the shared HTTP transport, so a proxy variable
 * cannot carry the credential. A redirect is not followed.
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
import type { ColumnSchema } from "@/lib/types";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, assignOwnField, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { exchangeGaToken, readGaCredential, type GaCredential } from "./auth";
import { translateGaSql, type GaFilter, type GaOrder, type GaSelect } from "./translate";

const PROVIDER = "googleanalytics" as const;
const DEFAULT_HOST = "analyticsdata.googleapis.com";
const TOKEN_HOST = "oauth2.googleapis.com";
const MAX_SOCKETS = 4;
const TABLE = "report";
const CONTAINER_NAME = "property";
const MAX_DIMENSIONS = 9;
const MAX_METRICS = 10;
const MAX_LIMIT = 10_000;
const REFRESH_EARLY_MS = 60_000;
const EXACT_HOST = "The API host must be analyticsdata.googleapis.com. The access token is sent only there.";
const PROPERTY_REQUIRED = "A Google Analytics property id is required.";
const PROPERTY_DIGITS = "A Google Analytics property id is the number from the property settings.";
const REDIRECT_REFUSED = "Google Analytics answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Google Analytics' answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Google Analytics does not bind parameters.";
const NOT_CONNECTED = "Not connected to Google Analytics.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Property", labelPlural: "Properties" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Google Analytics", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Google Analytics", attachedSegment: "required" };

interface GaField {
  readonly apiName: string;
  readonly kind: "dimension" | "metric";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the access token is sent to. Only analyticsdata.googleapis.com is accepted. */
export function gaApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "googleapis.com", DEFAULT_HOST, PROVIDER);
  if (host !== DEFAULT_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The property id, digits only, so it cannot change the request path. */
export function gaPropertyId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (id === "") throw new DatabaseConfigError(PROPERTY_REQUIRED, PROVIDER);
  if (!/^[0-9]{1,20}$/.test(id)) throw new DatabaseConfigError(PROPERTY_DIGITS, PROVIDER);
  return id;
}

function gaMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "")
    return body.error.message;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  return undefined;
}

export class GoogleAnalyticsProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private tokenTransport: NodeTransport | null = null;
  private credential: GaCredential | null = null;
  private grant: { token: string; expiresAt: number } | null = null;
  private sentToken: string | null = null;
  private fields: GaField[] = [];

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
    private readonly now: () => number = Date.now,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    readGaCredential(this.config.password);
    gaApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote: "Name the dimensions and metrics you want. SELECT * uses a short default.",
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
      gaPropertyId(this.config);
      this.credential = readGaCredential(this.config.password);
      this.fields = await this.loadMetadata();
    } catch (error) {
      this.closeTransports();
      throw error;
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransports();
    this.ready = false;
    this.credential = null;
    this.grant = null;
    this.sentToken = null;
    this.fields = [];
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = this.now();
    const statement = translateGaSql(sql);
    const result = await this.run(statement, sql);
    return { ...result, executionTime: this.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireReady();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: 1 } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return [{ path: [...container, TABLE], name: TABLE, kind }];
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    if ((path[path.length - 1] ?? "").toLowerCase() !== TABLE) {
      throw new QueryError("Google Analytics has no table with that name.", PROVIDER);
    }
    return { path, columns: this.columns(), indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Google Analytics bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Google Analytics has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Google Analytics Data API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 1,
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
    if (spec === undefined) throw new QueryError(`Google Analytics declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private columns(): ColumnSchema[] {
    return this.fields.map((field) => ({
      name: field.apiName,
      type: field.kind === "dimension" ? "varchar" : "double",
      nullable: true,
      isPrimary: false,
    }));
  }

  private async run(
    statement: GaSelect,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const names = statement.columns === null ? defaultNames(this.fields) : statement.columns;
    if (names.length === 0)
      throw new QueryError("Google Analytics returned no dimensions or metrics to select.", PROVIDER, sql);
    const chosen = names.map((name) => this.field(name, sql));
    const dimensions = chosen.filter((field) => field.kind === "dimension");
    const metrics = chosen.filter((field) => field.kind === "metric");
    if (dimensions.length > MAX_DIMENSIONS) {
      throw new QueryError("Google Analytics accepts at most 9 dimensions in one report.", PROVIDER, sql);
    }
    if (metrics.length > MAX_METRICS) {
      throw new QueryError("Google Analytics accepts at most 10 metrics in one report.", PROVIDER, sql);
    }
    if (metrics.length === 0) throw new QueryError("Name at least one metric, such as activeUsers.", PROVIDER, sql);
    if (statement.orderBy !== null && !names.some((name) => sameName(name, statement.orderBy?.column ?? ""))) {
      throw new QueryError("ORDER BY a column in the select list.", PROVIDER, sql);
    }
    let limit = statement.limit === null ? 100 : statement.limit;
    const warnings: { message: string; severity: "WARNING" }[] = [];
    if (limit > MAX_LIMIT) {
      warnings.push({
        message: "Google Analytics returns at most 10000 rows. The rest of this limit was not requested.",
        severity: "WARNING",
      });
      limit = MAX_LIMIT;
    }
    if (limit === 0) return { rows: [], fields: uniqueFieldNames([...names]), rowCount: 0, warnings };
    const filters = statement.filters.map((filter) => ({ filter, field: this.field(filter.column, sql) }));
    const body = await this.post(reportBody(statement, dimensions, metrics, filters, limit));
    return { ...readReport(body, names), warnings };
  }

  private field(name: string, sql: string): GaField {
    const matches = this.fields.filter((field) => sameName(field.apiName, name));
    if (matches.length === 0) throw new QueryError(`Google Analytics has no field named ${name}.`, PROVIDER, sql);
    const kinds = new Set(matches.map((field) => field.kind));
    if (kinds.size > 1)
      throw new QueryError(`${name} is both a dimension and a metric. Rename one in Analytics.`, PROVIDER, sql);
    return matches[0] as GaField;
  }

  private async accessToken(): Promise<string> {
    const credential = this.credential ?? readGaCredential(this.config.password);
    if (credential.kind === "access_token") return credential.token;
    if (this.grant !== null && this.now() < this.grant.expiresAt - REFRESH_EARLY_MS) return this.grant.token;
    const transport = this.ensureTokenTransport();
    try {
      this.grant = await exchangeGaToken(credential, transport, this.now());
    } catch (error) {
      throw this.wireFailure(error, [credential.privateKey], TOKEN_HOST);
    }
    return this.grant.token;
  }

  private async openApi(token: string): Promise<void> {
    const host = gaApiHost(this.config);
    this.transport?.close();
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}` },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
  }

  private ensureTokenTransport(): NodeTransport {
    if (this.tokenTransport !== null) return this.tokenTransport;
    this.tokenTransport = this.createTransport({
      origin: httpOrigin("https", TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: TOKEN_HOST },
      maxSockets: MAX_SOCKETS,
      headers: {},
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.tokenTransport;
  }

  private async loadMetadata(): Promise<GaField[]> {
    const id = gaPropertyId(this.config);
    const body = await this.call("GET", `/v1beta/properties/${id}/metadata`);
    return readMetadata(body);
  }

  private async post(payload: unknown): Promise<unknown> {
    const id = gaPropertyId(this.config);
    return this.call("POST", `/v1beta/properties/${id}:runReport`, payload);
  }

  private async call(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    if (this.transport === null || this.sentToken !== token) {
      this.sentToken = token;
      await this.openApi(token);
    }
    const host = gaApiHost(this.config);
    const secrets = this.hiddenSecrets();
    const url = endpointUrl(httpOrigin("https", host, 443), path);
    let response: { status: number; text: string };
    try {
      response = await this.ensureApi().request({
        method,
        url,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, secrets, host);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    let body: unknown = {};
    if (response.text !== "") {
      try {
        body = JSON.parse(response.text) as unknown;
      } catch {
        body = { message: response.text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(gaMessage(body) ?? `Google Analytics answered ${response.status}.`, ...secrets);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }

  private ensureApi(): NodeTransport {
    if (this.transport === null) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.transport;
  }

  private hiddenSecrets(): readonly string[] {
    const credential = this.credential;
    if (credential === null) return [this.config.password ?? ""];
    if (credential.kind === "access_token") return [credential.token];
    return [credential.privateKey, this.grant?.token ?? ""];
  }

  private closeTransports(): void {
    this.transport?.close();
    this.tokenTransport?.close();
    this.transport = null;
    this.tokenTransport = null;
  }

  private wireFailure(error: unknown, secrets: readonly string[], host: string): Error {
    if (error instanceof AuthenticationError) return error;
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, ...secrets), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Google Analytics could not be reached.";
    return new ConnectionError(redactSecret(message, ...secrets), PROVIDER, host);
  }
}

function defaultNames(fields: readonly GaField[]): string[] {
  const dimensions = fields.filter((field) => field.kind === "dimension").map((field) => field.apiName);
  const metrics = fields.filter((field) => field.kind === "metric").map((field) => field.apiName);
  const pickedDimensions = ["date", "country"].filter((name) => dimensions.includes(name));
  const pickedMetrics = ["activeUsers", "sessions"].filter((name) => metrics.includes(name));
  return [
    ...(pickedDimensions.length > 0 ? pickedDimensions : dimensions.slice(0, 1)),
    ...(pickedMetrics.length > 0 ? pickedMetrics : metrics.slice(0, 1)),
  ];
}

function readMetadata(body: unknown): GaField[] {
  if (!isRecord(body)) throw new QueryError("Google Analytics did not return metadata.", PROVIDER);
  const fields: GaField[] = [];
  const take = (value: unknown, kind: GaField["kind"]): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.apiName !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(entry.apiName))
        continue;
      fields.push({ apiName: entry.apiName, kind });
    }
  };
  take(body.dimensions, "dimension");
  take(body.metrics, "metric");
  return fields;
}

function reportBody(
  statement: GaSelect,
  dimensions: readonly GaField[],
  metrics: readonly GaField[],
  filters: readonly { filter: GaFilter; field: GaField }[],
  limit: number,
): unknown {
  const dimensionFilters = filters.filter((entry) => entry.field.kind === "dimension");
  const metricFilters = filters.filter((entry) => entry.field.kind === "metric");
  return {
    dateRanges: [{ startDate: statement.startDate, endDate: statement.endDate }],
    dimensions: dimensions.map((field) => ({ name: field.apiName })),
    metrics: metrics.map((field) => ({ name: field.apiName })),
    ...(dimensionFilters.length === 0 ? {} : { dimensionFilter: filterGroup(dimensionFilters, "dimension") }),
    ...(metricFilters.length === 0 ? {} : { metricFilter: filterGroup(metricFilters, "metric") }),
    ...(statement.orderBy === null ? {} : { orderBys: [orderBy(statement.orderBy, dimensions, metrics)] }),
    limit: String(limit),
    offset: String(statement.offset),
  };
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function filterGroup(filters: readonly { filter: GaFilter; field: GaField }[], kind: "dimension" | "metric"): unknown {
  const expressions = filters.map((entry) => ({
    filter: kind === "dimension" ? stringFilter(entry) : numericFilter(entry),
  }));
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

function stringFilter(entry: { filter: GaFilter; field: GaField }): unknown {
  return {
    fieldName: entry.field.apiName,
    stringFilter: { matchType: "EXACT", value: entry.filter.value, caseSensitive: false },
  };
}

function numericFilter(entry: { filter: GaFilter; field: GaField }): unknown {
  if (!/^-?\d+(\.\d+)?$/.test(entry.filter.value)) {
    throw new QueryError("Write a metric filter as a whole number or a decimal.", PROVIDER);
  }
  const value = /^-?\d+$/.test(entry.filter.value)
    ? { int64Value: entry.filter.value }
    : { doubleValue: Number(entry.filter.value) };
  return { fieldName: entry.field.apiName, numericFilter: { operation: "EQUAL", value } };
}

function orderBy(order: GaOrder, dimensions: readonly GaField[], metrics: readonly GaField[]): unknown {
  const dimension = dimensions.find((field) => sameName(field.apiName, order.column));
  if (dimension !== undefined) return { desc: order.desc, dimension: { dimensionName: dimension.apiName } };
  const metric = metrics.find((field) => sameName(field.apiName, order.column)) as GaField;
  return { desc: order.desc, metric: { metricName: metric.apiName } };
}

function readReport(body: unknown, names: readonly string[]): Pick<QueryResult, "rows" | "fields" | "rowCount"> {
  if (!isRecord(body) || !Array.isArray(body.rows))
    throw new QueryError("Google Analytics did not return a report.", PROVIDER);
  const dimensionHeaders = headerNames(body.dimensionHeaders);
  const metricHeaders = headerNames(body.metricHeaders);
  const rows = body.rows.map((entry) => {
    const row: Record<string, unknown> = {};
    if (!isRecord(entry)) return row;
    const dimensionValues = Array.isArray(entry.dimensionValues) ? entry.dimensionValues : [];
    const metricValues = Array.isArray(entry.metricValues) ? entry.metricValues : [];
    dimensionHeaders.forEach((name, index) => assignOwnField(row, name, valueAt(dimensionValues[index])));
    metricHeaders.forEach((name, index) => assignOwnField(row, name, metricAt(metricValues[index])));
    return row;
  });
  const fields = uniqueFieldNames([...names]);
  const projected = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) assignOwnField(out, field, row[field] ?? null);
    return out;
  });
  return { rows: projected, fields, rowCount: projected.length };
}

function headerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []));
}

function valueAt(entry: unknown): string | null {
  if (!isRecord(entry) || typeof entry.value !== "string") return null;
  return entry.value;
}

function metricAt(entry: unknown): string | number | null {
  const value = valueAt(entry);
  if (value === null || value === "") return null;
  if (/^-?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}
