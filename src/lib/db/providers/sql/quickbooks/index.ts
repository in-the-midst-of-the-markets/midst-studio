/**
 * QuickBooks Online provider.
 *
 * QuickBooks Online is an accounting API, not a SQL server and not QuickBooks Desktop.
 * The editor runs a small SQL subset (`translate.ts`): SELECT and COUNT(*) against one
 * entity. Each statement is one query. Nothing is copied into another database, and a
 * write is refused before a request.
 *
 * The access token is sent only to quickbooks.api.intuit.com or
 * sandbox-quickbooks.api.intuit.com, over TLS, on the shared HTTP transport. That path
 * does not use global fetch, so a proxy variable cannot carry the token. A redirect is
 * not followed. The token is not refreshed: an Intuit refresh token rotates, and
 * refreshing it without storing the new one locks the company out.
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
import {
  QUICKBOOKS_ENTITIES,
  quickbooksEntity,
  quickbooksQueryText,
  translateQuickBooksSql,
  type QuickBooksStatement,
} from "./translate";

const PROVIDER = "quickbooks" as const;
const PRODUCTION_HOST = "quickbooks.api.intuit.com";
const SANDBOX_HOST = "sandbox-quickbooks.api.intuit.com";
const MAX_SOCKETS = 4;
const MINOR_VERSION = "75";
const CONTAINER_NAME = "company";
const EXACT_HOST =
  "The API host must be quickbooks.api.intuit.com or sandbox-quickbooks.api.intuit.com. The access token is sent only there.";
const TOKEN_REQUIRED = "A QuickBooks Online access token is required.";
const TOKEN_LINE = "A QuickBooks Online access token must be a single line of printable text.";
const COMPANY_REQUIRED = "A QuickBooks Online company id is required.";
const REDIRECT_REFUSED = "QuickBooks Online answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "QuickBooks Online's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. QuickBooks Online does not bind parameters.";
const NOT_CONNECTED = "Not connected to QuickBooks Online.";
const PAGE_WARNING = "QuickBooks Online returned this page only. Raise LIMIT or add OFFSET for the next page.";
const CAP_WARNING =
  "QuickBooks Online returns at most 1000 rows in one page. This query asked for more, so the page is 1000.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Company", labelPlural: "Companies" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A QuickBooks Online", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A QuickBooks Online",
  attachedSegment: "required",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the access token is sent to. Only the two Intuit API hosts are accepted. */
export function quickbooksApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "intuit.com", PRODUCTION_HOST, PROVIDER);
  if (host !== PRODUCTION_HOST && host !== SANDBOX_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The access token, refused when it could split an HTTP header or is too long to send. */
export function quickbooksToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return token;
}

/** The company id in the query path. Digits only, so the census database name is not a company. */
export function quickbooksCompanyId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (!/^[0-9]{1,20}$/.test(id)) throw new DatabaseConfigError(COMPANY_REQUIRED, PROVIDER);
  return id;
}

function firstText(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function quickbooksMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const direct = firstText(body, ["message", "Message"]);
  if (direct !== undefined) return direct;
  const fault = isRecord(body.Fault) ? body.Fault : isRecord(body.fault) ? body.fault : undefined;
  if (fault === undefined) return undefined;
  const errors = fault.Error ?? fault.error;
  if (!Array.isArray(errors) || !isRecord(errors[0])) return undefined;
  return firstText(errors[0], ["Message", "message", "Detail", "detail"]);
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
  return names.length === 0 ? ["Id"] : names;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, cell(row, field));
  return projected;
}

export class QuickBooksProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;

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
    quickbooksToken(this.config);
    quickbooksApiHost(this.config);
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
    quickbooksCompanyId(this.config);
    try {
      await this.request("SELECT Id FROM CompanyInfo MAXRESULTS 1");
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
    quickbooksCompanyId(this.config);
    const started = Date.now();
    const statement = translateQuickBooksSql(sql);
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
    return { table: { count: QUICKBOOKS_ENTITIES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return QUICKBOOKS_ENTITIES.map((entity) => ({ path: [...container, entity.name], name: entity.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = quickbooksEntity(name);
    if (found === null) throw new QueryError("QuickBooks Online has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.name !== "Id",
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A QuickBooks Online bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(
      new QueryError("QuickBooks Online has no maintenance operation for Studio to run.", PROVIDER),
    );
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "QuickBooks Online Query API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: QUICKBOOKS_ENTITIES.length,
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
    if (spec === undefined) throw new QueryError(`QuickBooks Online declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: QuickBooksStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const body = await this.request(quickbooksQueryText(statement));
    const warnings: QueryWarning[] = [];
    if (statement.kind === "count") {
      const total = totalCount(body);
      return { rows: [{ totalCount: total }], fields: ["totalCount"], rowCount: 1, warnings };
    }
    const rows = entityRows(body, statement.entity);
    if (statement.capped) warnings.push({ message: CAP_WARNING, severity: "WARNING" });
    if (rows.length === statement.limit) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
    const fields = uniqueFieldNames(statement.columns === null ? unionNames(rows) : [...statement.columns]);
    const projected = rows.map((row) => project(row, fields));
    return { rows: projected, fields, rowCount: projected.length, warnings };
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = quickbooksApiHost(this.config);
    const token = quickbooksToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
    const message = error instanceof Error ? error.message : "QuickBooks Online could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async request(query: string): Promise<unknown> {
    const token = quickbooksToken(this.config);
    const host = quickbooksApiHost(this.config);
    const companyId = quickbooksCompanyId(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(
      httpOrigin("https", host, 443),
      `/v3/company/${encodeURIComponent(companyId)}/query`,
      new URLSearchParams({ query, minorversion: MINOR_VERSION }),
    );
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
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
      const message = redactSecret(quickbooksMessage(body) ?? `QuickBooks Online answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    if (isRecord(body) && (isRecord(body.Fault) || isRecord(body.fault))) {
      throw new QueryError(
        redactSecret(quickbooksMessage(body) ?? "QuickBooks Online rejected the query.", token),
        PROVIDER,
      );
    }
    return body;
  }
}

function queryResponse(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.QueryResponse)) {
    throw new QueryError("QuickBooks Online did not return a query.", PROVIDER);
  }
  return body.QueryResponse;
}

function totalCount(body: unknown): number {
  const response = queryResponse(body);
  if (typeof response.totalCount !== "number") {
    throw new QueryError("QuickBooks Online did not return a count.", PROVIDER);
  }
  return response.totalCount;
}

function entityRows(body: unknown, entity: string): Record<string, unknown>[] {
  const response = queryResponse(body);
  const key = Object.keys(response).find((name) => name.toLowerCase() === entity.toLowerCase());
  if (key === undefined) return [];
  const list = response[key];
  if (!Array.isArray(list)) throw new QueryError("QuickBooks Online did not return a query.", PROVIDER);
  return list.map((entry) => flattenRecord(entry));
}
