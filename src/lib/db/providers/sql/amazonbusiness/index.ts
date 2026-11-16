/**
 * Amazon Business provider.
 *
 * Amazon Business is a buying API, not a SQL server and not Selling Partner.
 * The editor runs a small SQL subset (`translate.ts`): SELECT and COUNT(*) against
 * one listed resource. Each statement is one GET. Nothing is copied into another
 * database, and a write is refused before a request.
 *
 * The refresh token and client secret are exchanged at api.amazon.com. The access
 * token is sent only to the regional business API host, over TLS, on the shared
 * HTTP transport. That path does not use global fetch, so a proxy variable cannot
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
import {
  AMAZON_BUSINESS_RESOURCES,
  type AmazonFilter,
  type AmazonStatement,
  translateAmazonBusinessSql,
} from "./translate";

const PROVIDER = "amazonbusiness" as const;
const TOKEN_HOST = "api.amazon.com";
const TOKEN_PATH = "/auth/O2/token";
const PRODUCTS = "/products/2020-08-26/products";
const ORDERS = "/reports/2021-01-08/orders";
const TRANSACTIONS = "/reconciliation/2021-01-08/transactions";
const MAX_SOCKETS = 4;
const HEADER_LIMIT = 1024;
const EARLY_REFRESH_MS = 60_000;
const CONTAINER_NAME = "buying";
const PRODUCT_REGIONS = new Set(["US", "CA", "MX", "UK", "DE", "FR", "IT", "ES", "IN", "JP", "AU"]);
const API_HOSTS = new Set(["na.business-api.amazon.com", "eu.business-api.amazon.com", "jp.business-api.amazon.com"]);
const HOST_REQUIRED =
  "The API host must be na.business-api.amazon.com, eu.business-api.amazon.com, or jp.business-api.amazon.com. The access token is sent only there.";
const CLIENT_REQUIRED = "The LWA client id is required.";
const SECRET_REQUIRED = "The LWA client secret is required.";
const REFRESH_REQUIRED = "The LWA refresh token is required.";
const EMAIL_REQUIRED = "Product search needs the buying user's email.";
const CREDENTIAL_LINE = "Amazon Business credentials must be a single line of printable text.";
const REDIRECT_REFUSED = "Amazon Business answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Amazon Business's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Amazon Business does not bind parameters.";
const NOT_CONNECTED = "Not connected to Amazon Business.";
const TOKEN_REFUSED = "Amazon Business refused the refresh token.";
const TOKEN_MISSING = "Amazon Business did not return an access token.";
const TOKEN_LONG = "Amazon Business returned an access token that is too long to send.";
const TOKEN_SHAPE = "Amazon Business returned a token response that was not JSON.";
const PAGE_WARNING = "Amazon Business returned this page only. Raise OFFSET for the next page.";
const REGION_REFUSED = "ProductRegion must be one of US, CA, MX, UK, DE, FR, IT, ES, IN, JP, AU.";
const LOCALE_REFUSED = "Locale must be letters, digits, underscore or hyphen, such as en_US.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "An Amazon Business", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "An Amazon Business", attachedSegment: "required" };

interface AccessGrant {
  readonly token: string;
  readonly until: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credential(value: string | undefined, empty: string, max: number): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(empty, PROVIDER);
  if (text.length > max || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/** The regional API host. Empty uses North America. The access token is sent only there. */
export function amazonBusinessHost(config: Pick<DatabaseConnection, "host">): string {
  const host = pinnedApiHost(config.host, "business-api.amazon.com", "na.business-api.amazon.com", PROVIDER);
  if (!API_HOSTS.has(host)) throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return host;
}

/** The LWA client id, from the user field. */
export function amazonBusinessClientId(config: Pick<DatabaseConnection, "user">): string {
  return credential(config.user, CLIENT_REQUIRED, 256);
}

/** The LWA client secret, from the password field. It is sent only to api.amazon.com. */
export function amazonBusinessClientSecret(config: Pick<DatabaseConnection, "password">): string {
  return credential(config.password, SECRET_REQUIRED, 4096);
}

/** The LWA refresh token, from the database field. It is sent only to api.amazon.com. */
export function amazonBusinessRefreshToken(config: Pick<DatabaseConnection, "database">): string {
  return credential(config.database, REFRESH_REQUIRED, 4096);
}

/** The buying user's email. Product search requires it. Orders and transactions do not. */
export function amazonBusinessBuyerEmail(config: Pick<DatabaseConnection, "schema">): string {
  return credential(config.schema, EMAIL_REQUIRED, 320);
}

function regionFor(host: string): { productRegion: string; locale: string } {
  if (host.startsWith("eu.")) return { productRegion: "UK", locale: "en_GB" };
  if (host.startsWith("jp.")) return { productRegion: "JP", locale: "ja_JP" };
  return { productRegion: "US", locale: "en_US" };
}

/** Amazon Business connection. The refresh token buys an access token; the access token reads. */
export class AmazonBusinessProvider extends SQLBaseProvider {
  private ready = false;
  private api: NodeTransport | null = null;
  private tokens: NodeTransport | null = null;
  private grant: AccessGrant | null = null;

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
    amazonBusinessHost(this.config);
    amazonBusinessClientId(this.config);
    amazonBusinessClientSecret(this.config);
    amazonBusinessRefreshToken(this.config);
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
      await this.accessToken();
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
    const statement = translateAmazonBusinessSql(sql);
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
    return { table: { count: AMAZON_BUSINESS_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return AMAZON_BUSINESS_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = AMAZON_BUSINESS_RESOURCES.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("Amazon Business has no table with that name.", PROVIDER);
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
        `An Amazon Business bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Amazon Business has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Amazon Business API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: AMAZON_BUSINESS_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Amazon Business declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: AmazonStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") {
      const total = await this.count(statement.filters);
      return { rows: [{ [statement.alias]: total }], fields: [statement.alias], rowCount: 1 };
    }
    if (statement.resource.name === "Product") return this.products(statement);
    if (statement.resource.name === "LineItem") return this.orders(statement, true);
    if (statement.resource.name === "Order") return this.orders(statement, false);
    return this.transactions(statement);
  }

  private async products(
    statement: Extract<AmazonStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    const asin = statement.filters.find((filter) => filter.name === "ASIN")?.value;
    if (asin !== undefined) {
      const body = await this.get(`${PRODUCTS}/${encodeURIComponent(asin)}`, this.productQuery(statement.filters));
      const row = isRecord(body) && typeof body.asin === "string" ? productRow(body) : null;
      const rows = row === null ? [] : [project(row, fields)];
      return { rows, fields, rowCount: rows.length };
    }
    const page = statement.offset / statement.limit;
    const body = await this.get(PRODUCTS, {
      ...this.productQuery(statement.filters),
      pageNumber: String(page),
      pageSize: String(statement.limit),
    });
    const listed = Array.isArray(body.products) ? body.products.filter(isRecord).map(productRow) : [];
    const rows = listed.map((row) => project(row, fields));
    return withWarnings(
      { rows, fields, rowCount: rows.length },
      pageWarnings(statement, rows.length, pageMore(body, page)),
    );
  }

  private async orders(
    statement: Extract<AmazonStatement, { kind: "list" }>,
    lines: boolean,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    const query = dateQuery(statement.filters);
    if (lines) query.includeLineItems = "true";
    const body = await this.walk(ORDERS, query, statement.offset / 100);
    const orders = body === null || !Array.isArray(body.orders) ? [] : body.orders.filter(isRecord);
    const listed = lines ? orders.flatMap(lineRows) : orders.map(orderRow);
    const rows = listed.slice(0, statement.limit).map((row) => project(row, fields));
    const more = body !== null && typeof body.nextPageToken === "string" && body.nextPageToken !== "";
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length, more));
  }

  private async transactions(
    statement: Extract<AmazonStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    const body = await this.walk(TRANSACTIONS, dateQuery(statement.filters), statement.offset / 100);
    const listed =
      body === null || !Array.isArray(body.transactions) ? [] : body.transactions.filter(isRecord).map(transactionRow);
    const rows = listed.slice(0, statement.limit).map((row) => project(row, fields));
    const more = body !== null && typeof body.nextPageToken === "string" && body.nextPageToken !== "";
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length, more));
  }

  private async count(filters: readonly AmazonFilter[]): Promise<number> {
    const asin = filters.find((filter) => filter.name === "ASIN")?.value;
    if (asin !== undefined) {
      const body = await this.get(`${PRODUCTS}/${encodeURIComponent(asin)}`, this.productQuery(filters));
      return typeof body.asin === "string" ? 1 : 0;
    }
    const body = await this.get(PRODUCTS, { ...this.productQuery(filters), pageNumber: "0", pageSize: "1" });
    return typeof body.matchingProductCount === "number" ? body.matchingProductCount : 0;
  }

  private productQuery(filters: readonly AmazonFilter[]): Record<string, string> {
    const defaults = regionFor(amazonBusinessHost(this.config));
    const query: Record<string, string> = {
      productRegion: defaults.productRegion,
      locale: defaults.locale,
      facets: "OFFERS",
    };
    for (const filter of filters) {
      if (filter.name === "ASIN") continue;
      if (filter.name === "ProductRegion" && !PRODUCT_REGIONS.has(filter.value))
        throw new QueryError(REGION_REFUSED, PROVIDER);
      if (filter.name === "Locale" && !/^[A-Za-z0-9_-]+$/.test(filter.value))
        throw new QueryError(LOCALE_REFUSED, PROVIDER);
      query[filter.param] = filter.value;
    }
    return query;
  }

  /** Follow nextPageToken until the requested 100-row page. A missing token is an empty page. */
  private async walk(
    path: string,
    query: Record<string, string>,
    page: number,
  ): Promise<Record<string, unknown> | null> {
    let body = await this.get(path, query);
    for (let seen = 0; seen < page; seen += 1) {
      const token = body.nextPageToken;
      if (typeof token !== "string" || token === "") return null;
      body = await this.get(path, { ...query, nextPageToken: token });
    }
    return body;
  }

  private async accessToken(): Promise<string> {
    if (this.grant !== null && this.grant.until > Date.now()) return this.grant.token;
    const payload = await this.postToken();
    const token = payload.access_token;
    if (typeof token !== "string" || token === "") throw new AuthenticationError(TOKEN_MISSING, PROVIDER);
    if (token.length > HEADER_LIMIT || !/^[\x21-\x7e]+$/.test(token)) throw new ConnectionError(TOKEN_LONG, PROVIDER);
    const seconds = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
    this.grant = { token, until: Date.now() + Math.max(0, seconds * 1000 - EARLY_REFRESH_MS) };
    this.api?.close();
    this.api = null;
    return token;
  }

  private async postToken(): Promise<Record<string, unknown>> {
    const secret = amazonBusinessClientSecret(this.config);
    const refresh = amazonBusinessRefreshToken(this.config);
    const transport = this.tokenTransport();
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url: endpointUrl(httpOrigin("https", TOKEN_HOST, 443), TOKEN_PATH),
        form: {
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: amazonBusinessClientId(this.config),
          client_secret: secret,
        },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, [secret, refresh], TOKEN_HOST);
    }
    if (response.status >= 300 && response.status < 400)
      throw new ConnectionError(REDIRECT_REFUSED, PROVIDER, TOKEN_HOST);
    if (response.status === 400 || response.status === 401) throw new AuthenticationError(TOKEN_REFUSED, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectionError(redactSecret(response.text, secret, refresh), PROVIDER, TOKEN_HOST);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new ConnectionError(TOKEN_SHAPE, PROVIDER, TOKEN_HOST);
    }
    if (!isRecord(parsed)) throw new ConnectionError(TOKEN_SHAPE, PROVIDER, TOKEN_HOST);
    return parsed;
  }

  private async get(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const host = amazonBusinessHost(this.config);
    const headers: Record<string, string> = {};
    if (path.startsWith("/products/")) headers["x-amz-user-email"] = amazonBusinessBuyerEmail(this.config);
    const url = endpointUrl(httpOrigin("https", host, 443), path, new URLSearchParams(query));
    let response: { status: number; text: string };
    try {
      response = await this.apiTransport(token).request({
        method: "GET",
        url,
        headers,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, [token], host);
    }
    if (response.status >= 300 && response.status < 400) throw new QueryError(REDIRECT_REFUSED, PROVIDER);
    if (response.status === 404 && path.startsWith(`${PRODUCTS}/`)) return {};
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 401) throw new AuthenticationError("Amazon Business rejected the access token.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("Amazon Business refused this request.", PROVIDER);
    if (response.status === 429) throw new QueryError("Amazon Business asked the connection to slow down.", PROVIDER);
    if (response.status < 200 || response.status >= 300)
      throw new QueryError(redactSecret(response.text, token), PROVIDER);
    let parsed: unknown = {};
    if (response.text !== "") {
      try {
        parsed = JSON.parse(response.text) as unknown;
      } catch {
        throw new QueryError("Amazon Business returned an answer that was not JSON.", PROVIDER);
      }
    }
    if (!isRecord(parsed))
      throw new QueryError("Amazon Business returned an answer that was not a JSON object.", PROVIDER);
    return parsed;
  }

  private tokenTransport(): NodeTransport {
    if (this.tokens !== null) return this.tokens;
    this.tokens = this.createTransport({
      origin: httpOrigin("https", TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: TOKEN_HOST },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.tokens;
  }

  private apiTransport(token: string): NodeTransport {
    if (this.api !== null) return this.api;
    const host = amazonBusinessHost(this.config);
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json", "x-amz-access-token": token },
      requestHeaderNames: ["x-amz-user-email"],
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.api;
  }

  private closeTransports(): void {
    this.api?.close();
    this.tokens?.close();
    this.api = null;
    this.tokens = null;
    this.grant = null;
  }

  private wireFailure(error: unknown, secrets: readonly string[], host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER, host);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, ...secrets), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Amazon Business could not be reached.";
    return new ConnectionError(redactSecret(message, ...secrets), PROVIDER, host);
  }
}

function dateQuery(filters: readonly AmazonFilter[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const filter of filters) query[filter.param] = filter.value;
  return query;
}

function pageMore(body: Record<string, unknown>, page: number): boolean {
  return typeof body.numberOfPages === "number" && page + 1 < body.numberOfPages;
}

function withWarnings(
  result: Pick<QueryResult, "rows" | "fields" | "rowCount">,
  warnings: QueryWarning[],
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  return warnings.length === 0 ? result : { ...result, warnings };
}

function pageWarnings(
  statement: Extract<AmazonStatement, { kind: "list" }>,
  rows: number,
  more: boolean,
): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  if (statement.capped) {
    warnings.push({
      message: `Amazon Business returns at most ${statement.limit} rows in one page. This query asked for more, so the page is ${statement.limit}.`,
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

function moneyAmount(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.value) ? value.value : value;
  return typeof nested.amount === "number" ? nested.amount : null;
}

function moneyCurrency(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.value) ? value.value : value;
  return typeof nested.currencyCode === "string" ? nested.currencyCode : null;
}

function offerOf(product: Record<string, unknown>): Record<string, unknown> | null {
  const included = product.includedDataTypes;
  if (!isRecord(included) || !Array.isArray(included.OFFERS)) return null;
  const first = included.OFFERS[0];
  return isRecord(first) ? first : null;
}

function productRow(product: Record<string, unknown>): Record<string, unknown> {
  const listed = offerOf(product);
  const merchant = listed !== null && isRecord(listed.merchant) ? listed.merchant : null;
  return {
    ASIN: product.asin ?? null,
    Title: product.title ?? null,
    AsinType: product.asinType ?? null,
    Availability: listed?.availability ?? null,
    Price: moneyAmount(listed?.price),
    Currency: moneyCurrency(listed?.price),
    Merchant: merchant?.name ?? null,
    Condition: listed?.productCondition ?? null,
    OfferId: listed?.offerId ?? null,
  };
}

function orderRow(order: Record<string, unknown>): Record<string, unknown> {
  const buyer = isRecord(order.buyingCustomer) ? order.buyingCustomer : null;
  return {
    OrderId: order.orderId ?? null,
    OrderDate: order.orderDate ?? null,
    PurchaseOrderNumber: order.purchaseOrderNumber ?? null,
    OrderStatus: order.orderStatus ?? null,
    OrderQuantity: typeof order.orderQuantity === "number" ? order.orderQuantity : null,
    BuyerName: buyer?.name ?? null,
    BuyerEmail: buyer?.email ?? null,
    BuyerGroup: order.buyerGroupName ?? null,
    SubTotal: moneyAmount(order.orderSubTotal),
    Shipping: moneyAmount(order.orderShippingAndHandling),
    Tax: moneyAmount(order.orderTax),
    NetTotal: moneyAmount(order.orderNetTotal),
    Currency: moneyCurrency(order.orderNetTotal),
  };
}

function lineRows(order: Record<string, unknown>): Record<string, unknown>[] {
  const items = Array.isArray(order.lineItems) ? order.lineItems.filter(isRecord) : [];
  return items.map((item) => {
    const seller = isRecord(item.seller) ? item.seller : null;
    return {
      OrderId: order.orderId ?? null,
      OrderDate: order.orderDate ?? null,
      ASIN: item.asin ?? null,
      Title: item.title ?? null,
      Brand: item.brandName ?? null,
      Quantity: typeof item.itemQuantity === "number" ? item.itemQuantity : null,
      Price: moneyAmount(item.purchasedPricePerUnit),
      NetTotal: moneyAmount(item.itemNetTotal),
      Currency: moneyCurrency(item.itemNetTotal),
      Seller: seller?.sellerName ?? null,
      Category: item.productCategory ?? null,
      Condition: item.productCondition ?? null,
    };
  });
}

function transactionRow(row: Record<string, unknown>): Record<string, unknown> {
  const buyer = isRecord(row.buyer) ? row.buyer : null;
  return {
    TransactionId: row.transactionId ?? null,
    TransactionDate: row.transactionDate ?? null,
    FeedDate: row.feedDate ?? null,
    TransactionType: row.transactionType ?? null,
    InvoiceNumber: row.invoiceNumber ?? null,
    Amount: moneyAmount(row.amount),
    Currency: moneyCurrency(row.amount),
    PaymentInstrument: row.paymentInstrumentType ?? null,
    Last4: row.paymentInstrumentLast4Digits ?? null,
    BuyerName: buyer?.name ?? null,
    BuyerEmail: buyer?.email ?? null,
    LegalEntity: row.legalEntityName ?? null,
    GroupName: row.purchasingCustomerGroupName ?? null,
    MarketplaceId: row.marketplaceId ?? null,
  };
}
