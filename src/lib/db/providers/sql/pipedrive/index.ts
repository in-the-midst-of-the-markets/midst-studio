/**
 * Pipedrive provider.
 *
 * Pipedrive is a CRM API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one standard resource, read with one API v2 list.
 * Filters and the page are applied to that answer. One statement stops at 500 rows,
 * which is the largest page Pipedrive returns. The next page is not requested.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The API token is sent only to the Pipedrive host, as the `x-api-token` header.
 * Studio does not exchange or refresh it, and it does not put the token in the URL.
 * A redirect is not followed. Custom fields are not columns.
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
import { pipedriveHost, readPipedriveToken } from "./auth";
import {
  PIPEDRIVE_RESOURCES,
  PIPEDRIVE_ROW_CAP,
  pipedriveResource,
  pipedriveRows,
  translatePipedriveSql,
  type PipedriveColumn,
  type PipedriveResource,
  type PipedriveSelect,
} from "./translate";

const PROVIDER = "pipedrive" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "company";
const REDIRECT_REFUSED = "Pipedrive answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Pipedrive's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Pipedrive does not bind parameters.";
const NOT_CONNECTED = "Not connected to Pipedrive.";
const BAD_ANSWER = "Pipedrive's answer was not a list.";
const RATE_LIMIT = "Pipedrive is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Pipedrive returned 500 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Pipedrive reads at most 500 rows. An OFFSET past that returns nothing from this subset.";
const PROBE = "SELECT deal.id FROM deal LIMIT 1";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Company", labelPlural: "Companies" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Pipedrive", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Pipedrive", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: PipedriveColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

export class PipedriveProvider extends SQLBaseProvider {
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
    readPipedriveToken(this.config.password);
    pipedriveHost(this.config);
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
      const answer = await this.read(translatePipedriveSql(PROBE));
      if (!isRecord(answer) || (answer.data !== null && !Array.isArray(answer.data))) {
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
    const statement = translatePipedriveSql(sql);
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
    return { table: { count: PIPEDRIVE_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return PIPEDRIVE_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = pipedriveResource(name);
    if (found === undefined) throw new QueryError("Pipedrive has no table with that name.", PROVIDER);
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
        `A Pipedrive bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Pipedrive has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Pipedrive API v2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: PIPEDRIVE_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Pipedrive declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: PipedriveSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= PIPEDRIVE_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const answer = await this.read(statement);
    const rows = pipedriveRows(statement, this.entriesOf(answer), sql);
    const warnings: QueryWarning[] = [];
    if (statement.capped || hasNextPage(answer)) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private entriesOf(body: unknown): unknown[] {
    if (!isRecord(body)) throw new QueryError(BAD_ANSWER, PROVIDER);
    if (body.data === null) return [];
    if (!Array.isArray(body.data)) throw new QueryError(BAD_ANSWER, PROVIDER);
    return body.data;
  }

  private async read(statement: PipedriveSelect): Promise<unknown> {
    const text = await this.get(statement);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async get(statement: PipedriveSelect): Promise<string> {
    const token = readPipedriveToken(this.config.password);
    const host = pipedriveHost(this.config);
    const transport = this.dataTransport(host, token);
    const url = `${endpointUrl(httpOrigin("https", host, 443), statement.resource.path)}?limit=${PIPEDRIVE_ROW_CAP}`;
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
    const message = redactSecret(pipedriveMessage(text) ?? `Pipedrive answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) {
      if (failed(text)) throw new QueryError(message, PROVIDER);
      return text;
    }
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    return [readPipedriveToken(this.config.password)];
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Pipedrive could not be reached.",
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

  private dataTransport(host: string, token: string): NodeTransport {
    const key = `${token}\n${host}`;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        "x-api-token": token,
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
  return isRecord(parsed) && parsed.success === false;
}

function hasNextPage(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.additional_data)) return false;
  const cursor = body.additional_data.next_cursor;
  return typeof cursor === "string" && cursor !== "";
}

function pipedriveMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  const message = typeof parsed.error === "string" ? parsed.error : parsed.error_info;
  const written = typeof message === "string" ? message : parsed.message;
  if (typeof written === "string" && written !== "") return written.length > 300 ? written.slice(0, 300) : written;
  return undefined;
}
