/**
 * Shopify provider.
 *
 * A statement is ShopifyQL (`FROM sales SHOW total_sales`). Studio sends that
 * text through the Admin API `shopifyqlQuery` field and reads the table back.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The Admin API access token is sent only to a host under myshopify.com, over
 * TLS, on the shared HTTP transport. That path does not use global fetch, so a
 * proxy variable cannot carry the token. A redirect is not followed.
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
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, assignOwnField, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { SHOPIFYQL_SCHEMAS, shopifySchema, translateShopifyql } from "./translate";

const PROVIDER = "shopify" as const;
const API_VERSION = "2025-10";
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "shop";
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const HOST_REQUIRED = "A Shopify shop host is required.";
const SHOP_HOST_REFUSAL = "The API host must be the shop's myshopify.com host. The access token is sent only there.";
const TOKEN_REQUIRED = "A Shopify Admin API access token is required.";
const TOKEN_LINE = "A Shopify Admin API access token must be a single line of printable text.";
const REDIRECT_REFUSED = "Shopify answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Shopify's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Shopify does not bind parameters.";
const NOT_CONNECTED = "Not connected to Shopify.";
const BAD_TABLE = "Shopify did not return a table.";
const BAD_SHOP = "Shopify did not name this shop.";
const SHOPIFYQL_DOCUMENT = `query Shopifyql($query: String!) {
  shopifyqlQuery(query: $query) {
    tableData {
      columns { name dataType displayName }
      rows
    }
    parseErrors
  }
}`;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Shop", labelPlural: "Shops" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Shopify", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A Shopify",
  attachedSegment: "required",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shop host the access token is sent to. Only a `*.myshopify.com` host is accepted. */
export function shopifyApiHost(config: DatabaseConnection): string {
  const raw = config.host?.trim() ?? "";
  if (raw === "") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  // The URL parser hides a default https port, so an explicit port is refused from the text.
  if (raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").includes(":")) {
    throw new DatabaseConfigError(SHOP_HOST_REFUSAL, PROVIDER);
  }
  const host = pinnedApiHost(raw, "myshopify.com", "unused.myshopify.com", PROVIDER);
  if (!SHOP_HOST.test(host)) throw new DatabaseConfigError(SHOP_HOST_REFUSAL, PROVIDER);
  return host;
}

/** The Admin API access token, refused when it could split an HTTP header or is too long to send. */
export function shopifyAccessToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  if (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return token;
}

const RESERVED_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

function present(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  return value;
}

function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return present(row[column]);
  const found = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? null : present(row[found]);
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, cell(row, field));
  return projected;
}

function unionNames(rows: readonly Record<string, unknown>[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key) || RESERVED_FIELDS.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function columnNames(columns: unknown): string[] {
  if (!Array.isArray(columns)) throw new QueryError(BAD_TABLE, PROVIDER);
  return columns.flatMap((column) => {
    if (!isRecord(column) || typeof column.name !== "string" || column.name === "") return [];
    if (RESERVED_FIELDS.has(column.name)) return [];
    return [column.name];
  });
}

function readShopifyql(
  body: unknown,
  token: string,
  sql: string,
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.shopifyqlQuery)) {
    throw new QueryError(BAD_TABLE, PROVIDER, sql);
  }
  const result = body.data.shopifyqlQuery;
  if (result.parseErrors !== undefined && !Array.isArray(result.parseErrors)) {
    throw new QueryError(BAD_TABLE, PROVIDER, sql);
  }
  if (Array.isArray(result.parseErrors) && result.parseErrors.length > 0) {
    const message = result.parseErrors
      .map((error) => (typeof error === "string" && error !== "" ? error : "Shopify refused the query."))
      .join(" ");
    throw new QueryError(redactSecret(message, token), PROVIDER, sql);
  }
  const table = result.tableData;
  if (!isRecord(table) || !Array.isArray(table.rows)) throw new QueryError(BAD_TABLE, PROVIDER, sql);
  const declared = uniqueFieldNames(columnNames(table.columns));
  const sources = table.rows.flatMap((row) => (isRecord(row) ? [row] : []));
  const fields = declared.length > 0 ? declared : uniqueFieldNames(unionNames(sources));
  const rows = table.rows.map((row) => project(isRecord(row) ? row : {}, fields));
  return { rows, fields, rowCount: rows.length, warnings: [] };
}

function graphqlMessage(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.errors) || body.errors.length === 0) return null;
  return body.errors
    .map((error) =>
      isRecord(error) && typeof error.message === "string" ? error.message : "Shopify refused the query.",
    )
    .join(" ");
}

export class ShopifyProvider extends SQLBaseProvider {
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
    shopifyAccessToken(this.config);
    shopifyApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote: "Name the metrics in SHOW. A ShopifyQL schema has more fields than a list can usefully show.",
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
      const body = await this.graphql("query { shop { name myshopifyDomain } }", {});
      const shop = isRecord(body) && isRecord(body.data) ? body.data.shop : undefined;
      if (!isRecord(shop) || typeof shop.name !== "string" || shop.name === "") {
        throw new QueryError(BAD_SHOP, PROVIDER);
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
    const started = Date.now();
    const statement = translateShopifyql(sql);
    const token = shopifyAccessToken(this.config);
    const body = await this.graphql(SHOPIFYQL_DOCUMENT, { query: statement.text });
    const result = readShopifyql(body, token, sql);
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
    return { table: { count: SHOPIFYQL_SCHEMAS.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return SHOPIFYQL_SCHEMAS.map((schema) => ({ path: [...container, schema.name], name: schema.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = shopifySchema(name);
    if (found === null) throw new QueryError("Shopify has no table with that name.", PROVIDER);
    return {
      path,
      columns: [],
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Shopify bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Shopify has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: `ShopifyQL ${API_VERSION}`,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: SHOPIFYQL_SCHEMAS.length,
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
    if (spec === undefined) throw new QueryError(`Shopify declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = shopifyApiHost(this.config);
    const token = shopifyAccessToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { "X-Shopify-Access-Token": token, Accept: "application/json" },
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
    const message = error instanceof Error ? error.message : "Shopify could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const token = shopifyAccessToken(this.config);
    const host = shopifyApiHost(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(httpOrigin("https", host, 443), `/admin/api/${API_VERSION}/graphql.json`);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host);
    }
    if (response.status === 401) throw new AuthenticationError("Shopify refused the access token.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("Shopify refused this access token.", PROVIDER);
    if (response.status === 429) {
      throw new QueryError("Shopify is limiting requests. Wait and run the statement again.", PROVIDER);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    const text = response.text;
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new QueryError("Shopify's answer was not JSON.", PROVIDER);
      }
    }
    const message = graphqlMessage(body);
    if (message !== null) throw new QueryError(redactSecret(message, token), PROVIDER);
    if (response.status >= 400) throw new QueryError("Shopify refused the query.", PROVIDER);
    return body;
  }
}
