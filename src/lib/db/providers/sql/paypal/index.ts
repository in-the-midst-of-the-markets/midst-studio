/**
 * PayPal provider.
 *
 * PayPal is a REST API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one list. Filters and the page are applied to
 * that answer. One statement reads one page and does not follow the next page.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The client id and secret are exchanged for an access token, and both are sent
 * only to api-m.paypal.com or api-m.sandbox.paypal.com. The token is sent as
 * Authorization Bearer. Studio does not put either secret in a URL. A redirect
 * is not followed.
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
import { paypalHost, readPayPalClientId, readPayPalSecret } from "./auth";
import {
  PAYPAL_RESOURCES,
  PAYPAL_ROW_CAP,
  paypalEntries,
  paypalHasMore,
  paypalQuery,
  paypalResource,
  paypalRows,
  translatePayPalSql,
  type PayPalColumn,
  type PayPalSelect,
} from "./translate";

const PROVIDER = "paypal" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "account";
const TOKEN_PATH = "/v1/oauth2/token";
const REDIRECT_REFUSED = "PayPal answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "PayPal's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. PayPal does not bind parameters.";
const NOT_CONNECTED = "Not connected to PayPal.";
const BAD_TOKEN = "PayPal did not return an access token.";
const LONG_TOKEN = "PayPal's access token is longer than Studio can send.";
const RATE_LIMIT = "PayPal is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "PayPal returned one page of this list. Narrow the filter to see the rest.";
const OFFSET_WARNING = "PayPal reads at most 500 rows. An OFFSET past that returns nothing from this subset.";
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A PayPal", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A PayPal", attachedSegment: "required" };

interface PayPalClock {
  now(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: PayPalColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

/** `2026-01-01T00:00:00Z`. PayPal requires seconds and accepts this form. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class PayPalProvider extends SQLBaseProvider {
  private ready = false;
  private data: NodeTransport | null = null;
  private dataKey = "";
  private accessToken = "";
  private tokenExpiresAt = 0;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
    private readonly clock: PayPalClock = { now: () => Date.now() },
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    readPayPalClientId(this.config.user);
    readPayPalSecret(this.config.password);
    paypalHost(this.config);
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
      await this.bearer(true);
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
    this.accessToken = "";
    this.tokenExpiresAt = 0;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translatePayPalSql(sql);
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
    return { table: { count: PAYPAL_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return PAYPAL_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = paypalResource(name);
    if (found === undefined) throw new QueryError("PayPal has no table with that name.", PROVIDER);
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
        `A PayPal bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("PayPal has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "PayPal REST",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: PAYPAL_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`PayPal declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: PayPalSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= PAYPAL_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const answer = await this.read(statement);
    const rows = paypalRows(statement, paypalEntries(statement.resource.name, answer), sql);
    const warnings: QueryWarning[] = [];
    if (statement.capped || paypalHasMore(answer)) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private async read(statement: PayPalSelect): Promise<unknown> {
    const text = await this.get(statement);
    if (text === "") throw new QueryError("PayPal's answer was not a list.", PROVIDER);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError("PayPal's answer was not a list.", PROVIDER);
    }
  }

  private async get(statement: PayPalSelect): Promise<string> {
    const token = await this.bearer(false);
    const host = paypalHost(this.config);
    const transport = this.transport(host);
    const now = this.clock.now();
    const params = paypalQuery(statement.resource.name, {
      start: stamp(now - WINDOW_MS),
      end: stamp(now),
    });
    const url = endpointUrl(httpOrigin("https", host, 443), statement.resource.path, params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private async bearer(force: boolean): Promise<string> {
    if (!force && this.accessToken !== "" && this.clock.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const minted = await this.exchange();
    this.accessToken = minted.token;
    this.tokenExpiresAt = this.clock.now() + minted.expiresIn * 1000;
    this.dataKey = "";
    return this.accessToken;
  }

  private async exchange(): Promise<{ token: string; expiresIn: number }> {
    const clientId = readPayPalClientId(this.config.user);
    const secret = readPayPalSecret(this.config.password);
    const host = paypalHost(this.config);
    const basic = `Basic ${Buffer.from(`${clientId}:${secret}`, "utf8").toString("base64")}`;
    const transport = this.transport(host);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url: endpointUrl(httpOrigin("https", host, 443), TOKEN_PATH),
        headers: { authorization: basic },
        form: { grant_type: "client_credentials" },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    const text = this.answer(response.status, response.text);
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new QueryError(BAD_TOKEN, PROVIDER);
    }
    if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token === "") {
      throw new QueryError(BAD_TOKEN, PROVIDER);
    }
    const token = parsed.access_token;
    if (!/^[\x21-\x7e]+$/.test(token) || `Bearer ${token}`.length > 1024) {
      throw new QueryError(LONG_TOKEN, PROVIDER);
    }
    const expiresIn = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 300;
    return { token, expiresIn };
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    const message = redactSecret(paypalMessage(text) ?? `PayPal answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) return text;
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    const secrets = [readPayPalSecret(this.config.password), readPayPalClientId(this.config.user)];
    if (this.accessToken !== "") secrets.push(this.accessToken);
    return secrets;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "PayPal could not be reached.",
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

  private transport(host: string): NodeTransport {
    const key = host;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json" },
      requestHeaderNames: ["authorization"],
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private closeTransports(): void {
    this.data?.close();
    this.data = null;
    this.dataKey = "";
  }
}

function paypalMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.message === "string" && parsed.message !== "") {
    return parsed.message.length > 300 ? parsed.message.slice(0, 300) : parsed.message;
  }
  if (typeof parsed.error_description === "string" && parsed.error_description !== "") return parsed.error_description;
  if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
  if (typeof parsed.name === "string" && parsed.name !== "") return parsed.name;
  return undefined;
}
