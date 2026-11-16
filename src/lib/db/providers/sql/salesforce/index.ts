/**
 * Salesforce provider.
 *
 * Salesforce is a REST API, not a SQL server. The editor still runs a small SQL subset
 * (`translate.ts`): SELECT with columns or *, WHERE, ORDER BY, LIMIT and OFFSET, and COUNT(*).
 * Each statement is sent as SOQL to the org's query resource. Nothing is copied into another
 * database, and this connection does not write.
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
  callerBoundTruncationReason,
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
import { assignOwnField, pinnedApiHost, readApiAnswer, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { salesforceSoql, translateSalesforceSql, type SalesforceStatement } from "./translate";

const PROVIDER = "salesforce" as const;
const API_VERSION = "v59.0";
const CONTAINER_NAME = "org";
const STAR_FIELDS = 20;
const PAGE_CAP = 4;
const DEFAULT_LIMIT = 200;
const PARAMS_REFUSED = "Write the value in the statement. Salesforce does not bind parameters.";
const NOT_CONNECTED = "Not connected to Salesforce.";
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;

/** The standard objects the tree lists. A query can still name another object by its API name. */
const OBJECT_NAMES = ["Account", "Contact", "Lead", "Opportunity", "Case"] as const;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Org", labelPlural: "Orgs" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Object", labelPlural: "Objects", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Salesforce", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Salesforce", attachedSegment: "required" };

export type SalesforceFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface SalesforceField {
  readonly name: string;
  readonly type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the token is sent to. It has to be the org's My Domain, under salesforce.com. */
export function salesforceApiHost(config: DatabaseConnection): string {
  const raw = config.host?.trim() ?? "";
  if (raw === "") {
    throw new DatabaseConfigError(
      "A Salesforce host is required. Use the My Domain, such as mycompany.my.salesforce.com.",
      PROVIDER,
    );
  }
  return pinnedApiHost(raw, "salesforce.com", "unused.salesforce.com", PROVIDER);
}

function salesforceMessage(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    const first = body.find((entry) => isRecord(entry) && typeof entry.message === "string");
    return isRecord(first) && typeof first.message === "string" ? first.message : undefined;
  }
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (typeof body.error_description === "string" && body.error_description !== "") return body.error_description;
  return undefined;
}

function columnType(salesforceType: string): string {
  switch (salesforceType) {
    case "boolean":
      return "boolean";
    case "int":
    case "double":
    case "currency":
    case "percent":
      return "numeric";
    case "date":
    case "datetime":
    case "time":
      return "timestamp";
    default:
      return "text";
  }
}

function readFields(body: unknown): SalesforceField[] {
  if (!isRecord(body) || !Array.isArray(body.fields)) {
    throw new QueryError("Salesforce did not return object fields.", PROVIDER);
  }
  const fields: SalesforceField[] = [];
  for (const entry of body.fields) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !NAME.test(entry.name)) continue;
    fields.push({ name: entry.name, type: typeof entry.type === "string" ? entry.type : "string" });
  }
  if (fields.length === 0) throw new QueryError("Salesforce did not return object fields.", PROVIDER);
  return fields;
}

function cell(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  const text = JSON.stringify(value);
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

function readRecords(body: unknown): { records: Record<string, unknown>[]; next?: string } {
  if (!isRecord(body) || !Array.isArray(body.records)) {
    throw new QueryError("Salesforce did not return records.", PROVIDER);
  }
  const records = body.records.filter(isRecord).map((record) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "attributes") continue;
      assignOwnField(row, key, cell(value));
    }
    return row;
  });
  const next = typeof body.nextRecordsUrl === "string" && body.nextRecordsUrl !== "" ? body.nextRecordsUrl : undefined;
  return { records, next: body.done === false ? next : undefined };
}

function nextPath(link: string, host: string): string | undefined {
  if (link.startsWith("/services/data/")) return link;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  if (url.hostname.toLowerCase() !== host) return undefined;
  if (!url.pathname.startsWith("/services/data/")) return undefined;
  return `${url.pathname}${url.search}`;
}

function countValue(record: Record<string, unknown>): number {
  for (const value of Object.values(record)) {
    if (typeof value === "number") return value;
  }
  throw new QueryError("Salesforce did not return a count.", PROVIDER);
}

export class SalesforceProvider extends SQLBaseProvider {
  private open = false;
  private readonly described = new Map<string, SalesforceField[]>();

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly fetchImpl: SalesforceFetch = fetch,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    if (!this.config.password?.trim()) {
      throw new DatabaseConfigError("A Salesforce access token is required.", PROVIDER);
    }
    salesforceApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: STAR_FIELDS,
        starNote:
          "This object has more fields than a select list can usefully show. Type a field name and completion fills it in.",
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
      entityName: "Object",
      entityNamePlural: "Objects",
      searchPlaceholder: "Search objects or fields...",
    };
  }

  public async connect(): Promise<void> {
    if (this.open) return;
    await this.request(`/services/data/${API_VERSION}/`);
    this.open = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.open = false;
    this.described.clear();
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireOpen();
    const started = Date.now();
    const statement = translateSalesforceSql(sql);
    const result = await this.run(statement);
    return { ...result, executionTime: Date.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireOpen();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireOpen();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: OBJECT_NAMES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireOpen();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return OBJECT_NAMES.map((name) => ({ path: [...container, name], name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireOpen();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    if (!NAME.test(name)) throw new QueryError(`Salesforce has no object "${name}".`, PROVIDER);
    const fields = await this.fieldsOf(name);
    const columns: ColumnSchema[] = fields.map((field) => ({
      name: field.name,
      type: columnType(field.type),
      nullable: field.name !== "Id",
      isPrimary: field.name === "Id",
    }));
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Salesforce bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(bounded.map((object) => this.describeObject(object.path, kind)));
    if (limit !== undefined && objects.length > limit) {
      return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
    }
    return { details };
  }

  public getHealth(): Promise<HealthInfo> {
    return Promise.resolve({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
  }

  public runMaintenance(): Promise<MaintenanceResult> {
    return Promise.reject(new QueryError("Salesforce has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireOpen();
    return {
      version: `Salesforce REST ${API_VERSION}`,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: OBJECT_NAMES.length,
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

  private requireOpen(): void {
    if (!this.open) throw new QueryError(NOT_CONNECTED, PROVIDER);
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Salesforce declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async fieldsOf(object: string): Promise<readonly SalesforceField[]> {
    const cached = this.described.get(object);
    if (cached !== undefined) return cached;
    const fields = readFields(await this.request(`/services/data/${API_VERSION}/sobjects/${encodeURIComponent(object)}/describe`));
    this.described.set(object, fields);
    return fields;
  }

  private async run(statement: SalesforceStatement): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") {
      const body = await this.request(this.queryPath(salesforceSoql(statement, [])));
      const page = readRecords(body);
      const record = page.records[0];
      if (record === undefined) throw new QueryError("Salesforce did not return a count.", PROVIDER);
      return { rows: [{ row_count: countValue(record) }], fields: ["row_count"], rowCount: 1 };
    }
    const described = statement.columns === null ? await this.fieldsOf(statement.object) : undefined;
    const columns = statement.columns ?? starColumns(described ?? []);
    const soql = salesforceSoql({ ...statement, limit: statement.limit ?? DEFAULT_LIMIT }, columns);
    const page = await this.pages(soql, statement.limit ?? DEFAULT_LIMIT);
    const rows = page.records.map((record) => project(record, columns));
    const warnings: QueryWarning[] | undefined = page.more
      ? [{ message: "Salesforce returned the first page. Add a WHERE clause or a smaller LIMIT.", severity: "WARNING" }]
      : undefined;
    return {
      rows,
      fields: uniqueFieldNames(columns),
      rowCount: rows.length,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  private queryPath(soql: string): string {
    return `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  }

  private async pages(soql: string, limit: number): Promise<{ records: Record<string, unknown>[]; more: boolean }> {
    const host = salesforceApiHost(this.config);
    const collected: Record<string, unknown>[] = [];
    let path: string | undefined = this.queryPath(soql);
    let more = false;
    for (let page = 0; page < PAGE_CAP && path !== undefined; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's path is the link this page returns.
      const body = await this.request(path);
      const batch = readRecords(body);
      collected.push(...batch.records);
      if (batch.next === undefined || collected.length >= limit) {
        more = batch.next !== undefined && collected.length >= limit;
        path = undefined;
        continue;
      }
      const next = nextPath(batch.next, host);
      if (next === undefined) {
        throw new QueryError("Salesforce returned another page on a different host.", PROVIDER);
      }
      path = next;
    }
    if (path !== undefined) more = true;
    return { records: collected.slice(0, limit), more };
  }

  private async request(path: string): Promise<unknown> {
    const token = this.config.password?.trim() ?? "";
    const host = salesforceApiHost(this.config);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}${path}`, {
        redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salesforce could not be reached.";
      throw new ConnectionError(redactSecret(message, token), PROVIDER, host);
    }
    const text = await readApiAnswer(response, PROVIDER, "Salesforce");
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new QueryError("Salesforce did not return JSON.", PROVIDER);
      }
    }
    if (!response.ok) {
      const message = redactSecret(salesforceMessage(body) ?? `Salesforce answered ${response.status}.`, token).slice(0, 300);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function starColumns(fields: readonly SalesforceField[]): string[] {
  const names = fields.map((field) => field.name);
  const id = names.includes("Id") ? ["Id"] : [];
  const rest = names.filter((name) => name !== "Id").slice(0, STAR_FIELDS);
  return [...id, ...rest];
}

function project(record: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const name of columns) assignOwnField(row, name, Object.hasOwn(record, name) ? record[name] : null);
  return row;
}
