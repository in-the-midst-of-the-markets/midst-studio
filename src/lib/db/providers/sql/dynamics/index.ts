/**
 * Microsoft Dynamics provider.
 *
 * Dynamics 365 (Dataverse) is a Web API, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): SELECT and COUNT(*) against one standard table. The filter, the
 * order and the page are OData on that request. One statement stops at 1000 rows. Nothing
 * is copied into another database, and a write is refused before a request.
 *
 * An access token is sent only to the organization's Dynamics 365 host. A client secret is
 * sent only to login.microsoftonline.com, and the access token that comes back is what the
 * organization host sees. Both calls use the shared HTTP transport, so a proxy variable
 * cannot carry the secret. A redirect is not followed. A pasted access token is not refreshed.
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
  dynamicsCredential,
  dynamicsOrgHost,
  DYNAMICS_TOKEN_HOST,
  readDynamicsTokenGrant,
  type DynamicsCredential,
  type DynamicsTokenGrant,
} from "./auth";
import {
  DYNAMICS_ENTITIES,
  DYNAMICS_ROW_CAP,
  dynamicsEntity,
  dynamicsOData,
  translateDynamicsSql,
  type DynamicsColumn,
  type DynamicsEntity,
  type DynamicsStatement,
} from "./translate";

const PROVIDER = "dynamics" as const;
const API_VERSION = "v9.2";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "organization";
const REDIRECT_REFUSED = "Dynamics answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Dynamics's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Dynamics does not bind parameters.";
const NOT_CONNECTED = "Not connected to Dynamics.";
const BAD_ANSWER = "Dynamics's answer was not a list.";
const RATE_LIMIT = "Dynamics is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Dynamics returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Dynamics reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Organization", labelPlural: "Organizations" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Dynamics", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Dynamics", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: DynamicsColumn): string {
  if (column.type === "time") return "timestamptz";
  if (column.type === "bool") return "boolean";
  if (column.type === "number") return "double";
  return "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, Object.hasOwn(row, field) ? row[field] : null);
  return projected;
}

function cellValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

export class DynamicsProvider extends SQLBaseProvider {
  private ready = false;
  private grant: DynamicsTokenGrant | null = null;
  private data: NodeTransport | null = null;
  private dataToken = "";
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
    dynamicsCredential(this.config);
    dynamicsOrgHost(this.config);
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
      const answer = await this.json("GET", `/api/data/${API_VERSION}/WhoAmI`, new URLSearchParams());
      if (!isRecord(answer) || typeof answer.UserId !== "string") throw new ConnectionError(BAD_ANSWER, PROVIDER);
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
    const statement = translateDynamicsSql(sql);
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
    return { table: { count: DYNAMICS_ENTITIES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return DYNAMICS_ENTITIES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = dynamicsEntity(name);
    if (found === undefined) throw new QueryError("Dynamics has no table with that name.", PROVIDER);
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
        `A Dynamics bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Dynamics has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Dataverse Web API v9.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: DYNAMICS_ENTITIES.length,
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
    if (spec === undefined) throw new QueryError(`Dynamics declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: DynamicsStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") return this.countRows(sql, statement);
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.entity.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= DYNAMICS_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const top = Math.min(statement.limit, DYNAMICS_ROW_CAP - statement.offset);
    const page = { ...statement, limit: top };
    const request = dynamicsOData(page, sql);
    const answer = await this.json("GET", request.path, request.params);
    const rows = this.rowsOf(answer, statement.entity);
    const warnings: QueryWarning[] = [];
    if (statement.capped) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private async countRows(
    sql: string,
    statement: Extract<DynamicsStatement, { kind: "count" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount">> {
    const request = dynamicsOData(statement, sql);
    const text = await this.text("GET", request.path, request.params);
    if (!/^\d+$/.test(text.trim())) throw new QueryError(BAD_ANSWER, PROVIDER);
    return {
      rows: [{ [statement.alias]: Number(text.trim()) }],
      fields: [statement.alias],
      rowCount: 1,
    };
  }

  private rowsOf(body: unknown, entity: DynamicsEntity): Record<string, unknown>[] {
    if (!isRecord(body) || !Array.isArray(body.value)) throw new QueryError(BAD_ANSWER, PROVIDER);
    return body.value.map((entry) => this.rowOf(entry, entity));
  }

  private rowOf(entry: unknown, entity: DynamicsEntity): Record<string, unknown> {
    if (!isRecord(entry)) throw new QueryError(BAD_ANSWER, PROVIDER);
    const row: Record<string, unknown> = {};
    for (const column of entity.columns) {
      if (!Object.hasOwn(entry, column.select)) continue;
      assignOwnField(row, column.name, cellValue(entry[column.select]));
    }
    return row;
  }

  private async json(method: "GET", path: string, params: URLSearchParams): Promise<unknown> {
    const text = await this.text(method, path, params);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async text(method: "GET", path: string, params: URLSearchParams): Promise<string> {
    const token = await this.accessToken();
    const host = dynamicsOrgHost(this.config);
    const transport = this.dataTransport(host, token);
    const url = endpointUrl(httpOrigin("https", host, 443), path, params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method,
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private async accessToken(): Promise<string> {
    const credential = dynamicsCredential(this.config);
    if (credential.kind === "token") return credential.token;
    const cached = this.grant;
    const now = this.now();
    if (cached !== null && cached.expiresAt > now) return cached.token;
    const grant = await this.exchange(credential);
    this.grant = grant;
    return grant.token;
  }

  private async exchange(credential: Extract<DynamicsCredential, { kind: "client" }>): Promise<DynamicsTokenGrant> {
    const host = dynamicsOrgHost(this.config);
    const transport = this.tokenChannel();
    const url = endpointUrl(httpOrigin("https", DYNAMICS_TOKEN_HOST, 443), `/${credential.tenantId}/oauth2/v2.0/token`);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        form: {
          grant_type: "client_credentials",
          client_id: credential.clientId,
          client_secret: credential.secret,
          scope: `https://${host}/.default`,
        },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: 64 * 1024,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    return readDynamicsTokenGrant(response.status, response.text, this.now(), [credential.secret]);
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    if (status >= 200 && status < 300) return text;
    const secret = this.secretText();
    const message = redactSecret(dynamicsMessage(text) ?? `Dynamics answered ${status}.`, secret);
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    throw new QueryError(message, PROVIDER);
  }

  private secretText(): string {
    const credential = dynamicsCredential(this.config);
    return credential.kind === "token" ? credential.token : credential.secret;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Dynamics could not be reached.",
      this.secretText(),
      this.grant?.token ?? "",
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

  private dataTransport(host: string, token: string): NodeTransport {
    if (this.data !== null && this.dataToken === token) return this.data;
    this.data?.close();
    this.dataToken = token;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private tokenChannel(): NodeTransport {
    if (this.tokenTransport !== null) return this.tokenTransport;
    this.tokenTransport = this.createTransport({
      origin: httpOrigin("https", DYNAMICS_TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: DYNAMICS_TOKEN_HOST },
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
    this.dataToken = "";
    this.grant = null;
  }
}

function dynamicsMessage(text: string): string | undefined {
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

export { dynamicsCredential, dynamicsOrgHost, DYNAMICS_ENTITIES };
