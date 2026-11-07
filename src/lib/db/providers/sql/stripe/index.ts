/**
 * Stripe provider.
 *
 * Stripe is a REST API, not a SQL server. The editor still runs a small SQL subset
 * (`translate.ts`): SELECT with columns, WHERE, ORDER BY created, LIMIT and OFFSET, and
 * COUNT(*). Each statement is sent to the Stripe API. Nothing is copied into another
 * database, and a write is refused before a request.
 *
 * The secret key is sent only to api.stripe.com, over TLS, on the shared HTTP transport.
 * That path does not use global fetch, so a proxy variable cannot carry the key. A redirect
 * is not followed. A result contains only the columns this connection declares, so a field
 * such as a payment intent's client_secret is not returned.
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
  callerBoundTruncationReason,
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
import type { ColumnSchema, QueryWarning } from "@/lib/types";
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
  stripeColumns,
  stripeListQuery,
  stripeObject,
  stripeSearchQuery,
  STRIPE_OBJECTS,
  type StripeColumn,
  type StripeFilter,
  type StripeObject,
} from "./objects";
import { translateStripeSql, type StripeSelect, type StripeStatement } from "./translate";

const PROVIDER = "stripe" as const;
const DEFAULT_HOST = "api.stripe.com";
const STRIPE_VERSION = "2026-10-28.endive";
const MAX_SOCKETS = 4;
const DEADLINE_MS = 60_000;
const EXACT_HOST = "The API host must be api.stripe.com. The secret key is sent only there.";
const KEY_REQUIRED = "A Stripe secret key is required.";
const KEY_LINE = "A Stripe secret key must be a single line of printable text.";
const REDIRECT_REFUSED = "Stripe answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Stripe's answer was larger than 2 MB and was not read.";
const CONTAINER_NAME = "account";
const MAX_ROWS = 1000;
const PAGE_SIZE = 100;
const COUNT_CAP = 10000;
const PARAMS_REFUSED = "Write the value in the statement. Stripe does not bind parameters.";
const NOT_CONNECTED = "Not connected to Stripe.";
const CAP_WARNING = "Stripe returned the first 1000 matching rows. Add a WHERE clause to narrow them.";
const COUNT_CAP_WARNING = "Stripe reports a count of 10000 when more objects match. Add a WHERE clause to narrow them.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Object", labelPlural: "Objects", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Stripe", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Stripe", attachedSegment: "required" };

interface StripeRecord {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface StripePage {
  readonly records: readonly StripeRecord[];
  readonly hasMore: boolean;
  readonly nextPage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the secret key is sent to. Only api.stripe.com is accepted. */
export function stripeApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "stripe.com", DEFAULT_HOST, PROVIDER);
  if (host !== DEFAULT_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The secret key, refused when it could split an HTTP header or is too long to send. */
function stripeToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return token;
}

function stripeMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message;
  }
  if (typeof body.message === "string" && body.message !== "") return body.message;
  return undefined;
}

function readRecord(entry: unknown): StripeRecord {
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
    throw new QueryError("Stripe returned a record with no id.", PROVIDER);
  }
  return { id: entry.id, fields: entry };
}

function readPage(body: unknown): StripePage {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new QueryError("Stripe did not return records.", PROVIDER);
  }
  const nextPage = typeof body.next_page === "string" && body.next_page !== "" ? body.next_page : undefined;
  return { records: body.data.map((entry) => readRecord(entry)), hasMore: body.has_more === true, nextPage };
}

function columnValue(column: StripeColumn, fields: Record<string, unknown>): unknown {
  const raw = fields[column.name];
  if (raw === undefined || raw === null) return null;
  if (column.epoch === true && typeof raw === "number") return new Date(raw * 1000).toISOString();
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  return null;
}

export class StripeProvider extends SQLBaseProvider {
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
    stripeToken(this.config);
    stripeApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote:
          "This object has more fields than a select list can usefully show. Type a field name and completion fills it in.",
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
      entityName: "Object",
      entityNamePlural: "Objects",
      searchPlaceholder: "Search objects or fields...",
    };
  }

  public async connect(): Promise<void> {
    if (this.ready) return;
    try {
      await this.request("/v1/customers", { limit: "1" });
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
    const statement = translateStripeSql(sql);
    const result = await this.run(statement, sql);
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
    return { table: { count: STRIPE_OBJECTS.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return STRIPE_OBJECTS.map((object) => ({ path: [...container, object.name], name: object.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const object = stripeObject(path[path.length - 1] ?? "");
    const columns: ColumnSchema[] = stripeColumns(object).map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.name !== "id",
      isPrimary: column.name === "id",
    }));
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Stripe bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(bounded.map((object) => this.describeObject(object.path, kind)));
    if (limit !== undefined && objects.length > limit) {
      return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
    }
    return { details };
  }

  public getHealth(): Promise<HealthInfo> {
    return Promise.resolve({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  }

  public runMaintenance(): Promise<MaintenanceResult> {
    return Promise.reject(new QueryError("Stripe has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Stripe API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: STRIPE_OBJECTS.length,
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
    if (spec === undefined) throw new QueryError(`Stripe declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: StripeStatement,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") return this.countRows(statement);
    return this.select(statement, sql);
  }

  private async countRows(statement: {
    readonly table: string;
    readonly filters: readonly StripeFilter[];
  }): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const object = stripeObject(statement.table);
    const id = this.loneId(statement.filters);
    if (id !== undefined) {
      await this.request(`/v1/${object.name}/${encodeURIComponent(id)}`);
      return { rows: [{ row_count: 1 }], fields: ["row_count"], rowCount: 1 };
    }
    if (!object.search) {
      throw new QueryError(
        `Stripe does not report how many ${object.name} match. Read them with SELECT ... LIMIT.`,
        PROVIDER,
      );
    }
    const body = await this.request(`/v1/${object.name}/search`, {
      query: stripeSearchQuery(object, statement.filters),
      limit: "1",
      "expand[]": "total_count",
    });
    if (!isRecord(body) || typeof body.total_count !== "number") {
      throw new QueryError("Stripe did not report a count.", PROVIDER);
    }
    const warnings: QueryWarning[] | undefined =
      body.total_count >= COUNT_CAP ? [{ message: COUNT_CAP_WARNING, severity: "WARNING" }] : undefined;
    return {
      rows: [{ row_count: body.total_count }],
      fields: ["row_count"],
      rowCount: 1,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  private async select(
    statement: StripeSelect,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const object = stripeObject(statement.table);
    this.knownColumns(object, statement.columns);
    if (statement.offset >= MAX_ROWS) {
      throw new QueryError("Stripe reads at most 1000 rows in one statement. Use a smaller OFFSET.", PROVIDER, sql);
    }
    const room = MAX_ROWS - statement.offset;
    const want = statement.limit === null ? room : Math.min(statement.limit, room);
    if (want === 0) return rowsOf([], statement.columns, object);
    const id = this.loneId(statement.filters);
    if (id !== undefined) {
      if (statement.offset > 0) return rowsOf([], statement.columns, object);
      const body = await this.request(`/v1/${object.name}/${encodeURIComponent(id)}`);
      return rowsOf([readRecord(body)], statement.columns, object);
    }
    const list = stripeListQuery(object, statement.filters);
    const maxRecords = statement.offset + want;
    const collected: StripeRecord[] = [];
    let cursor: string | undefined;
    let more = false;
    while (collected.length < maxRecords) {
      const pageSize = Math.min(PAGE_SIZE, maxRecords - collected.length);
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is the offset this page returns.
      const page = await this.page(object, statement.filters, list, pageSize, cursor);
      collected.push(...page.records);
      if (!page.hasMore || page.records.length === 0) {
        more = false;
        break;
      }
      cursor = list === null ? page.nextPage : page.records[page.records.length - 1]?.id;
      if (cursor === undefined) {
        more = false;
        break;
      }
      more = collected.length >= maxRecords;
    }
    const slice = collected.slice(statement.offset, statement.offset + want);
    const capped = more && statement.offset + want >= MAX_ROWS;
    const warnings: QueryWarning[] | undefined = capped ? [{ message: CAP_WARNING, severity: "WARNING" }] : undefined;
    return { ...rowsOf(slice, statement.columns, object), ...(warnings === undefined ? {} : { warnings }) };
  }

  private async page(
    object: StripeObject,
    filters: readonly StripeFilter[],
    list: Record<string, string> | null,
    pageSize: number,
    cursor: string | undefined,
  ): Promise<StripePage> {
    if (list === null) {
      const body = await this.request(`/v1/${object.name}/search`, {
        query: stripeSearchQuery(object, filters),
        limit: String(pageSize),
        ...(cursor === undefined ? {} : { page: cursor }),
      });
      return readPage(body);
    }
    const body = await this.request(`/v1/${object.name}`, {
      ...list,
      limit: String(pageSize),
      ...(cursor === undefined ? {} : { starting_after: cursor }),
    });
    return readPage(body);
  }

  private loneId(filters: readonly StripeFilter[]): string | undefined {
    const id = filters.find((filter) => filter.column.toLowerCase() === "id");
    if (id === undefined) return undefined;
    if (filters.length !== 1 || id.op !== "EQ" || typeof id.value !== "string" || id.value === "") {
      throw new QueryError("Look up one Stripe object with WHERE id = '...' and no other condition.", PROVIDER);
    }
    return id.value;
  }

  private knownColumns(object: StripeObject, columns: readonly string[] | null): void {
    if (columns === null) return;
    const known = new Set(stripeColumns(object).map((column) => column.name.toLowerCase()));
    for (const column of columns) {
      if (!known.has(column.toLowerCase())) {
        throw new QueryError(`Stripe object ${object.name} has no field ${column}.`, PROVIDER);
      }
    }
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = stripeApiHost(this.config);
    const token = stripeToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}`, "Stripe-Version": STRIPE_VERSION },
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
    const message = error instanceof Error ? error.message : "Stripe could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async request(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const token = stripeToken(this.config);
    const host = stripeApiHost(this.config);
    const transport = this.ensureTransport();
    const params = new URLSearchParams(query);
    const url = endpointUrl(httpOrigin("https", host, 443), path, params.size === 0 ? undefined : params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(DEADLINE_MS),
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
      const message = redactSecret(stripeMessage(body) ?? `Stripe answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function rowsOf(
  records: readonly StripeRecord[],
  columns: readonly string[] | null,
  object: StripeObject,
): Pick<QueryResult, "rows" | "fields" | "rowCount"> {
  const declared = stripeColumns(object);
  const byName = new Map(declared.map((column) => [column.name.toLowerCase(), column]));
  const names =
    columns === null
      ? declared.filter((column) => column.name !== "id")
      : columns.flatMap((name) => {
          const column = byName.get(name.toLowerCase());
          return column === undefined || column.name === "id" ? [] : [column];
        });
  const fieldNames = uniqueFieldNames(["id", ...names.map((column) => column.name)]);
  const rows = records.map((record) => {
    const row: Record<string, unknown> = {};
    assignOwnField(row, "id", record.id);
    for (const column of names) assignOwnField(row, column.name, columnValue(column, record.fields));
    return row;
  });
  return { rows, fields: fieldNames, rowCount: rows.length };
}
