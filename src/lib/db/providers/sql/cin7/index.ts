/**
 * Cin7 Core provider.
 *
 * Cin7 Core is an inventory API, not a SQL server and not Cin7 Omni. The editor
 * runs a small SQL subset (`translate.ts`): SELECT and COUNT(*) against one listed
 * resource. Each statement is one GET. Nothing is copied into another database, and
 * a write is refused before a request.
 *
 * The account id and the application key are sent only to inventory.dearsystems.com,
 * over TLS, on the shared HTTP transport. That path does not use global fetch, so a
 * proxy variable cannot carry the key. A redirect is not followed.
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
import { API_ANSWER_LIMIT, assignOwnField, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { CIN7_RESOURCES, cin7Resource, translateCin7Sql, type Cin7Statement } from "./translate";

const PROVIDER = "cin7" as const;
const API_HOST = "inventory.dearsystems.com";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "account";
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_HOST = "The API host must be inventory.dearsystems.com. The application key is sent only there.";
const KEY_REQUIRED = "A Cin7 Core application key is required.";
const KEY_LINE = "A Cin7 Core application key must be a single line of printable text.";
const ACCOUNT_REQUIRED = "A Cin7 Core account id is required.";
const REDIRECT_REFUSED = "Cin7 Core answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Cin7 Core's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Cin7 Core does not bind parameters.";
const NOT_CONNECTED = "Not connected to Cin7 Core.";
const PAGE_WARNING = "Cin7 Core returned this page only. Raise LIMIT or add OFFSET for the next page.";
const CAP_WARNING = "Cin7 Core returns at most 1000 rows in one page. This query asked for more, so the page is 1000.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Cin7 Core", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Cin7 Core", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the account id and application key are sent to. Only the Core API host is accepted. */
export function cin7ApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "dearsystems.com", API_HOST, PROVIDER);
  if (host !== API_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The application key, refused when it could split an HTTP header or is too long to send. */
export function cin7ApplicationKey(config: DatabaseConnection): string {
  const key = config.password?.trim() ?? "";
  if (key === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return key;
}

/** The account id, a GUID. The census database name is not an account. */
export function cin7AccountId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (!ACCOUNT_ID.test(id)) throw new DatabaseConfigError(ACCOUNT_REQUIRED, PROVIDER);
  return id;
}

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function cin7Message(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return firstText(body, ["Exception", "ErrorMessage", "Message", "message"]);
}

function writeFields(row: Record<string, unknown>, source: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(source)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (isRecord(value)) {
      writeFields(row, value, name);
      continue;
    }
    assignOwnField(row, name, Array.isArray(value) ? null : value);
  }
}

function flattenRecord(value: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (isRecord(value)) writeFields(row, value, "");
  return row;
}

function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const found = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? null : row[found];
}

function unionNames(rows: readonly Record<string, unknown>[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names.length === 0 ? ["ID"] : names;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, cell(row, field));
  return projected;
}

export class Cin7Provider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private bound: { account: string; key: string } | null = null;

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
    cin7ApplicationKey(this.config);
    cin7ApiHost(this.config);
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
    cin7AccountId(this.config);
    try {
      const body = await this.request("/me", new URLSearchParams());
      if (!isRecord(body) || typeof body.Company !== "string" || body.Company === "") {
        throw new ConnectionError("Cin7 Core did not return the account.", PROVIDER);
      }
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
    cin7AccountId(this.config);
    const started = Date.now();
    const statement = translateCin7Sql(sql);
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
    return { table: { count: CIN7_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return CIN7_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = cin7Resource(name);
    if (found === null) throw new QueryError("Cin7 Core has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.name !== "ID" && column.name !== "SaleID" && column.name !== "Code",
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Cin7 Core bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Cin7 Core has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Cin7 Core External API v2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: CIN7_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Cin7 Core declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: Cin7Statement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const params = new URLSearchParams();
    for (const filter of statement.filters) params.set(filter.param, filter.value);
    if (statement.kind === "count") {
      params.set("Page", "1");
      params.set("Limit", "1");
      const body = await this.request(statement.resource.path, params);
      const total = totalCount(body);
      return { rows: [{ [statement.alias]: total }], fields: [statement.alias], rowCount: 1, warnings: [] };
    }
    const page = statement.offset / statement.limit + 1;
    params.set("Page", String(page));
    params.set("Limit", String(statement.limit));
    const body = await this.request(statement.resource.path, params);
    const rows = listRows(body, statement.resource.listKey);
    const warnings: QueryWarning[] = [];
    if (statement.capped) warnings.push({ message: CAP_WARNING, severity: "WARNING" });
    if (rows.length === statement.limit) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
    const fields = uniqueFieldNames(statement.columns === null ? unionNames(rows) : [...statement.columns]);
    const projected = rows.map((row) => project(row, fields));
    return { rows: projected, fields, rowCount: projected.length, warnings };
  }

  private ensureTransport(): NodeTransport {
    const account = cin7AccountId(this.config);
    const key = cin7ApplicationKey(this.config);
    if (this.transport !== null && this.bound?.account === account && this.bound.key === key) return this.transport;
    this.closeTransport();
    this.bound = { account, key };
    const host = cin7ApiHost(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        "api-auth-accountid": account,
        "api-auth-applicationkey": key,
        Accept: "application/json",
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.transport;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
    this.bound = null;
  }

  private wireFailure(error: unknown, secrets: readonly string[], host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, ...secrets), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Cin7 Core could not be reached.";
    return new ConnectionError(redactSecret(message, ...secrets), PROVIDER, host);
  }

  private async request(path: string, params: URLSearchParams): Promise<unknown> {
    const key = cin7ApplicationKey(this.config);
    const account = cin7AccountId(this.config);
    const host = cin7ApiHost(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(httpOrigin("https", host, 443), `/ExternalApi/v2${path}`, params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, [key, account], host);
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
      const message = redactSecret(
        cin7Message(body) ?? `Cin7 Core answered ${response.status}.`,
        key,
        account,
      );
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    if (isRecord(body) && typeof body.Exception === "string" && body.Exception !== "") {
      throw new QueryError(redactSecret(body.Exception, key, account), PROVIDER);
    }
    return body;
  }
}

function totalCount(body: unknown): number {
  if (!isRecord(body) || typeof body.Total !== "number") {
    throw new QueryError("Cin7 Core did not return a count.", PROVIDER);
  }
  return body.Total;
}

function listRows(body: unknown, listKey: string): Record<string, unknown>[] {
  if (!isRecord(body)) throw new QueryError("Cin7 Core did not return a list.", PROVIDER);
  if (!Object.hasOwn(body, listKey)) throw new QueryError("Cin7 Core did not return a list.", PROVIDER);
  const list = body[listKey];
  if (!Array.isArray(list)) throw new QueryError("Cin7 Core did not return a list.", PROVIDER);
  return list.map((entry) => flattenRecord(entry));
}
