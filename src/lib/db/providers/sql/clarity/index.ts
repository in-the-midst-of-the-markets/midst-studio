/**
 * Microsoft Clarity provider.
 *
 * Clarity is a data-export API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): SELECT and COUNT(*) against `insights`. Each statement is one export.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The API token is sent only to www.clarity.ms, over TLS, on the shared HTTP transport.
 * That path does not use global fetch, so a proxy variable cannot carry the token. A
 * redirect is not followed.
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
  CLARITY_DIMENSIONS,
  clarityBreakdown,
  translateClaritySql,
  type ClarityFilter,
  type ClarityOrder,
  type ClarityStatement,
} from "./translate";

const PROVIDER = "clarity" as const;
const DEFAULT_HOST = "www.clarity.ms";
const MAX_SOCKETS = 4;
const EXPORT_PATH = "/export-data/api/v1/project-live-insights";
const TABLE = "insights";
const CONTAINER_NAME = "project";
const EXACT_HOST = "The API host must be www.clarity.ms. The token is sent only there.";
const KEY_REQUIRED = "A Clarity API token is required.";
const KEY_LINE = "A Clarity API token must be a single line of printable text.";
const REDIRECT_REFUSED = "Clarity answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Clarity's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Clarity does not bind parameters.";
const NOT_CONNECTED = "Not connected to Clarity.";
const QUOTA_WARNING = "Clarity allows 10 exports a day for a project. This query used one.";
const ROW_CAP_WARNING = "Clarity returned 1000 rows and does not offer another page. Narrow the breakdown.";

const COLUMNS: readonly ColumnSchema[] = Object.freeze([
  { name: "metricName", type: "varchar", nullable: false, isPrimary: false },
  ...CLARITY_DIMENSIONS.map((name) => ({ name, type: "varchar", nullable: true, isPrimary: false })),
  { name: "totalSessionCount", type: "varchar", nullable: true, isPrimary: false },
  { name: "totalBotSessionCount", type: "varchar", nullable: true, isPrimary: false },
  { name: "distantUserCount", type: "varchar", nullable: true, isPrimary: false },
  { name: "PagesPerSessionPercentage", type: "double", nullable: true, isPrimary: false },
]);

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Project", labelPlural: "Projects" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Clarity", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Clarity", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the token is sent to. Only www.clarity.ms is accepted. */
export function clarityApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "clarity.ms", DEFAULT_HOST, PROVIDER);
  if (host !== DEFAULT_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The API token, refused when it could split an HTTP header or is too long to send. */
export function clarityToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return token;
}

function clarityMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message;
  }
  return undefined;
}

function scalar(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return null;
}

export class ClarityProvider extends SQLBaseProvider {
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
    clarityToken(this.config);
    clarityApiHost(this.config);
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
      await this.request({ numOfDays: "1" });
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
    const statement = translateClaritySql(sql);
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
    return { table: { count: 1 } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return [{ path: [...container, TABLE], name: TABLE, kind }];
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    if ((path[path.length - 1] ?? "").toLowerCase() !== TABLE) {
      throw new QueryError("Clarity has no table with that name.", PROVIDER);
    }
    return { path, columns: [...COLUMNS], indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Clarity bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Clarity has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Clarity Data Export API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 1,
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
    if (spec === undefined) throw new QueryError(`Clarity declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: ClarityStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const dimensions = clarityBreakdown(statement, statement.kind === "select" ? statement.columns : null);
    const query: Record<string, string> = { numOfDays: String(statement.days) };
    dimensions.forEach((dimension, index) => {
      query[`dimension${index + 1}`] = dimension;
    });
    const body = await this.request(query);
    const rows = filterRows(flatten(body), statement.filters);
    const warnings: QueryWarning[] = [{ message: QUOTA_WARNING, severity: "WARNING" }];
    if (rows.length >= 1000) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    if (statement.kind === "count") {
      return { rows: [{ row_count: rows.length }], fields: ["row_count"], rowCount: 1, warnings };
    }
    const ordered = orderRows(rows, statement.orderBy);
    const start = statement.offset;
    const end = statement.limit === null ? ordered.length : start + statement.limit;
    const page = ordered.slice(start, end);
    const fields = uniqueFieldNames(statement.columns === null ? unionNames(page) : [...statement.columns]);
    const projected = page.map((row) => project(row, fields));
    return { rows: projected, fields, rowCount: projected.length, warnings };
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = clarityApiHost(this.config);
    const token = clarityToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}` },
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
    const message = error instanceof Error ? error.message : "Clarity could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async request(query: Record<string, string>): Promise<unknown> {
    const token = clarityToken(this.config);
    const host = clarityApiHost(this.config);
    const transport = this.ensureTransport();
    const params = new URLSearchParams(query);
    const url = endpointUrl(httpOrigin("https", host, 443), EXPORT_PATH, params);
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
      const message = redactSecret(clarityMessage(body) ?? `Clarity answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function flatten(body: unknown): Record<string, unknown>[] {
  if (!Array.isArray(body)) throw new QueryError("Clarity did not return insights.", PROVIDER);
  const rows: Record<string, unknown>[] = [];
  for (const entry of body) {
    if (!isRecord(entry) || !Array.isArray(entry.information)) continue;
    const metricName = typeof entry.metricName === "string" ? entry.metricName : "";
    for (const item of entry.information) {
      if (!isRecord(item)) continue;
      const row: Record<string, unknown> = {};
      assignOwnField(row, "metricName", metricName);
      for (const [key, value] of Object.entries(item)) assignOwnField(row, key, scalar(value));
      rows.push(row);
    }
  }
  return rows;
}

function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const found = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? null : row[found];
}

function filterRows(
  rows: readonly Record<string, unknown>[],
  filters: readonly ClarityFilter[],
): Record<string, unknown>[] {
  return rows.filter((row) => filters.every((filter) => String(cell(row, filter.column) ?? "") === filter.value));
}

function orderRows(rows: readonly Record<string, unknown>[], orderBy: ClarityOrder | null): Record<string, unknown>[] {
  if (orderBy === null) return [...rows];
  const { column, desc } = orderBy;
  return [...rows].sort((left, right) => {
    const a = String(cell(left, column) ?? "");
    const b = String(cell(right, column) ?? "");
    const compared = a < b ? -1 : a > b ? 1 : 0;
    return desc ? -compared : compared;
  });
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
  return names.length === 0 ? ["metricName"] : names;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, scalar(cell(row, field)));
  return projected;
}
