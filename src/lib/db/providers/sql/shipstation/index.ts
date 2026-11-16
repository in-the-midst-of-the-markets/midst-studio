/**
 * ShipStation provider.
 *
 * ShipStation is a shipping API, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): SELECT and COUNT(*) against one listed resource on
 * the V1 API. Each statement is one GET. Nothing is copied into another
 * database, and a write is refused before a request.
 *
 * The API key and secret are sent only to ssapi.shipstation.com, as HTTP Basic
 * authentication, over TLS, on the shared HTTP transport. That path does not
 * use global fetch, so a proxy variable cannot carry the secret. A redirect is
 * not followed. The V2 host is refused.
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
import {
  SHIPSTATION_RESOURCES,
  type ShipStationFilter,
  type ShipStationResource,
  type ShipStationStatement,
  translateShipStationSql,
} from "./translate";

const PROVIDER = "shipstation" as const;
const ORDERS = "/orders";
const SHIPMENTS = "/shipments";
const PRODUCTS = "/products";
const STORES = "/stores";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "shipping";
const HOST_REQUIRED = "The API host must be ssapi.shipstation.com. The API secret is sent only there.";
const KEY_REQUIRED = "The API key is required.";
const SECRET_REQUIRED = "The API secret is required.";
const CREDENTIAL_LINE = "ShipStation credentials must be a single line of printable text.";
const KEY_COLON = "The API key must not contain a colon.";
const REDIRECT_REFUSED = "ShipStation answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "ShipStation's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. ShipStation does not bind parameters.";
const NOT_CONNECTED = "Not connected to ShipStation.";
const PAGE_WARNING = "ShipStation returned this page only. Raise OFFSET for the next page.";
const SLOW = "ShipStation asked the connection to slow down.";
const NOT_JSON = "ShipStation returned an answer that was not JSON.";
const NOT_LIST = "ShipStation returned an answer that was not a list.";
const NOT_OBJECT = "ShipStation returned an answer that was not a JSON object.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A ShipStation account",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A ShipStation account",
  attachedSegment: "required",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credential(value: string | undefined, empty: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(empty, PROVIDER);
  if (text.length > 200 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/** The V1 API host. Empty uses production. The secret is sent only there. */
export function shipstationHost(config: Pick<DatabaseConnection, "host">): string {
  const host = pinnedApiHost(config.host, "shipstation.com", "ssapi.shipstation.com", PROVIDER);
  if (host !== "ssapi.shipstation.com") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return host;
}

/** The API key, from the user field. */
export function shipstationApiKey(config: Pick<DatabaseConnection, "user">): string {
  const key = credential(config.user, KEY_REQUIRED);
  if (key.includes(":")) throw new DatabaseConfigError(KEY_COLON, PROVIDER);
  return key;
}

/** The API secret, from the password field. */
export function shipstationApiSecret(config: Pick<DatabaseConnection, "password">): string {
  return credential(config.password, SECRET_REQUIRED);
}

/** `Authorization` for the V1 API. The value is HTTP Basic. */
export function shipstationAuthorization(config: Pick<DatabaseConnection, "user" | "password">): string {
  const key = shipstationApiKey(config);
  const secret = shipstationApiSecret(config);
  return `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
}

/** ShipStation connection. The key and secret read orders, shipments, products and stores. */
export class ShipStationProvider extends SQLBaseProvider {
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
    shipstationHost(this.config);
    shipstationAuthorization(this.config);
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
      await this.get(STORES, {}, "connect");
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
    const statement = translateShipStationSql(sql);
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
    return { table: { count: SHIPSTATION_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return SHIPSTATION_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = SHIPSTATION_RESOURCES.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("ShipStation has no table with that name.", PROVIDER);
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
        `A ShipStation bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("ShipStation has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "ShipStation API V1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: SHIPSTATION_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`ShipStation declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: ShipStationStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") return this.count(statement);
    if (statement.resource.paging.mode === "once") return this.once(statement);
    return this.page(statement);
  }

  private async page(
    statement: Extract<ShipStationStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const body = await this.get(
      pathOf(statement.resource),
      {
        ...queryOf(statement.filters),
        page: String(statement.offset / statement.limit + 1),
        pageSize: String(statement.limit),
      },
      "query",
    );
    const rows = listedRows(body, statement.resource).map((row) => project(mapRow(statement.resource, row), fields));
    const more =
      isRecord(body) && typeof body.pages === "number" && statement.offset / statement.limit + 1 < body.pages;
    return withWarnings(
      { rows, fields, rowCount: rows.length },
      pageWarnings(statement, rows.length, more || rows.length === statement.limit),
    );
  }

  private async once(
    statement: Extract<ShipStationStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const listed = listedRows(await this.get(STORES, {}, "query"), statement.resource).map(storeRow);
    const slice = listed.slice(statement.offset, statement.offset + statement.limit);
    const rows = slice.map((row) => project(row, fields));
    const more = listed.length > statement.offset + statement.limit;
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length, more));
  }

  private async count(
    statement: Extract<ShipStationStatement, { kind: "count" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount">> {
    if (statement.resource.paging.mode === "once") {
      const listed = listedRows(await this.get(STORES, {}, "query"), statement.resource);
      return { rows: [{ [statement.alias]: listed.length }], fields: [statement.alias], rowCount: 1 };
    }
    const body = await this.get(
      pathOf(statement.resource),
      { ...queryOf(statement.filters), page: "1", pageSize: "1" },
      "query",
    );
    const total = isRecord(body) && typeof body.total === "number" && Number.isFinite(body.total) ? body.total : 0;
    return { rows: [{ [statement.alias]: total }], fields: [statement.alias], rowCount: 1 };
  }

  private async get(path: string, query: Record<string, string>, during: "connect" | "query"): Promise<unknown> {
    const header = shipstationAuthorization(this.config);
    const host = shipstationHost(this.config);
    const secret = shipstationApiSecret(this.config);
    const url = endpointUrl(httpOrigin("https", host, 443), path, new URLSearchParams(query));
    let response: { status: number; text: string };
    try {
      response = await this.transport(header).request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, secret, host, during);
    }
    return this.read(response, secret, during);
  }

  private read(response: { status: number; text: string }, secret: string, during: "connect" | "query"): unknown {
    const asQuery = during === "query";
    if (response.status >= 300 && response.status < 400) {
      throw asQuery ? new QueryError(REDIRECT_REFUSED, PROVIDER) : new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    }
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 401) throw new AuthenticationError("ShipStation rejected the API key.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("ShipStation refused this request.", PROVIDER);
    if (response.status === 429) throw asQuery ? new QueryError(SLOW, PROVIDER) : new ConnectionError(SLOW, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(response.text, secret);
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

  private transport(header: string): NodeTransport {
    if (this.api !== null) return this.api;
    const host = shipstationHost(this.config);
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json", authorization: header },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.api;
  }

  private closeTransport(): void {
    this.api?.close();
    this.api = null;
  }

  private wireFailure(error: unknown, secret: string, host: string, during: "connect" | "query"): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") {
        return during === "query"
          ? new QueryError(REDIRECT_REFUSED, PROVIDER)
          : new ConnectionError(REDIRECT_REFUSED, PROVIDER, host);
      }
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, secret), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "ShipStation could not be reached.";
    return new ConnectionError(redactSecret(message, secret), PROVIDER, host);
  }
}

function pathOf(resource: ShipStationResource): string {
  if (resource.name === "Order") return ORDERS;
  if (resource.name === "Shipment") return SHIPMENTS;
  return PRODUCTS;
}

function queryOf(filters: readonly ShipStationFilter[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const filter of filters) query[filter.param] = filter.value;
  return query;
}

function fieldsOf(statement: Extract<ShipStationStatement, { kind: "list" }>): string[] {
  return uniqueFieldNames(
    statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
  );
}

function listedRows(body: unknown, resource: ShipStationResource): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) throw new QueryError(NOT_OBJECT, PROVIDER);
  const items = body[resource.listKey];
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new QueryError(NOT_LIST, PROVIDER);
  return items.filter(isRecord);
}

function mapRow(resource: ShipStationResource, row: Record<string, unknown>): Record<string, unknown> {
  if (resource.name === "Shipment") return shipmentRow(row);
  if (resource.name === "Product") return productRow(row);
  return orderRow(row);
}

function withWarnings(
  result: Pick<QueryResult, "rows" | "fields" | "rowCount">,
  warnings: QueryWarning[],
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  return warnings.length === 0 ? result : { ...result, warnings };
}

function pageWarnings(
  statement: Extract<ShipStationStatement, { kind: "list" }>,
  rows: number,
  more: boolean,
): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  if (statement.capped) {
    warnings.push({
      message: `ShipStation returns at most ${statement.limit} rows in one page. This query asked for more, so the page is ${statement.limit}.`,
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
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function orderRow(order: Record<string, unknown>): Record<string, unknown> {
  const shipTo = isRecord(order.shipTo) ? order.shipTo : null;
  return {
    OrderId: asText(order.orderId),
    OrderNumber: asText(order.orderNumber),
    OrderDate: asText(order.orderDate),
    CreateDate: asText(order.createDate),
    OrderStatus: asText(order.orderStatus),
    CustomerEmail: asText(order.customerEmail),
    OrderTotal: asNum(order.orderTotal),
    AmountPaid: asNum(order.amountPaid),
    Tax: asNum(order.taxAmount),
    Shipping: asNum(order.shippingAmount),
    StoreId: asText(order.storeId),
    CarrierCode: asText(order.carrierCode),
    ShipToName: asText(shipTo?.name),
    ShipToCity: asText(shipTo?.city),
    ShipToCountry: asText(shipTo?.country),
  };
}

function shipmentRow(row: Record<string, unknown>): Record<string, unknown> {
  const shipTo = isRecord(row.shipTo) ? row.shipTo : null;
  return {
    ShipmentId: asText(row.shipmentId),
    OrderId: asText(row.orderId),
    OrderNumber: asText(row.orderNumber),
    CreateDate: asText(row.createDate),
    ShipDate: asText(row.shipDate),
    TrackingNumber: asText(row.trackingNumber),
    CarrierCode: asText(row.carrierCode),
    ServiceCode: asText(row.serviceCode),
    ShipmentCost: asNum(row.shipmentCost),
    ShipToName: asText(shipTo?.name),
    ShipToCity: asText(shipTo?.city),
    ShipToCountry: asText(shipTo?.country),
    Voided: asText(row.voided),
  };
}

function productRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ProductId: asText(row.productId),
    Sku: asText(row.sku),
    Name: asText(row.name),
    Price: asNum(row.price),
    Active: asText(row.active),
    CreateDate: asText(row.createDate),
  };
}

function storeRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    StoreId: asText(row.storeId),
    StoreName: asText(row.storeName),
    MarketplaceName: asText(row.marketplaceName),
    Active: asText(row.active),
    CompanyName: asText(row.companyName),
  };
}
