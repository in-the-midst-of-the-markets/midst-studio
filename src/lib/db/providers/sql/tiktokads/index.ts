/**
 * TikTok Ads provider.
 *
 * TikTok Ads is a Marketing API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one standard resource, read with one API v1.3 list.
 * Filters and the page are applied to that answer. One statement stops at 1000 rows,
 * which is the largest page the API returns. The next page is not requested.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The access token is sent only to business-api.tiktok.com, as the `Access-Token` header.
 * Studio does not exchange or refresh it, and it does not put the token in the URL.
 * A redirect is not followed. Reporting metrics are not columns.
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
import { tiktokAdsAdvertiserId, tiktokAdsHost, readTikTokAdsToken } from "./auth";
import {
  TIKTOK_ADS_RESOURCES,
  TIKTOK_ADS_ROW_CAP,
  tiktokAdsResource,
  tiktokAdsRows,
  translateTikTokAdsSql,
  type TikTokAdsColumn,
  type TikTokAdsResource,
  type TikTokAdsSelect,
} from "./translate";

const PROVIDER = "tiktokads" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "advertiser";
const REDIRECT_REFUSED = "TikTok Ads answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "TikTok Ads's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. TikTok Ads does not bind parameters.";
const NOT_CONNECTED = "Not connected to TikTok Ads.";
const BAD_ANSWER = "TikTok Ads's answer was not a list.";
const RATE_LIMIT = "TikTok Ads is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "TikTok Ads returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "TikTok Ads reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";
const PROBE = "SELECT campaign.id FROM campaign LIMIT 1";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Advertiser", labelPlural: "Advertisers" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A TikTok Ads", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A TikTok Ads", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: TikTokAdsColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

export class TikTokAdsProvider extends SQLBaseProvider {
  private ready = false;
  private data: NodeTransport | null = null;
  private dataKey = "";

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
    readTikTokAdsToken(this.config.password);
    tiktokAdsAdvertiserId(this.config);
    tiktokAdsHost(this.config);
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
      const answer = await this.read(translateTikTokAdsSql(PROBE));
      if (!isRecord(answer) || !isRecord(answer.data) || !Array.isArray(answer.data.list)) {
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
    const statement = translateTikTokAdsSql(sql);
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
    return { table: { count: TIKTOK_ADS_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return TIKTOK_ADS_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = tiktokAdsResource(name);
    if (found === undefined) throw new QueryError("TikTok Ads has no table with that name.", PROVIDER);
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
        `A TikTok Ads bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("TikTok Ads has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "TikTok Marketing API v1.3",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: TIKTOK_ADS_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`TikTok Ads declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: TikTokAdsSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= TIKTOK_ADS_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const answer = await this.read(statement);
    const rows = tiktokAdsRows(statement, this.entriesOf(answer), sql);
    const warnings: QueryWarning[] = [];
    if (statement.capped || hasNextPage(answer)) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private entriesOf(body: unknown): unknown[] {
    if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.list)) {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
    return body.data.list;
  }

  private async read(statement: TikTokAdsSelect): Promise<unknown> {
    const text = await this.get(statement);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async get(statement: TikTokAdsSelect): Promise<string> {
    const token = readTikTokAdsToken(this.config.password);
    const host = tiktokAdsHost(this.config);
    const advertiser = tiktokAdsAdvertiserId(this.config);
    const transport = this.dataTransport(host, token, advertiser);
    const fields = JSON.stringify([...new Set(statement.resource.columns.map((column) => column.json))]);
    const query = new URLSearchParams({
      advertiser_id: advertiser,
      page: "1",
      page_size: String(TIKTOK_ADS_ROW_CAP),
      fields,
    });
    const url = `${endpointUrl(httpOrigin("https", host, 443), statement.resource.path)}?${query.toString()}`;
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    const message = redactSecret(tiktokAdsMessage(text) ?? `TikTok Ads answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) {
      if (failed(text)) throw new QueryError(message, PROVIDER);
      return text;
    }
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    return [readTikTokAdsToken(this.config.password)];
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "TikTok Ads could not be reached.",
      ...this.hiddenSecrets(),
    );
    if (error instanceof TransportError) return new ConnectionError(hidden, PROVIDER);
    if (
      error instanceof QueryError ||
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError ||
      error instanceof ConnectionError ||
      error instanceof DatabaseConfigError
    ) {
      return error;
    }
    return new ConnectionError(hidden, PROVIDER);
  }

  private dataTransport(host: string, token: string, advertiser: string): NodeTransport {
    const key = `${token}\n${host}\n${advertiser}`;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        "Access-Token": token,
        Accept: "application/json",
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private closeTransports(): void {
    this.data?.close();
    this.data = null;
    this.dataKey = "";
  }
}

function failed(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  return !isRecord(parsed) || parsed.code !== 0;
}

function hasNextPage(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.page_info)) return false;
  const pages = body.data.page_info.total_page;
  return typeof pages === "number" && pages > 1;
}

function tiktokAdsMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  const written = typeof parsed.message === "string" ? parsed.message : undefined;
  if (written !== undefined && written !== "") return written.length > 300 ? written.slice(0, 300) : written;
  return undefined;
}
