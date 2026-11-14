/**
 * Custom API provider.
 *
 * The user names a public HTTPS host and the GET paths that become tables. One
 * SELECT reads one of those paths. The secret is sent only to that host, as a
 * header, and never in the URL. A redirect is not followed. Writes are refused
 * before a request. There is no queryReadOnly: agent mode does not speak this
 * dialect.
 */
import { SQLBaseProvider } from "../sql-base";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
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
import { listedRows, translateListedSql, type ListedProduct, type ListedSelect } from "../listed-select";
import { readRestCatalog, restBasicUser, restHost, restSecret, type RestCatalog, type RestResource } from "./catalog";

const PROVIDER = "rest" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "api";
const ROW_CAP = 200;
const REDIRECT_REFUSED = "The API answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "The API's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. This API does not bind parameters.";
const NOT_CONNECTED = "Not connected to this API.";
const BAD_ANSWER = "The API's answer was not JSON.";
const NOT_A_LIST = "The API's answer did not contain a list at that rows path.";
const RATE_LIMIT = "The API is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "This API returned 200 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "This API reads at most 200 rows. An OFFSET past that returns nothing from this subset.";
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([{ id: "schema", label: "API", labelPlural: "APIs" }] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A custom API", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A custom API", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productOf(catalog: RestCatalog): ListedProduct {
  return {
    provider: PROVIDER,
    rowCap: ROW_CAP,
    resources: catalog.resources.map((resource) => ({
      name: resource.name.toLowerCase(),
      primary: resource.name.toLowerCase(),
      path: resource.path,
      columns: [],
    })),
    product: "This API",
    example: catalog.resources[0]?.name ?? "items",
    exampleColumn: "id",
    acceptAnyName: true,
  };
}

function keysOf(entries: readonly unknown[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const key of Object.keys(entry)) {
      if (seen.has(key) || !COLUMN_NAME.test(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function withColumns(statement: ListedSelect, entries: readonly unknown[]): ListedSelect {
  const columns = [...statement.resource.columns];
  const seen = new Set(columns.map((column) => column.name));
  for (const name of statement.columns ?? keysOf(entries)) {
    if (seen.has(name)) continue;
    columns.push({ name, type: "text", json: name });
    seen.add(name);
  }
  return { ...statement, resource: { ...statement.resource, columns } };
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

function entriesAt(body: unknown, rows: string): unknown[] {
  if (rows === "") {
    if (!Array.isArray(body)) throw new QueryError(NOT_A_LIST, PROVIDER);
    return body;
  }
  let cursor: unknown = body;
  for (const part of rows.split(".")) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) throw new QueryError(NOT_A_LIST, PROVIDER);
    cursor = cursor[part];
  }
  if (cursor === null) return [];
  if (!Array.isArray(cursor)) throw new QueryError(NOT_A_LIST, PROVIDER);
  return cursor;
}

function apiMessage(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 300);
  }
  if (!isRecord(parsed)) return text.slice(0, 300);
  const message = typeof parsed.message === "string" ? parsed.message : parsed.error;
  if (typeof message === "string" && message !== "") return message.slice(0, 300);
  return text.slice(0, 300);
}

export class RestProvider extends SQLBaseProvider {
  private ready = false;
  private data: NodeTransport | null = null;
  private dataKey = "";
  private readonly catalog: RestCatalog;
  private readonly host: string;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
  ) {
    super(config, options);
    this.host = restHost(config.host ?? "");
    this.catalog = readRestCatalog(config.apiCatalog);
    restSecret(config.password);
    if (this.catalog.auth === "basic") restBasicUser(config.user);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote: "This table's fields come from the API's answer. Type a field name and completion fills it in.",
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
      searchPlaceholder: "Search resources...",
    };
  }

  public async connect(): Promise<void> {
    if (this.ready) return;
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.data?.close();
    this.data = null;
    this.dataKey = "";
    this.ready = false;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateListedSql(sql, productOf(this.catalog));
    const fields = uniqueFieldNames(statement.columns === null ? keysOf([]) : [...statement.columns]);
    if (statement.offset >= ROW_CAP) {
      return {
        rows: [],
        fields,
        rowCount: 0,
        warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }],
        executionTime: Date.now() - started,
      };
    }
    const resource = this.resourceOrUndefined(statement.resource.name);
    if (resource === undefined) throw new QueryError("This API has no resource with that name.", PROVIDER, sql);
    const entries = entriesAt(await this.read(statement), resource.rows);
    const widened = withColumns(statement, entries);
    const rows = listedRows(productOf(this.catalog), widened, entries, sql);
    const shown = uniqueFieldNames(
      statement.columns === null ? widened.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    const projected = rows.map((row) => project(row, shown));
    const warnings: QueryWarning[] = [];
    if (statement.capped || entries.length >= ROW_CAP) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    return {
      rows: projected,
      fields: shown,
      rowCount: projected.length,
      ...(warnings.length > 0 ? { warnings } : {}),
      executionTime: Date.now() - started,
    };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireReady();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: this.catalog.resources.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.catalog.resources.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    if (this.resourceOrUndefined(name) === undefined) {
      throw new QueryError("This API has no table with that name.", PROVIDER);
    }
    return { path, columns: [], indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A custom API bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("This API has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Custom API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.catalog.resources.length,
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
    if (spec === undefined) throw new QueryError(`This API declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private resourceOrUndefined(name: string): RestResource | undefined {
    const key = name.toLowerCase();
    return this.catalog.resources.find((resource) => resource.name.toLowerCase() === key);
  }

  private async read(statement: ListedSelect): Promise<unknown> {
    const text = await this.get(statement);
    if (text === "") throw new QueryError(BAD_ANSWER, PROVIDER);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async get(statement: ListedSelect): Promise<string> {
    const transport = this.transport();
    const url = endpointUrl(httpOrigin("https", this.host, 443), statement.resource.path);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    const message = redactSecret(apiMessage(text), ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    if (status >= 200 && status < 300) return text;
    throw new QueryError(message === "" ? `The API answered ${status}.` : message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    const secret = restSecret(this.config.password);
    const secrets = [secret];
    if (this.catalog.auth === "basic") {
      secrets.push(Buffer.from(`${restBasicUser(this.config.user)}:${secret}`, "utf8").toString("base64"));
    }
    return secrets;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "The API could not be reached.",
      ...this.hiddenSecrets(),
    );
    if (error instanceof TransportError) return new ConnectionError(hidden, PROVIDER);
    if (error instanceof DatabaseError) return error;
    return new ConnectionError(hidden, PROVIDER);
  }

  private transport(): NodeTransport {
    const secret = restSecret(this.config.password);
    const key = `${this.catalog.auth}\n${secret}\n${this.host}`;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    this.data = this.createTransport({
      origin: httpOrigin("https", this.host, 443),
      tls: { rejectUnauthorized: true, identity: this.host },
      maxSockets: MAX_SOCKETS,
      headers: this.headers(secret),
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private headers(secret: string): Record<string, string> {
    const accept = { Accept: "application/json" };
    if (this.catalog.auth === "bearer") return { ...accept, Authorization: `Bearer ${secret}` };
    if (this.catalog.auth === "basic") {
      const token = Buffer.from(`${restBasicUser(this.config.user)}:${secret}`, "utf8").toString("base64");
      return { ...accept, Authorization: `Basic ${token}` };
    }
    return { ...accept, [this.catalog.headerName]: secret };
  }
}
