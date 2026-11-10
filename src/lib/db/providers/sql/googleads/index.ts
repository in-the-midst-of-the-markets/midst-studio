/**
 * Google Ads provider.
 *
 * Google Ads is a query API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one standard resource, sent as Google Ads Query Language
 * to the v26 search method. One statement stops at 1000 rows. Nothing is copied into another
 * database, and a write is refused before a request.
 *
 * An access token is sent only to googleads.googleapis.com. A service-account key is
 * exchanged only at oauth2.googleapis.com, and the access token that comes back is what
 * the Ads host sees. Both calls use the shared HTTP transport, so a proxy variable cannot
 * carry the secret. A redirect is not followed. A pasted access token is not refreshed.
 * A developer token is not sent.
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
import { API_ANSWER_LIMIT, assignOwnField, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  adsApiHost,
  adsCustomerId,
  adsManagerId,
  exchangeAdsToken,
  readAdsCredential,
  type AdsCredential,
  type AdsTokenGrant,
} from "./auth";
import {
  GOOGLE_ADS_RESOURCES,
  GOOGLE_ADS_ROW_CAP,
  googleAdsQuery,
  googleAdsResource,
  translateGoogleAdsSql,
  type GoogleAdsColumn,
  type GoogleAdsResource,
  type GoogleAdsSelect,
} from "./translate";

const PROVIDER = "googleads" as const;
const API_VERSION = "v26";
const TOKEN_HOST = "oauth2.googleapis.com";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "customer";
const REDIRECT_REFUSED = "Google Ads answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Google Ads's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Google Ads does not bind parameters.";
const NOT_CONNECTED = "Not connected to Google Ads.";
const BAD_ANSWER = "Google Ads's answer was not a list.";
const RATE_LIMIT = "Google Ads is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Google Ads returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Google Ads reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";
const PROBE = "SELECT customer.id FROM customer LIMIT 1";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Customer", labelPlural: "Customers" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Google Ads", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Google Ads", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: GoogleAdsColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

function cellValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function camel(segment: string): string {
  return segment.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

export class GoogleAdsProvider extends SQLBaseProvider {
  private ready = false;
  private grant: AdsTokenGrant | null = null;
  private data: NodeTransport | null = null;
  private dataKey = "";
  private tokenTransport: NodeTransport | null = null;

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
    readAdsCredential(this.config.password);
    adsApiHost(this.config);
    adsCustomerId(this.config);
    adsManagerId(this.config);
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
      const answer = await this.search(PROBE);
      if (!isRecord(answer) || !Array.isArray(answer.results)) throw new ConnectionError(BAD_ANSWER, PROVIDER);
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
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateGoogleAdsSql(sql);
    const result = await this.run(sql, statement);
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
    return { table: { count: GOOGLE_ADS_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return GOOGLE_ADS_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = googleAdsResource(name);
    if (found === undefined) throw new QueryError("Google Ads has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: sqlType(column),
        nullable: column.name !== found.primary,
        isPrimary: column.name === found.primary,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Google Ads bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Google Ads has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Google Ads API v26",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: GOOGLE_ADS_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Google Ads declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: GoogleAdsSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= GOOGLE_ADS_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const answer = await this.search(googleAdsQuery(statement, sql));
    const rows = this.rowsOf(answer, statement.resource).slice(statement.offset, statement.offset + statement.limit);
    const warnings: QueryWarning[] = [];
    if (statement.capped) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private rowsOf(body: unknown, resource: GoogleAdsResource): Record<string, unknown>[] {
    if (!isRecord(body) || !Array.isArray(body.results)) throw new QueryError(BAD_ANSWER, PROVIDER);
    return body.results.map((entry) => this.rowOf(entry, resource));
  }

  private rowOf(entry: unknown, resource: GoogleAdsResource): Record<string, unknown> {
    if (!isRecord(entry)) throw new QueryError(BAD_ANSWER, PROVIDER);
    const row: Record<string, unknown> = {};
    for (const column of resource.columns) assignOwnField(row, column.name, readField(entry, column.name));
    return row;
  }

  private async search(query: string): Promise<unknown> {
    const text = await this.post(query);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async post(query: string): Promise<string> {
    const token = await this.accessToken();
    const host = adsApiHost(this.config);
    const customer = adsCustomerId(this.config);
    const manager = adsManagerId(this.config);
    const transport = this.dataTransport(host, token, manager);
    const url = endpointUrl(httpOrigin("https", host, 443), `/${API_VERSION}/customers/${customer}/googleAds:search`);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private async accessToken(): Promise<string> {
    const credential = readAdsCredential(this.config.password);
    if (credential.kind === "access_token") return credential.token;
    const cached = this.grant;
    const now = this.now();
    if (cached !== null && cached.expiresAt > now) return cached.token;
    const grant = await this.exchange(credential);
    this.grant = grant;
    return grant.token;
  }

  private async exchange(credential: Extract<AdsCredential, { kind: "service_account" }>): Promise<AdsTokenGrant> {
    try {
      return await exchangeAdsToken(credential, this.tokenChannel(), this.now(), this.hiddenSecrets());
    } catch (error) {
      throw this.wireFailure(error);
    }
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    if (status >= 200 && status < 300) return text;
    const message = redactSecret(adsMessage(text) ?? `Google Ads answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    const credential = readAdsCredential(this.config.password);
    const secrets = credential.kind === "access_token" ? [credential.token] : [credential.privateKey];
    if (this.grant !== null) secrets.push(this.grant.token);
    return secrets;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Google Ads could not be reached.",
      ...this.hiddenSecrets(),
    );
    if (error instanceof TransportError) return new ConnectionError(hidden, PROVIDER);
    if (
      error instanceof QueryError ||
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError ||
      error instanceof ConnectionError ||
      error instanceof DatabaseConfigError
    ) {
      return error;
    }
    return new ConnectionError(hidden, PROVIDER);
  }

  private dataTransport(host: string, token: string, manager: string | null): NodeTransport {
    const key = `${token}\n${manager ?? ""}`;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (manager !== null) headers["login-customer-id"] = manager;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers,
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private tokenChannel(): NodeTransport {
    if (this.tokenTransport !== null) return this.tokenTransport;
    this.tokenTransport = this.createTransport({
      origin: httpOrigin("https", TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: TOKEN_HOST },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.tokenTransport;
  }

  private closeTransports(): void {
    this.data?.close();
    this.tokenTransport?.close();
    this.data = null;
    this.tokenTransport = null;
    this.dataKey = "";
    this.grant = null;
  }
}

function readField(entry: Record<string, unknown>, field: string): unknown {
  let current: unknown = entry;
  for (const part of field.split(".").map(camel)) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return cellValue(current);
}

function adsMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  const message = error.message;
  if (typeof message === "string" && message !== "") return message.length > 300 ? message.slice(0, 300) : message;
  return undefined;
}
