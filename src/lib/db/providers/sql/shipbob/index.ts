/**
 * ShipBob provider.
 *
 * ShipBob is a fulfillment API, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): SELECT and COUNT(*) against one listed resource.
 * Each statement is one GET. Nothing is copied into another database, and a
 * write is refused before a request.
 *
 * The personal access token is sent only to api.shipbob.com or
 * sandbox-api.shipbob.com, as a Bearer credential, over TLS, on the shared HTTP
 * transport. That path does not use global fetch, so a proxy variable cannot
 * carry the token. A redirect is not followed.
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
import { API_ANSWER_LIMIT, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { SHIPBOB_RESOURCES, type ShipBobFilter, type ShipBobStatement, translateShipBobSql } from "./translate";

const PROVIDER = "shipbob" as const;
const VERSION = "2026-07";
const ORDER = `/${VERSION}/order`;
const PRODUCT = `/${VERSION}/product`;
const INVENTORY = `/${VERSION}/inventory-level`;
const CHANNEL = `/${VERSION}/channel`;
const MAX_SOCKETS = 4;
const HEADER_LIMIT = 1024;
const CONTAINER_NAME = "fulfillment";
const API_HOSTS = new Set(["api.shipbob.com", "sandbox-api.shipbob.com"]);
const HOST_REQUIRED =
  "The API host must be api.shipbob.com or sandbox-api.shipbob.com. The access token is sent only there.";
const TOKEN_REQUIRED = "The personal access token is required.";
const CREDENTIAL_LINE = "ShipBob credentials must be a single line of printable text.";
const TOKEN_LONG = "The personal access token is too long to send.";
const REDIRECT_REFUSED = "ShipBob answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "ShipBob's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. ShipBob does not bind parameters.";
const NOT_CONNECTED = "Not connected to ShipBob.";
const PAGE_WARNING = "ShipBob returned this page only. Raise OFFSET for the next page.";
const SLOW = "ShipBob asked the connection to slow down.";
const NOT_JSON = "ShipBob returned an answer that was not JSON.";
const NOT_LIST = "ShipBob returned an answer that was not a list.";
const NOT_OBJECT = "ShipBob returned an answer that was not a JSON object.";
const LINK_REFUSED = "ShipBob returned a page link outside this list.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A ShipBob account", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A ShipBob account", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The API host. Empty uses production. The token is sent only there. */
export function shipbobHost(config: Pick<DatabaseConnection, "host">): string {
  const host = pinnedApiHost(config.host, "shipbob.com", "api.shipbob.com", PROVIDER);
  if (!API_HOSTS.has(host)) throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return host;
}

/** The personal access token, from the password field. */
export function shipbobToken(config: Pick<DatabaseConnection, "password">): string {
  const text = config.password?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  if (text.length > HEADER_LIMIT || !/^[\x21-\x7e]+$/.test(text))
    throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  if (`Bearer ${text}`.length > HEADER_LIMIT) throw new DatabaseConfigError(TOKEN_LONG, PROVIDER);
  return text;
}

/**
 * The sales channel id, from the database field. A whole number is sent as
 * `shipbob_channel_id`. Anything else, including an empty field, is not sent.
 */
export function shipbobChannelId(config: Pick<DatabaseConnection, "database">): string | null {
  const text = config.database?.trim() ?? "";
  if (!/^[1-9][0-9]{0,17}$/.test(text)) return null;
  return text;
}

/** ShipBob connection. The token reads orders, products, inventory and channels. */
export class ShipBobProvider extends SQLBaseProvider {
  private ready = false;
  private api: NodeTransport | null = null;

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
    shipbobHost(this.config);
    shipbobToken(this.config);
    shipbobChannelId(this.config);
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
      await this.get(CHANNEL, {}, "connect");
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
    const statement = translateShipBobSql(sql);
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
    return { table: { count: SHIPBOB_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return SHIPBOB_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = SHIPBOB_RESOURCES.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("ShipBob has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: true,
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A ShipBob bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("ShipBob has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "ShipBob API 2026-07",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: SHIPBOB_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`ShipBob declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: ShipBobStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") {
      const listed = listedRows(await this.get(CHANNEL, {}, "query"), "items");
      return { rows: [{ [statement.alias]: listed.length }], fields: [statement.alias], rowCount: 1 };
    }
    if (statement.resource.name === "Order") return this.orders(statement);
    if (statement.resource.name === "Product") return this.cursor(statement, PRODUCT, productRow);
    if (statement.resource.name === "Inventory") return this.cursor(statement, INVENTORY, inventoryRow);
    return this.once(statement);
  }

  private async orders(
    statement: Extract<ShipBobStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const body = await this.get(
      ORDER,
      {
        ...queryOf(statement.filters),
        Page: String(statement.offset / statement.limit + 1),
        Limit: String(statement.limit),
      },
      "query",
    );
    const rows = listedRows(body, null)
      .map(orderRow)
      .map((row) => project(row, fields));
    return withWarnings(
      { rows, fields, rowCount: rows.length },
      pageWarnings(statement, rows.length, rows.length === statement.limit),
    );
  }

  private async cursor(
    statement: Extract<ShipBobStatement, { kind: "list" }>,
    path: string,
    map: (row: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const body = await this.follow(
      path,
      { ...queryOf(statement.filters), PageSize: String(statement.limit) },
      statement.offset / statement.limit,
    );
    if (body === null) return { rows: [], fields, rowCount: 0 };
    const rows = listedRows(body, "items")
      .map(map)
      .map((row) => project(row, fields));
    const more = nextQuery(body, path, shipbobHost(this.config)) !== null;
    return withWarnings(
      { rows, fields, rowCount: rows.length },
      pageWarnings(statement, rows.length, more || rows.length === statement.limit),
    );
  }

  private async once(
    statement: Extract<ShipBobStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const listed = listedRows(await this.get(CHANNEL, {}, "query"), "items").map(channelRow);
    const slice = listed.slice(statement.offset, statement.offset + statement.limit);
    const rows = slice.map((row) => project(row, fields));
    const more = listed.length > statement.offset + statement.limit;
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length, more));
  }

  /** Follow `next` until the requested page. A missing link is an empty page. */
  private async follow(path: string, query: Record<string, string>, steps: number): Promise<unknown> {
    let body = await this.get(path, query, "query");
    const host = shipbobHost(this.config);
    for (let seen = 0; seen < steps; seen += 1) {
      const next = nextQuery(body, path, host);
      if (next === null) return null;
      // oxlint-disable-next-line no-await-in-loop -- the next page's address is inside the page just read.
      body = await this.get(path, next, "query");
    }
    return body;
  }

  private async get(path: string, query: Record<string, string>, during: "connect" | "query"): Promise<unknown> {
    const token = shipbobToken(this.config);
    const host = shipbobHost(this.config);
    const channel = shipbobChannelId(this.config);
    const headers: Record<string, string> = {};
    if (channel !== null) headers.shipbob_channel_id = channel;
    const url = endpointUrl(httpOrigin("https", host, 443), path, new URLSearchParams(query));
    let response: { status: number; text: string };
    try {
      response = await this.transport(token).request({
        method: "GET",
        url,
        headers,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host, during);
    }
    return this.read(response, token, during);
  }

  private read(response: { status: number; text: string }, token: string, during: "connect" | "query"): unknown {
    const asQuery = during === "query";
    if (response.status >= 300 && response.status < 400) {
      throw asQuery ? new QueryError(REDIRECT_REFUSED, PROVIDER) : new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    }
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 401) throw new AuthenticationError("ShipBob rejected the access token.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("ShipBob refused this request.", PROVIDER);
    if (response.status === 429) throw asQuery ? new QueryError(SLOW, PROVIDER) : new ConnectionError(SLOW, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(response.text, token);
      throw asQuery ? new QueryError(message, PROVIDER) : new ConnectionError(message, PROVIDER);
    }
    if (response.text === "")
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    }
  }

  private transport(token: string): NodeTransport {
    if (this.api !== null) return this.api;
    const host = shipbobHost(this.config);
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json", authorization: `Bearer ${token}` },
      requestHeaderNames: ["shipbob_channel_id"],
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.api;
  }

  private closeTransport(): void {
    this.api?.close();
    this.api = null;
  }

  private wireFailure(error: unknown, token: string, host: string, during: "connect" | "query"): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") {
        return during === "query"
          ? new QueryError(REDIRECT_REFUSED, PROVIDER)
          : new ConnectionError(REDIRECT_REFUSED, PROVIDER, host);
      }
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, token), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "ShipBob could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }
}

function queryOf(filters: readonly ShipBobFilter[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const filter of filters) query[filter.param] = filter.value;
  return query;
}

function fieldsOf(statement: Extract<ShipBobStatement, { kind: "list" }>): string[] {
  return uniqueFieldNames(
    statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
  );
}

function listedRows(body: unknown, key: "items" | null): Record<string, unknown>[] {
  if (key === null) {
    if (!Array.isArray(body)) throw new QueryError(NOT_LIST, PROVIDER);
    return body.filter(isRecord);
  }
  if (!isRecord(body)) throw new QueryError(NOT_OBJECT, PROVIDER);
  if (body.items === undefined || body.items === null) return [];
  if (!Array.isArray(body.items)) throw new QueryError(NOT_LIST, PROVIDER);
  return body.items.filter(isRecord);
}

function nextQuery(body: unknown, path: string, host: string): Record<string, string> | null {
  if (!isRecord(body)) return null;
  const next = body.next;
  if (next === null || next === undefined || next === "") return null;
  if (typeof next !== "string") throw new QueryError(LINK_REFUSED, PROVIDER);
  let url: URL;
  try {
    url = new URL(next, `https://${host}`);
  } catch {
    throw new QueryError(LINK_REFUSED, PROVIDER);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.pathname !== path
  ) {
    throw new QueryError(LINK_REFUSED, PROVIDER);
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!/^[A-Za-z0-9_]+$/.test(key) || value.length > 500 || !/^[\x20-\x7e]*$/.test(value)) {
      throw new QueryError(LINK_REFUSED, PROVIDER);
    }
    query[key] = value;
  }
  return query;
}

function withWarnings(
  result: Pick<QueryResult, "rows" | "fields" | "rowCount">,
  warnings: QueryWarning[],
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  return warnings.length === 0 ? result : { ...result, warnings };
}

function pageWarnings(
  statement: Extract<ShipBobStatement, { kind: "list" }>,
  rows: number,
  more: boolean,
): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  if (statement.capped) {
    warnings.push({
      message: `ShipBob returns at most ${statement.limit} rows in one page. This query asked for more, so the page is ${statement.limit}.`,
      severity: "WARNING",
    });
  }
  if (rows === statement.limit || more) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
  return warnings;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) projected[field] = row[field] ?? null;
  return projected;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function orderRow(order: Record<string, unknown>): Record<string, unknown> {
  const recipient = isRecord(order.recipient) ? order.recipient : null;
  const address = recipient !== null && isRecord(recipient.address) ? recipient.address : null;
  const channel = isRecord(order.channel) ? order.channel : null;
  return {
    Id: asText(order.id),
    OrderNumber: asText(order.order_number),
    ReferenceId: asText(order.reference_id),
    Status: asText(order.status),
    Type: asText(order.type),
    CreatedDate: asText(order.created_date),
    PurchaseDate: asText(order.purchase_date),
    ShippingMethod: asText(order.shipping_method),
    RecipientName: asText(recipient?.name),
    RecipientCity: asText(address?.city),
    RecipientCountry: asText(address?.country),
    ChannelId: asText(channel?.id),
  };
}

function productRow(product: Record<string, unknown>): Record<string, unknown> {
  const variants = Array.isArray(product.variants) ? product.variants.filter(isRecord) : [];
  const variant = variants[0] ?? null;
  return {
    Id: asText(product.id),
    Name: asText(product.name),
    Type: asText(product.type),
    CreatedOn: asText(product.created_on),
    Sku: asText(variant?.sku),
    VariantId: asText(variant?.id),
    VariantStatus: asText(variant?.status),
  };
}

function inventoryRow(item: Record<string, unknown>): Record<string, unknown> {
  return {
    InventoryId: asText(item.inventory_id),
    Name: asText(item.name),
    Sku: asText(item.sku),
    Fulfillable: asNum(item.total_fulfillable_quantity),
    OnHand: asNum(item.total_on_hand_quantity),
    Committed: asNum(item.total_committed_quantity),
    Sellable: asNum(item.total_sellable_quantity),
    Awaiting: asNum(item.total_awaiting_quantity),
    Backordered: asNum(item.total_backordered_quantity),
  };
}

function channelRow(channel: Record<string, unknown>): Record<string, unknown> {
  return {
    Id: asText(channel.id),
    Name: asText(channel.name),
    ApplicationName: asText(channel.application_name),
  };
}
