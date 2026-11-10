/**
 * Xero provider.
 *
 * Xero is an accounting API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): SELECT and COUNT(*) against one list. Each statement is one
 * request. Nothing is copied into another database, and a write is refused before
 * a request. Reports and attachments stay out.
 *
 * The access token is sent only to api.xero.com, over TLS, on the shared HTTP
 * transport. That path does not use global fetch, so a proxy variable cannot carry
 * the token. A redirect is not followed. The token is not refreshed: a Xero refresh
 * token rotates, and refreshing it without storing the new one locks the organisation out.
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
  XERO_ENTITIES,
  XERO_PAGE_SIZE,
  XERO_ROW_CAP,
  xeroEntity,
  xeroQuery,
  translateXeroSql,
  type XeroEntity,
  type XeroStatement,
} from "./translate";

const PROVIDER = "xero" as const;
const API_HOST = "api.xero.com";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "organisation";
const EXACT_HOST = "The API host must be api.xero.com. The access token is sent only there.";
const TOKEN_REQUIRED = "A Xero access token is required.";
const TOKEN_LINE = "A Xero access token must be a single line of printable text.";
const TENANT_REQUIRED = "A Xero organisation id is required. It is the tenant id, a UUID.";
const REDIRECT_REFUSED = "Xero answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Xero's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Xero does not bind parameters.";
const NOT_CONNECTED = "Not connected to Xero.";
const BAD_ANSWER = "Xero's answer was not a list.";
const RATE_LIMIT = "Xero is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Xero returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Xero reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";
const COUNT_CAP_WARNING = "Xero counted 1000 rows. Narrow the filter to count the rest.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Organisation", labelPlural: "Organisations" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Xero", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Xero", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the access token is sent to. Only api.xero.com is accepted. */
export function xeroApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "xero.com", API_HOST, PROVIDER);
  if (host !== API_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The access token, refused when it could split an HTTP header or is too long to send. */
export function xeroToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return token;
}

/** The organisation id sent as Xero-Tenant-Id. A UUID, so the census database name is not one. */
export function xeroTenantId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new DatabaseConfigError(TENANT_REQUIRED, PROVIDER);
  }
  return id.toLowerCase();
}

function xeroMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.Message === "string" && body.Message !== "") return body.Message;
  if (typeof body.Detail === "string" && body.Detail !== "") return body.Detail;
  if (typeof body.Title === "string" && body.Title !== "") return body.Title;
  return undefined;
}

function sqlType(type: string): string {
  if (type === "double") return "double";
  if (type === "boolean") return "boolean";
  if (type === "date") return "date";
  return "varchar";
}

function writeFields(
  row: Record<string, unknown>,
  source: Record<string, unknown>,
  prefix: string,
  depth: number,
): void {
  for (const [key, value] of Object.entries(source)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (Array.isArray(value)) {
      assignOwnField(row, name, JSON.stringify(value));
      continue;
    }
    if (isRecord(value) && depth < 1) {
      writeFields(row, value, name, depth + 1);
      continue;
    }
    assignOwnField(row, name, isRecord(value) ? JSON.stringify(value) : value);
  }
}

function flattenRecord(value: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (isRecord(value)) writeFields(row, value, "", 0);
  return row;
}

function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const found = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? null : row[found];
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, cell(row, field));
  return projected;
}

function pageCountOf(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.pagination)) return undefined;
  return typeof body.pagination.pageCount === "number" ? body.pagination.pageCount : undefined;
}

function itemCountOf(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.pagination)) return undefined;
  return typeof body.pagination.itemCount === "number" ? body.pagination.itemCount : undefined;
}

export class XeroProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private tenant: string | null = null;

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
    xeroToken(this.config);
    xeroApiHost(this.config);
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
    xeroTenantId(this.config);
    try {
      await this.request("/api.xro/2.0/Organisation", new URLSearchParams());
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
    xeroTenantId(this.config);
    const started = Date.now();
    const statement = translateXeroSql(sql);
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
    return { table: { count: XERO_ENTITIES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return XERO_ENTITIES.map((entity) => ({ path: [...container, entity.name], name: entity.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = xeroEntity(name);
    if (found === null) throw new QueryError("Xero has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: sqlType(column.type),
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
        `A Xero bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Xero has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Xero Accounting API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: XERO_ENTITIES.length,
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
    if (spec === undefined) throw new QueryError(`Xero declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(statement: XeroStatement): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const query = xeroQuery(statement);
    const entity = query.entity;
    const warnings: QueryWarning[] = [];
    if (statement.kind === "count") {
      const counted = await this.countRows(entity, query.where);
      if (counted.capped) warnings.push({ message: COUNT_CAP_WARNING, severity: "WARNING" });
      return { rows: [{ totalCount: counted.total }], fields: ["totalCount"], rowCount: 1, warnings };
    }
    const fields = uniqueFieldNames(
      statement.columns === null ? entity.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= XERO_ROW_CAP) {
      warnings.push({ message: OFFSET_WARNING, severity: "WARNING" });
      return { rows: [], fields, rowCount: 0, warnings };
    }
    const read = await this.readRows(entity, query.where, query.order, statement.offset, statement.limit);
    if (statement.capped) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const names = uniqueFieldNames(statement.columns === null ? unionNames(read.rows, fields) : fields);
    const projected = read.rows.map((row) => project(row, names));
    return { rows: projected, fields: names, rowCount: projected.length, warnings };
  }

  private async countRows(entity: XeroEntity, where: string | null): Promise<{ total: number; capped: boolean }> {
    if (entity.paging === "all") {
      return { total: this.rowsOf(await this.get(entity, where, null, undefined), entity).length, capped: false };
    }
    let page = 1;
    let total = 0;
    let capped = false;
    for (;;) {
      const body = await this.get(entity, where, null, page);
      if (page === 1) {
        const exact = itemCountOf(body);
        if (exact !== undefined) return { total: exact, capped: false };
      }
      const list = this.rowsOf(body, entity);
      total += list.length;
      const pages = pageCountOf(body);
      const full = list.length === XERO_PAGE_SIZE;
      if (!full || (pages !== undefined && page >= pages) || total >= XERO_ROW_CAP) {
        capped = full && total >= XERO_ROW_CAP && (pages === undefined || page < pages);
        break;
      }
      page += 1;
    }
    return { total, capped };
  }

  private async readRows(
    entity: XeroEntity,
    where: string | null,
    order: string | null,
    offset: number,
    limit: number,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const want = Math.min(XERO_ROW_CAP, offset + limit);
    if (entity.paging === "all") {
      const all = this.rowsOf(await this.get(entity, where, order, undefined), entity);
      return { rows: all.slice(offset, want) };
    }
    const collected: Record<string, unknown>[] = [];
    let page = 1;
    while (collected.length < want) {
      const body = await this.get(entity, where, order, page);
      const list = this.rowsOf(body, entity);
      collected.push(...list);
      const pages = pageCountOf(body);
      if (list.length < XERO_PAGE_SIZE || (pages !== undefined && page >= pages)) break;
      page += 1;
    }
    return { rows: collected.slice(offset, want) };
  }

  private rowsOf(body: unknown, entity: XeroEntity): Record<string, unknown>[] {
    if (!isRecord(body) || !Object.hasOwn(body, entity.responseKey)) throw new QueryError(BAD_ANSWER, PROVIDER);
    const list = body[entity.responseKey];
    if (!Array.isArray(list)) throw new QueryError(BAD_ANSWER, PROVIDER);
    return list.map((entry) => flattenRecord(entry));
  }

  private ensureTransport(): NodeTransport {
    const host = xeroApiHost(this.config);
    const token = xeroToken(this.config);
    const tenant = xeroTenantId(this.config);
    if (this.transport !== null && this.tenant === tenant) return this.transport;
    this.closeTransport();
    this.tenant = tenant;
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Xero-Tenant-Id": tenant,
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.transport;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
    this.tenant = null;
  }

  private wireFailure(error: unknown, token: string, host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, token), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Xero could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async get(
    entity: XeroEntity,
    where: string | null,
    order: string | null,
    page: number | undefined,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (where !== null) params.set("where", where);
    if (order !== null) params.set("order", order);
    if (page !== undefined) params.set("page", String(page));
    return this.request(`/api.xro/2.0/${encodeURIComponent(entity.path)}`, params);
  }

  private async request(path: string, params: URLSearchParams): Promise<unknown> {
    const token = xeroToken(this.config);
    const host = xeroApiHost(this.config);
    xeroTenantId(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(httpOrigin("https", host, 443), path, params);
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
    if (response.status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        if (response.status >= 200 && response.status < 300) throw new QueryError(BAD_ANSWER, PROVIDER);
        body = { Message: text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(xeroMessage(body) ?? `Xero answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function unionNames(rows: readonly Record<string, unknown>[], fallback: readonly string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names.length === 0 ? [...fallback] : names;
}
