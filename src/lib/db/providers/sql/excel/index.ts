/**
 * Microsoft Excel provider.
 *
 * Excel is a workbook on Microsoft Graph, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): one SELECT of one worksheet. The first row of A1:Z501 names
 * the fields, and the filter, the order and the page are applied to those cells. One
 * statement reads that range and does not ask for the cells beyond it. Nothing is copied
 * into another database, and a write is refused before a request.
 *
 * An access token is sent only to graph.microsoft.com. A client secret is sent only to
 * login.microsoftonline.com, and the access token that comes back is what Graph sees.
 * Both calls use the shared HTTP transport, so a proxy variable cannot carry the secret.
 * A redirect is not followed. A pasted access token is not refreshed.
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
  EXCEL_GRAPH_HOST,
  EXCEL_SCOPE,
  EXCEL_TOKEN_HOST,
  excelCredential,
  excelWorkbookPath,
  readExcelTokenGrant,
  type ExcelCredential,
  type ExcelTokenGrant,
} from "./auth";
import {
  EXCEL_ROW_CAP,
  excelGrid,
  excelRows,
  excelSheets,
  translateExcelSql,
  type ExcelColumn,
  type ExcelSelect,
  type ExcelSheet,
} from "./translate";

const PROVIDER = "excel" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "workbook";
const REDIRECT_REFUSED = "Microsoft Excel answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Microsoft Excel's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Microsoft Excel does not bind parameters.";
const NOT_CONNECTED = "Not connected to Microsoft Excel.";
const NOT_A_LIST = "Microsoft Excel's answer was not a list.";
const NO_SHEET = "Microsoft Excel has no worksheet with that name.";
const RATE_LIMIT = "Microsoft Excel is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING =
  "Microsoft Excel returned one page of this worksheet, at most 500 rows and 26 columns. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Microsoft Excel reads at most 500 rows. An OFFSET past that returns nothing from this subset.";
const DATA_RANGE = "A1:Z501";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Workbook", labelPlural: "Workbooks" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Worksheet", labelPlural: "Worksheets", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Microsoft Excel", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Microsoft Excel", attachedSegment: "required" };

interface ExcelClock {
  now(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

export class ExcelProvider extends SQLBaseProvider {
  private ready = false;
  private grant: ExcelTokenGrant | null = null;
  private data: NodeTransport | null = null;
  private dataToken = "";
  private tokenTransport: NodeTransport | null = null;
  private sheets: readonly ExcelSheet[] = [];

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
    private readonly clock: ExcelClock = { now: () => Date.now() },
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    excelCredential(this.config);
    excelWorkbookPath(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote:
          "This worksheet has more fields than a select list can usefully show. Type a field name and completion fills it in.",
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
      entityName: "Worksheet",
      entityNamePlural: "Worksheets",
      searchPlaceholder: "Search worksheets or fields...",
    };
  }

  public async connect(): Promise<void> {
    if (this.ready) return;
    try {
      this.sheets = excelSheets(await this.json("GET", `${this.workbook()}/workbook/worksheets`, sheetQuery()));
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
    this.sheets = [];
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateExcelSql(sql);
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
    return { table: { count: this.sheets.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.sheets.map((item) => ({ path: [...container, item.key], name: item.key, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const sheet = this.sheet(name);
    const grid = excelGrid(
      await this.json("GET", this.rangePath(sheet, DATA_RANGE), new URLSearchParams({ $select: "text" })),
    );
    return {
      path,
      columns: grid.columns.map((column, index) => ({
        name: column.name,
        type: "varchar",
        nullable: index !== 0,
        isPrimary: index === 0,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Microsoft Excel bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Microsoft Excel has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Microsoft Excel",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.sheets.length,
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
    if (spec === undefined) throw new QueryError(`Microsoft Excel declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private workbook(): string {
    return excelWorkbookPath(this.config);
  }

  private sheet(name: string): ExcelSheet {
    const found = this.sheets.find((item) => item.key === name);
    if (found === undefined) throw new QueryError(NO_SHEET, PROVIDER);
    return found;
  }

  private rangePath(sheet: ExcelSheet, address: string): string {
    return `${this.workbook()}/workbook/worksheets/${encodeURIComponent(sheet.id)}/range(address='${address}')`;
  }

  private async run(
    sql: string,
    statement: ExcelSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const sheet = this.sheet(statement.resource.name);
    if (statement.offset >= EXCEL_ROW_CAP) {
      const fields = uniqueFieldNames(statement.columns === null ? [] : [...statement.columns]);
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const grid = excelGrid(
      await this.json("GET", this.rangePath(sheet, DATA_RANGE), new URLSearchParams({ $select: "text" })),
    );
    const rows = excelRows(statement, grid.columns, grid.entries, sql);
    const names = statement.columns === null ? grid.columns.map((column) => column.name) : [...statement.columns];
    const fields = uniqueFieldNames(names);
    const warnings: QueryWarning[] = [];
    if (statement.capped || grid.more) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private async json(method: "GET", path: string, params: URLSearchParams): Promise<unknown> {
    const text = await this.get(method, path, params);
    if (text === "") throw new QueryError(NOT_A_LIST, PROVIDER);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(NOT_A_LIST, PROVIDER);
    }
  }

  private async get(method: "GET", path: string, params: URLSearchParams): Promise<string> {
    const token = await this.accessToken();
    const transport = this.dataTransport(token);
    const url = endpointUrl(httpOrigin("https", EXCEL_GRAPH_HOST, 443), path, params);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method,
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    return this.answer(response.status, response.text);
  }

  private async accessToken(): Promise<string> {
    const credential = excelCredential(this.config);
    if (credential.kind === "token") return credential.token;
    const cached = this.grant;
    if (cached !== null && cached.expiresAt > this.clock.now()) return cached.token;
    const grant = await this.exchange(credential);
    this.grant = grant;
    this.dataToken = "";
    return grant.token;
  }

  private async exchange(credential: Extract<ExcelCredential, { kind: "client" }>): Promise<ExcelTokenGrant> {
    const transport = this.tokenChannel();
    const url = endpointUrl(httpOrigin("https", EXCEL_TOKEN_HOST, 443), `/${credential.tenantId}/oauth2/v2.0/token`);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        form: {
          grant_type: "client_credentials",
          client_id: credential.clientId,
          client_secret: credential.secret,
          scope: EXCEL_SCOPE,
        },
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: 64 * 1024,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    return readExcelTokenGrant(response.status, response.text, this.clock.now(), [credential.secret]);
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    const secret = this.secretText();
    const message = redactSecret(
      excelMessage(text) ?? `Microsoft Excel answered ${status}.`,
      secret,
      this.grant?.token ?? "",
    );
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) return text;
    throw new QueryError(message, PROVIDER);
  }

  private secretText(): string {
    const credential = excelCredential(this.config);
    return credential.kind === "token" ? credential.token : credential.secret;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Microsoft Excel could not be reached.",
      this.secretText(),
      this.grant?.token ?? "",
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

  private dataTransport(token: string): NodeTransport {
    if (this.data !== null && this.dataToken === token) return this.data;
    this.data?.close();
    this.dataToken = token;
    this.data = this.createTransport({
      origin: httpOrigin("https", EXCEL_GRAPH_HOST, 443),
      tls: { rejectUnauthorized: true, identity: EXCEL_GRAPH_HOST },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.data;
  }

  private tokenChannel(): NodeTransport {
    if (this.tokenTransport !== null) return this.tokenTransport;
    this.tokenTransport = this.createTransport({
      origin: httpOrigin("https", EXCEL_TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: EXCEL_TOKEN_HOST },
      maxSockets: MAX_SOCKETS,
      headers: { Accept: "application/json" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.tokenTransport;
  }

  private closeTransports(): void {
    this.data?.close();
    this.tokenTransport?.close();
    this.data = null;
    this.tokenTransport = null;
    this.dataToken = "";
    this.grant = null;
  }
}

function sheetQuery(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("$select", "id,name,visibility");
  params.set("$top", "20");
  return params;
}

function excelMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  const message = error.message;
  if (typeof message === "string" && message !== "") return message.length > 300 ? message.slice(0, 300) : message;
  const description = error.error_description;
  if (typeof description === "string" && description !== "") return description;
  const code = error.code ?? error.error;
  if (typeof code === "string" && code !== "") return code;
  return undefined;
}

export { excelCredential, excelWorkbookPath, EXCEL_GRAPH_HOST };
