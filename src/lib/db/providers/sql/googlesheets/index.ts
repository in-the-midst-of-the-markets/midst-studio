/**
 * Google Sheets provider.
 *
 * Google Sheets is one spreadsheet, not a SQL server. The editor runs a small SQL
 * subset (`translate.ts`): one SELECT of one worksheet. The first row of A1:Z501 names
 * the fields, and the filter, the order and the page are applied to those cells. One
 * statement reads that range and does not ask for the cells beyond it. Nothing is copied
 * into another database, and a write is refused before a request.
 *
 * An access token is sent only to sheets.googleapis.com. A service-account key is signed
 * here and exchanged only at oauth2.googleapis.com, and the access token that comes
 * back is what the Sheets API sees. Both calls use the shared HTTP transport, so a proxy
 * variable cannot carry the key. A redirect is not followed. A pasted access token is
 * not refreshed.
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
  SHEETS_HOST,
  SHEETS_TOKEN_HOST,
  sheetsCredential,
  sheetsSpreadsheetId,
  sheetsTokenForm,
  readSheetsTokenGrant,
  type SheetsCredential,
  type SheetsTokenGrant,
} from "./auth";
import {
  SHEETS_ROW_CAP,
  sheetsGrid,
  sheetsRows,
  sheetsTabs,
  translateSheetsSql,
  type SheetsSelect,
  type SheetsTab,
} from "./translate";

const PROVIDER = "googlesheets" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "spreadsheet";
const REDIRECT_REFUSED = "Google Sheets answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Google Sheets' answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Google Sheets does not bind parameters.";
const NOT_CONNECTED = "Not connected to Google Sheets.";
const NOT_A_LIST = "Google Sheets' answer was not a list.";
const NO_SHEET = "Google Sheets has no worksheet with that name.";
const RATE_LIMIT = "Google Sheets is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING =
  "Google Sheets returned one page of this worksheet, at most 500 rows and 26 columns. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Google Sheets reads at most 500 rows. An OFFSET past that returns nothing from this subset.";
const DATA_RANGE = "A1:Z501";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Spreadsheet", labelPlural: "Spreadsheets" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Worksheet", labelPlural: "Worksheets", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Google Sheets", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Google Sheets", attachedSegment: "required" };

interface SheetsClock {
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

export class GoogleSheetsProvider extends SQLBaseProvider {
  private ready = false;
  private grant: SheetsTokenGrant | null = null;
  private signed = "";
  private data: NodeTransport | null = null;
  private dataToken = "";
  private tokenTransport: NodeTransport | null = null;
  private tabs: readonly SheetsTab[] = [];

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createTransport: (options: NodeTransportOptions) => NodeTransport = createNodeTransport,
    private readonly clock: SheetsClock = { now: () => Date.now() },
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    sheetsCredential(this.config);
    sheetsSpreadsheetId(this.config);
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
      this.tabs = sheetsTabs(await this.json("GET", `/v4/spreadsheets/${this.spreadsheet()}`, sheetQuery()));
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
    this.tabs = [];
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateSheetsSql(sql);
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
    return { table: { count: this.tabs.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.tabs.map((item) => ({ path: [...container, item.key], name: item.key, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const tab = this.tab(name);
    const grid = sheetsGrid(await this.json("GET", this.rangePath(tab), valueQuery()));
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
        `A Google Sheets bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Google Sheets has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Google Sheets",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.tabs.length,
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
    if (spec === undefined) throw new QueryError(`Google Sheets declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private spreadsheet(): string {
    return sheetsSpreadsheetId(this.config);
  }

  private tab(name: string): SheetsTab {
    const found = this.tabs.find((item) => item.key === name);
    if (found === undefined) throw new QueryError(NO_SHEET, PROVIDER);
    return found;
  }

  private rangePath(tab: SheetsTab): string {
    const title = tab.title.replaceAll("'", "''");
    const range = `'${title}'!${DATA_RANGE}`;
    return `/v4/spreadsheets/${this.spreadsheet()}/values/${encodeURIComponent(range)}`;
  }

  private async run(
    sql: string,
    statement: SheetsSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const tab = this.tab(statement.resource.name);
    if (statement.offset >= SHEETS_ROW_CAP) {
      const fields = uniqueFieldNames(statement.columns === null ? [] : [...statement.columns]);
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const grid = sheetsGrid(await this.json("GET", this.rangePath(tab), valueQuery()));
    const rows = sheetsRows(statement, grid.columns, grid.entries, sql);
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
    const url = endpointUrl(httpOrigin("https", SHEETS_HOST, 443), path, params);
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
    const credential = sheetsCredential(this.config);
    if (credential.kind === "access_token") return credential.token;
    const cached = this.grant;
    if (cached !== null && cached.expiresAt > this.clock.now()) return cached.token;
    const grant = await this.exchange(credential);
    this.grant = grant;
    this.dataToken = "";
    return grant.token;
  }

  private async exchange(account: Extract<SheetsCredential, { kind: "service_account" }>): Promise<SheetsTokenGrant> {
    const transport = this.tokenChannel();
    const form = await sheetsTokenForm(account, this.clock.now());
    this.signed = form.assertion ?? "";
    const url = endpointUrl(httpOrigin("https", SHEETS_TOKEN_HOST, 443), "/token");
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        form,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: 64 * 1024,
      });
    } catch (error) {
      throw this.wireFailure(error);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    return readSheetsTokenGrant(response.status, response.text, this.clock.now(), [this.signed, account.privateKey]);
  }

  private answer(status: number, text: string): string {
    if (status >= 300 && status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (status === 429) throw new QueryError(RATE_LIMIT, PROVIDER);
    const message = redactSecret(
      sheetsMessage(text) ?? `Google Sheets answered ${status}.`,
      this.secretText(),
      this.grant?.token ?? "",
      this.signed,
    );
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) return text;
    throw new QueryError(message, PROVIDER);
  }

  private secretText(): string {
    const credential = sheetsCredential(this.config);
    return credential.kind === "access_token" ? credential.token : credential.privateKey;
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Google Sheets could not be reached.",
      this.secretText(),
      this.grant?.token ?? "",
      this.signed,
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
      origin: httpOrigin("https", SHEETS_HOST, 443),
      tls: { rejectUnauthorized: true, identity: SHEETS_HOST },
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
      origin: httpOrigin("https", SHEETS_TOKEN_HOST, 443),
      tls: { rejectUnauthorized: true, identity: SHEETS_TOKEN_HOST },
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
    this.signed = "";
  }
}

function sheetQuery(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("fields", "sheets.properties");
  return params;
}

function valueQuery(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("valueRenderOption", "FORMATTED_VALUE");
  params.set("majorDimension", "ROWS");
  return params;
}

function sheetsMessage(text: string): string | undefined {
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

export { sheetsCredential, sheetsSpreadsheetId, SHEETS_HOST };
