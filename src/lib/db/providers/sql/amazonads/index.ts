/**
 * Amazon Ads provider.
 *
 * Amazon Ads is an advertising API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one Sponsored Products resource. Filters and the page are
 * applied to that answer. One statement asks for 100 rows and does not follow `nextToken`.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The client secret and the refresh token are sent only to api.amazon.com. The access token
 * is sent only to an official advertising host, as an Authorization Bearer header, with the
 * client id and the profile id. A redirect is not followed. Reporting metrics are not columns.
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
import { API_ANSWER_LIMIT, assignOwnField, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  amazonAdsClientId,
  amazonAdsClientSecret,
  amazonAdsHost,
  amazonAdsProfileId,
  amazonAdsRefreshToken,
  TOKEN_HOST,
  TOKEN_PATH,
} from "./auth";
import {
  AMAZON_ADS_RESOURCES,
  AMAZON_ADS_ROW_CAP,
  amazonAdsList,
  amazonAdsResource,
  amazonAdsRows,
  translateAmazonAdsSql,
  type AmazonAdsColumn,
  type AmazonAdsSelect,
} from "./translate";

const PROVIDER = "amazonads" as const;
const MAX_SOCKETS = 4;
const HEADER_LIMIT = 1024;
const EARLY_REFRESH_MS = 60_000;
const CONTAINER_NAME = "profile";
const REDIRECT_REFUSED = "Amazon Ads answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Amazon Ads's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Amazon Ads does not bind parameters.";
const NOT_CONNECTED = "Not connected to Amazon Ads.";
const BAD_ANSWER = "Amazon Ads's answer was not a list.";
const RATE_LIMIT = "Amazon Ads is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Amazon Ads returned 100 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Amazon Ads reads at most 100 rows. An OFFSET past that returns nothing from this subset.";
const TOKEN_REFUSED = "Amazon Ads refused the refresh token.";
const TOKEN_MISSING = "Amazon Ads did not return an access token.";
const TOKEN_LONG = "Amazon Ads returned an access token that is too long to send.";
const TOKEN_SHAPE = "Amazon Ads returned a token response that was not JSON.";
const PROBE = "SELECT campaign.campaign_id FROM campaign LIMIT 1";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Profile", labelPlural: "Profiles" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "An Amazon Ads", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "An Amazon Ads", attachedSegment: "required" };

interface Grant {
  readonly token: string;
  readonly until: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: AmazonAdsColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

export class AmazonAdsProvider extends SQLBaseProvider {
  private ready = false;
  private tokens: NodeTransport | null = null;
  private api: NodeTransport | null = null;
  private apiKey = "";
  private grant: Grant | null = null;

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
    amazonAdsClientId(this.config);
    amazonAdsClientSecret(this.config);
    amazonAdsRefreshToken(this.config);
    amazonAdsProfileId(this.config);
    amazonAdsHost(this.config.host);
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
      const answer = await this.read(translateAmazonAdsSql(PROBE));
      if (!isRecord(answer) || !Array.isArray(answer.campaigns)) {
        throw new ConnectionError(BAD_ANSWER, PROVIDER);
      }
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
    const statement = translateAmazonAdsSql(sql);
    const result = await this.run(sql, statement);
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
    return { table: { count: AMAZON_ADS_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return AMAZON_ADS_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = amazonAdsResource(name);
    if (found === undefined) throw new QueryError("Amazon Ads has no table with that name.", PROVIDER);
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
        `An Amazon Ads bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Amazon Ads has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Amazon Advertising API Sponsored Products v3",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: AMAZON_ADS_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Amazon Ads declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: AmazonAdsSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= AMAZON_ADS_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const answer = await this.read(statement);
    const rows = amazonAdsRows(statement, this.entriesOf(answer, amazonAdsList(statement.resource.name).rows), sql);
    const warnings: QueryWarning[] = [];
    if (statement.capped || (isRecord(answer) && hasNext(answer))) {
      warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    }
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private entriesOf(body: unknown, key: string): unknown[] {
    if (!isRecord(body) || !Array.isArray(body[key])) {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
    return body[key] as unknown[];
  }

  private async read(statement: AmazonAdsSelect): Promise<unknown> {
    const text = await this.post(statement);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async post(statement: AmazonAdsSelect): Promise<string> {
    const token = await this.accessToken();
    const host = amazonAdsHost(this.config.host);
    const list = amazonAdsList(statement.resource.name);
    const transport = this.apiTransport(host, token);
    const url = endpointUrl(httpOrigin("https", host, 443), statement.resource.path);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        body: JSON.stringify({ maxResults: AMAZON_ADS_ROW_CAP }),
        contentType: list.media,
        headers: { Accept: list.media },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, this.hiddenSecrets());
    }
    return this.answer(response.status, response.text);
  }

  private async accessToken(): Promise<string> {
    if (this.grant !== null && this.grant.until > Date.now()) return this.grant.token;
    const payload = await this.postToken();
    const token = payload.access_token;
    if (typeof token !== "string" || token === "") throw new AuthenticationError(TOKEN_MISSING, PROVIDER);
    if (token.length > HEADER_LIMIT || !/^[\x21-\x7e]+$/.test(token)) {
      throw new ConnectionError(TOKEN_LONG, PROVIDER);
    }
    const seconds = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
    this.grant = { token, until: Date.now() + Math.max(0, seconds * 1000 - EARLY_REFRESH_MS) };
    this.api?.close();
    this.api = null;
    this.apiKey = "";
    return token;
  }

  private async postToken(): Promise<Record<string, unknown>> {
    const secret = amazonAdsClientSecret(this.config);
    const refresh = amazonAdsRefreshToken(this.config);
    let response: { status: number; text: string };
    try {
      response = await this.tokenTransport().request({
        method: "POST",
        url: endpointUrl(httpOrigin("https", TOKEN_HOST, 443), TOKEN_PATH),
        form: {
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: amazonAdsClientId(this.config),
          client_secret: secret,
        },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, [secret, refresh]);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (response.status === 400 || response.status === 401) throw new AuthenticationError(TOKEN_REFUSED, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      throw new ConnectionError(redactSecret(response.text, secret, refresh), PROVIDER);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new ConnectionError(TOKEN_SHAPE, PROVIDER);
    }
    if (!isRecord(parsed)) throw new ConnectionError(TOKEN_SHAPE, PROVIDER);
    return parsed;
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    const message = redactSecret(amazonMessage(text) ?? `Amazon Ads answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) return text;
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    const secrets = [
      amazonAdsClientId(this.config),
      amazonAdsClientSecret(this.config),
      amazonAdsRefreshToken(this.config),
    ];
    if (this.grant !== null) secrets.push(this.grant.token);
    return secrets;
  }

  private wireFailure(error: unknown, secrets: readonly string[]): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, ...secrets), PROVIDER);
    }
    if (
      error instanceof QueryError ||
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError ||
      error instanceof ConnectionError ||
      error instanceof DatabaseConfigError
    ) {
      return error;
    }
    const message = error instanceof Error ? error.message : "Amazon Ads could not be reached.";
    return new ConnectionError(redactSecret(message, ...secrets), PROVIDER);
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

  private apiTransport(host: string, token: string): NodeTransport {
    const client = amazonAdsClientId(this.config);
    const profile = amazonAdsProfileId(this.config);
    const key = `${token}\n${host}\n${client}\n${profile}`;
    if (this.api !== null && this.apiKey === key) return this.api;
    this.api?.close();
    this.apiKey = key;
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${token}`,
        "Amazon-Advertising-API-ClientId": client,
        "Amazon-Advertising-API-Scope": profile,
      },
      requestHeaderNames: ["Accept"],
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
    this.apiKey = "";
    this.grant = null;
  }
}

function hasNext(body: Record<string, unknown>): boolean {
  return typeof body.nextToken === "string" && body.nextToken !== "";
}

function amazonMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.message === "string" && parsed.message !== "") {
    return parsed.message.length > 300 ? parsed.message.slice(0, 300) : parsed.message;
  }
  const errors = parsed.errors;
  if (
    !Array.isArray(errors) ||
    !isRecord(errors[0]) ||
    typeof errors[0].message !== "string" ||
    errors[0].message === ""
  ) {
    return undefined;
  }
  return errors[0].message.length > 300 ? errors[0].message.slice(0, 300) : errors[0].message;
}
