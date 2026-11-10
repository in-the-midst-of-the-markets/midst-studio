/**
 * Microsoft Ads provider.
 *
 * Microsoft Ads is a campaign API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): one SELECT of one standard resource, read with one Campaign Management
 * v13 call. Filters and the page are applied to that answer. One statement stops at 1000 rows.
 * Nothing is copied into another database, and a write is refused before a request.
 *
 * The access token and the developer token are sent only to the Campaign Management host.
 * Studio does not exchange or refresh them. A redirect is not followed. Performance reports
 * are a separate service and are not called, so this connection has no click or cost columns.
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
  microsoftAdsAccountId,
  microsoftAdsCustomerId,
  microsoftAdsHost,
  readMicrosoftAdsCredential,
  type MicrosoftAdsCredential,
} from "./auth";
import {
  MICROSOFT_ADS_RESOURCES,
  MICROSOFT_ADS_ROW_CAP,
  microsoftAdsCall,
  microsoftAdsResource,
  microsoftAdsRows,
  translateMicrosoftAdsSql,
  type MicrosoftAdsColumn,
  type MicrosoftAdsResource,
  type MicrosoftAdsSelect,
} from "./translate";

const PROVIDER = "microsoftads" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "account";
const REDIRECT_REFUSED = "Microsoft Ads answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Microsoft Ads's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Microsoft Ads does not bind parameters.";
const NOT_CONNECTED = "Not connected to Microsoft Ads.";
const BAD_ANSWER = "Microsoft Ads's answer was not a list.";
const RATE_LIMIT = "Microsoft Ads is limiting requests. Wait and run the statement again.";
const ROW_CAP_WARNING = "Microsoft Ads returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Microsoft Ads reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";
const PROBE = "SELECT campaign.id FROM campaign LIMIT 1";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Microsoft Ads", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Microsoft Ads", attachedSegment: "required" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlType(column: MicrosoftAdsColumn): string {
  return column.type === "number" ? "double" : "varchar";
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, row[field] ?? null);
  return projected;
}

export class MicrosoftAdsProvider extends SQLBaseProvider {
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
    readMicrosoftAdsCredential(this.config.password);
    microsoftAdsHost(this.config);
    microsoftAdsCustomerId(this.config);
    microsoftAdsAccountId(this.config);
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
      const answer = await this.read(translateMicrosoftAdsSql(PROBE));
      if (!isRecord(answer) || !Array.isArray(answer.Campaigns)) throw new ConnectionError(BAD_ANSWER, PROVIDER);
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
    const statement = translateMicrosoftAdsSql(sql);
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
    return { table: { count: MICROSOFT_ADS_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return MICROSOFT_ADS_RESOURCES.map((item) => ({ path: [...container, item.name], name: item.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] as string;
    const found = microsoftAdsResource(name);
    if (found === undefined) throw new QueryError("Microsoft Ads has no table with that name.", PROVIDER);
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
        `A Microsoft Ads bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Microsoft Ads has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Microsoft Advertising API v13",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: MICROSOFT_ADS_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Microsoft Ads declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    sql: string,
    statement: MicrosoftAdsSelect,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = uniqueFieldNames(
      statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
    );
    if (statement.offset >= MICROSOFT_ADS_ROW_CAP) {
      return { rows: [], fields, rowCount: 0, warnings: [{ message: OFFSET_WARNING, severity: "WARNING" }] };
    }
    const account = Number(microsoftAdsAccountId(this.config));
    const call = microsoftAdsCall(statement, account, sql);
    const answer = await this.read(statement);
    const entries = this.entriesOf(answer, statement.resource);
    const rows = microsoftAdsRows(statement, entries, call.parentId, sql);
    const warnings: QueryWarning[] = [];
    if (statement.capped) warnings.push({ message: ROW_CAP_WARNING, severity: "WARNING" });
    const projected = rows.map((row) => project(row, fields));
    return warnings.length > 0
      ? { rows: projected, fields, rowCount: projected.length, warnings }
      : { rows: projected, fields, rowCount: projected.length };
  }

  private entriesOf(body: unknown, resource: MicrosoftAdsResource): unknown[] {
    if (!isRecord(body) || !Array.isArray(body[resource.listKey])) throw new QueryError(BAD_ANSWER, PROVIDER);
    return body[resource.listKey] as unknown[];
  }

  private async read(statement: MicrosoftAdsSelect): Promise<unknown> {
    const text = await this.post(statement);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QueryError(BAD_ANSWER, PROVIDER);
    }
  }

  private async post(statement: MicrosoftAdsSelect): Promise<string> {
    const credential = readMicrosoftAdsCredential(this.config.password);
    const host = microsoftAdsHost(this.config);
    const customer = microsoftAdsCustomerId(this.config);
    const account = microsoftAdsAccountId(this.config);
    const call = microsoftAdsCall(statement, Number(account), PROBE);
    const transport = this.dataTransport(host, credential, customer, account);
    const url = endpointUrl(httpOrigin("https", host, 443), call.path);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        body: JSON.stringify(call.body),
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
    const message = redactSecret(adsMessage(text) ?? `Microsoft Ads answered ${status}.`, ...this.hiddenSecrets());
    if (status === 401) throw new AuthenticationError(message, PROVIDER);
    if (status === 403) throw new PermissionDeniedError(message, PROVIDER);
    if (status >= 200 && status < 300) {
      if (hasErrors(text)) throw new QueryError(message, PROVIDER);
      return text;
    }
    throw new QueryError(message, PROVIDER);
  }

  private hiddenSecrets(): string[] {
    const credential = readMicrosoftAdsCredential(this.config.password);
    return [credential.accessToken, credential.developerToken];
  }

  private wireFailure(error: unknown): Error {
    const hidden = redactSecret(
      error instanceof Error ? error.message : "Microsoft Ads could not be reached.",
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

  private dataTransport(
    host: string,
    credential: MicrosoftAdsCredential,
    customer: string,
    account: string,
  ): NodeTransport {
    const key = `${credential.accessToken}\n${credential.developerToken}\n${customer}\n${account}`;
    if (this.data !== null && this.dataKey === key) return this.data;
    this.data?.close();
    this.dataKey = key;
    this.data = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        DeveloperToken: credential.developerToken,
        CustomerId: customer,
        CustomerAccountId: account,
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

function hasErrors(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  return isRecord(parsed) && Array.isArray(parsed.Errors) && parsed.Errors.length > 0;
}

function adsMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return text === "" ? undefined : text.slice(0, 300);
  }
  if (!isRecord(parsed)) return undefined;
  const errors = parsed.Errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  const fromError = isRecord(first) ? first.Message : undefined;
  const message = typeof fromError === "string" ? fromError : parsed.message;
  if (typeof message === "string" && message !== "") return message.length > 300 ? message.slice(0, 300) : message;
  return undefined;
}
