/**
 * Intercom provider.
 *
 * Intercom is a REST API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): SELECT and COUNT(*) against one list. Contacts and
 * Conversations with a WHERE are a search. The other lists are one GET, and the
 * filter is applied here. A cursor page is 50 rows. One statement stops at 1000
 * rows. Nothing is copied into another database, and a write is refused before
 * a request.
 *
 * The access token is sent only to an Intercom API host, over TLS, on the shared
 * HTTP transport. That path does not use global fetch, so a proxy variable cannot
 * carry the token. A redirect is not followed. The token is long-lived; Studio
 * does not refresh it.
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
  INTERCOM_ENTITIES,
  INTERCOM_PAGE_SIZE,
  INTERCOM_ROW_CAP,
  intercomQuery,
  translateIntercomSql,
  type IntercomColumn,
  type IntercomEntity,
  type IntercomFilter,
  type IntercomOrder,
  type IntercomStatement,
} from "./translate";

const PROVIDER = "intercom" as const;
const VERSION = "2.17";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "workspace";
const API_HOSTS = new Set(["api.intercom.io", "api.eu.intercom.io", "api.au.intercom.io"]);
const EXACT_HOST =
  "The API host must be api.intercom.io, api.eu.intercom.io, or api.au.intercom.io. The access token is sent only there.";
const TOKEN_REQUIRED = "An Intercom access token is required.";
const TOKEN_LINE = "An Intercom access token must be a single line of printable text.";
const REDIRECT_REFUSED = "Intercom answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Intercom's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Intercom does not bind parameters.";
const NOT_CONNECTED = "Not connected to Intercom.";
const BAD_ANSWER = "Intercom's answer was not a list.";
const RATE_LIMIT = "Intercom is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Intercom returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Intercom reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";
const COUNT_CAP_WARNING = "Intercom counted 1000 rows. Narrow the filter to count the rest.";
const ORDER_CAP_WARNING = "Intercom ordered 1000 rows. Narrow the filter to order the rest.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Workspace", labelPlural: "Workspaces" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "An Intercom", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "An Intercom", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the access token is sent to. An empty host is api.intercom.io. */
export function intercomApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "intercom.io", "api.intercom.io", PROVIDER);
  if (!API_HOSTS.has(host)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The access token, refused when it could split an HTTP header or is too long to send. */
export function intercomToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  if (`Bearer ${token}`.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  }
  return token;
}

function intercomMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  const errors = body.errors;
  if (!Array.isArray(errors) || !isRecord(errors[0])) return undefined;
  const message = errors[0].message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

function sqlType(column: IntercomColumn): string {
  if (column.type === "time") return "bigint";
  if (column.type === "bool") return "boolean";
  if (column.type === "number") return "double";
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

function columnOf(entity: IntercomEntity, name: string): IntercomColumn | undefined {
  return entity.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

function matches(row: Record<string, unknown>, filter: IntercomFilter, column: IntercomColumn | undefined): boolean {
  const value = cell(row, filter.field);
  if (column?.type === "number" || column?.type === "time" || column?.type === "bool") {
    const left = numberOf(value);
    const right = typeof filter.value === "number" ? filter.value : filter.value === true ? 1 : 0;
    if (left === null) return false;
    if (filter.operator === "=") return left === right;
    if (filter.operator === "!=") return left !== right;
    if (filter.operator === "<") return left < right;
    if (filter.operator === "<=") return left <= right;
    if (filter.operator === ">") return left > right;
    return left >= right;
  }
  const left = textOf(value);
  const right = typeof filter.value === "string" ? filter.value : String(filter.value);
  if (filter.operator === "=") return left === right;
  if (filter.operator === "!=") return left !== right;
  if (filter.operator === "^") return left.startsWith(right);
  if (filter.operator === "$") return left.endsWith(right);
  if (filter.operator === "~") return left.includes(right);
  if (filter.operator === "<") return left < right;
  if (filter.operator === "<=") return left <= right;
  if (filter.operator === ">") return left > right;
  return left >= right;
}

function compare(left: unknown, right: unknown, kind: IntercomColumn["type"] | undefined): number {
  if (kind === "number" || kind === "time" || kind === "bool") {
    const a = numberOf(left);
    const b = numberOf(right);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  }
  return textOf(left).localeCompare(textOf(right));
}

function sortRows(rows: Record<string, unknown>[], entity: IntercomEntity, order: IntercomOrder): void {
  const kind = columnOf(entity, order.column)?.type;
  rows.sort((left, right) => {
    const result = compare(cell(left, order.column), cell(right, order.column), kind);
    return order.desc ? -result : result;
  });
}

function startingAfter(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.pages) || !isRecord(body.pages.next)) return undefined;
  const cursor = body.pages.next.starting_after;
  return typeof cursor === "string" && cursor !== "" ? cursor : undefined;
}

function totalCount(body: unknown): number | undefined {
  if (!isRecord(body) || typeof body.total_count !== "number" || !Number.isFinite(body.total_count)) return undefined;
  return body.total_count;
}

interface Page {
  readonly rows: Record<string, unknown>[];
  readonly next: string | undefined;
  readonly total: number | undefined;
}

export class IntercomProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private sent = "";

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
    intercomToken(this.config);
    intercomApiHost(this.config);
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
      const answer = await this.request("GET", "/me", new URLSearchParams(), undefined);
      if (!isRecord(answer)) throw new ConnectionError(BAD_ANSWER, PROVIDER);
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
    const statement = translateIntercomSql(sql);
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
    return { table: { count: INTERCOM_ENTITIES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return INTERCOM_ENTITIES.map((entity) => ({ path: [...container, entity.name], name: entity.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = INTERCOM_ENTITIES.find((entity) => entity.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("Intercom has no table with that name.", PROVIDER);
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
        `An Intercom bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Intercom has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Intercom API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: INTERCOM_ENTITIES.length,
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
    if (spec === undefined) throw new QueryError(`Intercom declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: IntercomStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const entity = intercomQuery(statement);
    const warnings: QueryWarning[] = [];
    if (statement.kind === "count") {
      const counted = await this.countRows(entity, statement.filters);
      if (counted.capped) warnings.push({ message: COUNT_CAP_WARNING, severity: "WARNING" });
      return { rows: [{ totalCount: counted.total }], fields: ["totalCount"], rowCount: 1, warnings };
    }
    const fields = uniqueFieldNames(
      statement.columns === null ? entity.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= INTERCOM_ROW_CAP) {
      warnings.push({ message: OFFSET_WARNING, severity: "WARNING" });
      return { rows: [], fields, rowCount: 0, warnings };
    }
    const read = await this.readRows(entity, statement);
    if (statement.capped) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    if (read.ordered) warnings.push({ message: ORDER_CAP_WARNING, severity: "WARNING" });
    const names = uniqueFieldNames(statement.columns === null ? unionNames(read.rows, fields) : fields);
    return { rows: read.rows.map((row) => project(row, names)), fields: names, rowCount: read.rows.length, warnings };
  }

  private async countRows(
    entity: IntercomEntity,
    filters: readonly IntercomFilter[],
  ): Promise<{ total: number; capped: boolean }> {
    if (entity.paging === "all") {
      const page = await this.page(entity, filters, undefined);
      return { total: this.narrow(entity, page.rows, filters).length, capped: false };
    }
    const first = await this.page(entity, filters, undefined);
    if (first.total !== undefined) return { total: first.total, capped: false };
    let total = this.narrow(entity, first.rows, filters).length;
    let cursor = first.next;
    let full = first.rows.length >= INTERCOM_PAGE_SIZE;
    while (full && cursor !== undefined && total < INTERCOM_ROW_CAP) {
      const page = await this.page(entity, filters, cursor);
      total += this.narrow(entity, page.rows, filters).length;
      full = page.rows.length >= INTERCOM_PAGE_SIZE;
      cursor = page.next === cursor ? undefined : page.next;
      if (!full) break;
    }
    return {
      total: Math.min(total, INTERCOM_ROW_CAP),
      capped: full && total >= INTERCOM_ROW_CAP && cursor !== undefined,
    };
  }

  private async readRows(
    entity: IntercomEntity,
    statement: Extract<IntercomStatement, { kind: "select" }>,
  ): Promise<{ rows: Record<string, unknown>[]; ordered: boolean }> {
    const want = Math.min(INTERCOM_ROW_CAP, statement.offset + statement.limit);
    const ordering = statement.orderBy !== null && entity.paging === "cursor";
    const stop = ordering ? INTERCOM_ROW_CAP : want;
    const collected: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let ordered = false;
    for (;;) {
      const page = await this.page(entity, statement.filters, cursor);
      collected.push(...this.narrow(entity, page.rows, statement.filters));
      const next = page.next !== undefined && page.next !== cursor ? page.next : undefined;
      const short = page.rows.length < (entity.paging === "cursor" ? INTERCOM_PAGE_SIZE : page.rows.length + 1);
      if (entity.paging === "all" || short || next === undefined || collected.length >= stop) {
        const overflow = collected.length > stop;
        if (overflow) collected.length = stop;
        ordered = ordering && (overflow || (!short && next !== undefined && collected.length >= INTERCOM_ROW_CAP));
        break;
      }
      cursor = next;
    }
    if (statement.orderBy !== null) sortRows(collected, entity, statement.orderBy);
    return { rows: collected.slice(statement.offset, want), ordered };
  }

  private narrow(
    entity: IntercomEntity,
    rows: readonly Record<string, unknown>[],
    filters: readonly IntercomFilter[],
  ): Record<string, unknown>[] {
    if (filters.length === 0) return [...rows];
    return rows.filter((row) => filters.every((filter) => matches(row, filter, columnOf(entity, filter.field))));
  }

  private async page(
    entity: IntercomEntity,
    filters: readonly IntercomFilter[],
    cursor: string | undefined,
  ): Promise<Page> {
    const searching = entity.search !== null && filters.length > 0;
    const params = new URLSearchParams();
    let path = `/${entity.path}`;
    let body: string | undefined;
    if (searching && entity.search !== null) {
      path = `/${entity.search}`;
      const pagination: Record<string, string | number> = { per_page: INTERCOM_PAGE_SIZE };
      if (cursor !== undefined) pagination.starting_after = cursor;
      body = JSON.stringify({
        query: {
          operator: "AND",
          value: filters.map((filter) => ({ field: filter.field, operator: filter.operator, value: filter.value })),
        },
        pagination,
      });
    } else if (entity.paging === "cursor") {
      params.set("per_page", String(INTERCOM_PAGE_SIZE));
      if (cursor !== undefined) params.set("starting_after", cursor);
    }
    const answer = await this.request(searching ? "POST" : "GET", path, params, body);
    return { rows: this.rowsOf(answer, entity), next: startingAfter(answer), total: totalCount(answer) };
  }

  private rowsOf(body: unknown, entity: IntercomEntity): Record<string, unknown>[] {
    if (!isRecord(body) || !Object.hasOwn(body, entity.responseKey)) throw new QueryError(BAD_ANSWER, PROVIDER);
    const list = body[entity.responseKey];
    if (!Array.isArray(list)) throw new QueryError(BAD_ANSWER, PROVIDER);
    return list.map((entry) => flattenRecord(entry));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    params: URLSearchParams,
    body: string | undefined,
  ): Promise<unknown> {
    const token = intercomToken(this.config);
    const host = intercomApiHost(this.config);
    const transport = this.open(host, token);
    const url = endpointUrl(httpOrigin("https", host, 443), path, params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method,
        url,
        body,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    let parsed: unknown = {};
    if (response.text !== "") {
      try {
        parsed = JSON.parse(response.text) as unknown;
      } catch {
        if (response.status >= 200 && response.status < 300) throw new QueryError(BAD_ANSWER, PROVIDER);
        parsed = { message: response.text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(intercomMessage(parsed) ?? `Intercom answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return parsed;
  }

  private wireFailure(error: unknown, token: string, host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, token), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Intercom could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private open(host: string, token: string): NodeTransport {
    const stamp = `${host}\n${token}`;
    if (this.transport !== null && this.sent === stamp) return this.transport;
    this.closeTransport();
    this.sent = stamp;
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Intercom-Version": VERSION,
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.transport;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
    this.sent = "";
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
