/**
 * HubSpot provider.
 *
 * HubSpot is a REST API, not a SQL server. The editor still runs a small SQL subset
 * (`translate.ts`): SELECT with columns, WHERE, ORDER BY, LIMIT and OFFSET, COUNT(*),
 * plus a single-object INSERT, an UPDATE addressed by `id`, and a DELETE addressed by `id`.
 * Each statement is sent to the CRM API. Nothing is copied into another database.
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
import { assignOwnField, ownEntries, pinnedApiHost, readApiAnswer, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  translateHubSpotSql,
  type HubSpotFilterGroup,
  type HubSpotSelect,
  type HubSpotStatement,
  type HubSpotValue,
} from "./translate";

const PROVIDER = "hubspot" as const;
const DEFAULT_HOST = "api.hubapi.com";
const CONTAINER_NAME = "crm";
const MAX_ROWS = 1000;
const PAGE_SIZE = 100;
const COUNT_CAP = 10000;
const PARAMS_REFUSED = "Write the value in the statement. HubSpot does not bind parameters.";
const NOT_CONNECTED = "Not connected to HubSpot.";
const READ_ONLY = "This HubSpot connection is read-only.";
const CAP_WARNING = "HubSpot returned the first 1000 matching rows. Add a WHERE clause to narrow them.";
const COUNT_CAP_WARNING =
  "HubSpot reports a count of 10000 when more records match. Add a WHERE clause to narrow them.";

/** The CRM objects the editor lists. Custom objects are not read. */
const OBJECT_NAMES = ["contacts", "companies", "deals", "tickets", "products", "line_items", "quotes"] as const;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Account", labelPlural: "Accounts" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Object", labelPlural: "Objects", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A HubSpot", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A HubSpot", attachedSegment: "required" };

export type HubSpotFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface HubSpotProperty {
  readonly name: string;
  readonly type: string;
}

interface HubSpotObject {
  readonly name: string;
  readonly properties: readonly HubSpotProperty[];
}

interface HubSpotRecord {
  readonly id: string;
  readonly properties: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the token is sent to. Only a host under hubapi.com is accepted. */
export function hubSpotApiHost(config: DatabaseConnection): string {
  return pinnedApiHost(config.host, "hubapi.com", DEFAULT_HOST, PROVIDER);
}

function hubSpotMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (typeof body.error === "string" && body.error !== "") return body.error;
  return undefined;
}

function columnType(hubSpotType: string): string {
  switch (hubSpotType) {
    case "number":
      return "numeric";
    case "bool":
      return "boolean";
    case "date":
    case "datetime":
      return "timestamp";
    default:
      return "text";
  }
}

function readProperties(body: unknown): HubSpotProperty[] {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new QueryError("HubSpot did not return object properties.", PROVIDER);
  }
  const properties: HubSpotProperty[] = [];
  for (const entry of body.results) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "" || entry.name.toLowerCase() === "id") {
      continue;
    }
    properties.push({ name: entry.name, type: typeof entry.type === "string" ? entry.type : "string" });
  }
  return properties;
}

function readRecord(entry: unknown): HubSpotRecord {
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
    throw new QueryError("HubSpot returned a record with no id.", PROVIDER);
  }
  return { id: entry.id, properties: isRecord(entry.properties) ? entry.properties : {} };
}

function readPage(body: unknown): { records: HubSpotRecord[]; after?: string; total?: number } {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new QueryError("HubSpot did not return records.", PROVIDER);
  }
  const records = body.results.map((entry) => readRecord(entry));
  const paging = isRecord(body.paging) && isRecord(body.paging.next) ? body.paging.next.after : undefined;
  const after = typeof paging === "string" && paging !== "" ? paging : undefined;
  const total = typeof body.total === "number" ? body.total : undefined;
  return { records, after, total };
}

function propertyObject(pairs: readonly (readonly [string, HubSpotValue])[]): Record<string, string> {
  const present = pairs.filter((pair): pair is readonly [string, Exclude<HubSpotValue, null>] => pair[1] !== null);
  return ownEntries(
    present.map(([name, value]) => [name, typeof value === "boolean" ? (value ? "true" : "false") : String(value)]),
  );
}

export class HubSpotProvider extends SQLBaseProvider {
  private objects: HubSpotObject[] | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly fetchImpl: HubSpotFetch = fetch,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    if (!this.config.password?.trim()) {
      throw new DatabaseConfigError("A HubSpot private app token is required.", PROVIDER);
    }
    hubSpotApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote:
          "This object has more properties than a select list can usefully show. Type a property name and completion fills it in.",
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
      searchPlaceholder: "Search objects or properties...",
    };
  }

  public async connect(): Promise<void> {
    if (this.objects !== undefined) return;
    const loaded = await Promise.all(
      OBJECT_NAMES.map(async (name) => ({
        name,
        properties: readProperties(await this.request(`/crm/v3/properties/${name}`)),
      })),
    );
    this.objects = loaded;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.objects = undefined;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    const started = Date.now();
    const statement = translateHubSpotSql(sql);
    if (this.config.readOnly === true && statement.kind !== "select" && statement.kind !== "count") {
      throw new QueryError(READ_ONLY, PROVIDER, sql);
    }
    const result = await this.run(statement, sql);
    return { ...result, executionTime: Date.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireObjects();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: this.requireObjects().length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.requireObjects().map((object) => ({ path: [...container, object.name], name: object.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const object = this.resolveObject(path[path.length - 1] ?? "");
    const columns: ColumnSchema[] = [
      { name: "id", type: "text", nullable: false, isPrimary: true },
      ...object.properties.map((property) => ({
        name: property.name,
        type: columnType(property.type),
        nullable: true,
        isPrimary: false,
      })),
    ];
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A HubSpot bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("HubSpot has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return {
      version: "HubSpot CRM API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.requireObjects().length,
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

  private requireObjects(): readonly HubSpotObject[] {
    if (this.objects === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.objects;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`HubSpot declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private resolveObject(name: string): HubSpotObject {
    const objects = this.requireObjects();
    const exact = objects.find((object) => object.name === name);
    if (exact !== undefined) return exact;
    const folded = objects.filter((object) => object.name.toLowerCase() === name.toLowerCase());
    if (folded.length === 1) return folded[0];
    throw new QueryError(`HubSpot has no object "${name}".`, PROVIDER);
  }

  private async run(
    statement: HubSpotStatement,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "select") return this.select(statement, sql);
    if (statement.kind === "count") return this.countRows(statement);
    const object = this.resolveObject(statement.table);
    const objectPath = encodeURIComponent(object.name);
    if (statement.kind === "insert") {
      const body = await this.request(`/crm/v3/objects/${objectPath}/batch/create`, {
        method: "POST",
        body: JSON.stringify({ inputs: statement.rows.map((row) => ({ properties: propertyObject(row) })) }),
      });
      return rowsOf(readPage(body).records, statement.rows[0]?.map(([name]) => name) ?? [], []);
    }
    if (statement.kind === "update") {
      const body = await this.request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(statement.recordId)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: propertyObject(statement.fields) }),
      });
      return rowsOf(
        [readRecord(body)],
        statement.fields.map(([name]) => name),
        [],
      );
    }
    await this.request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(statement.recordId)}`, { method: "DELETE" });
    return { rows: [{ id: statement.recordId, deleted: true }], fields: ["id", "deleted"], rowCount: 1 };
  }

  private async countRows(statement: {
    readonly table: string;
    readonly filterGroups: readonly HubSpotFilterGroup[];
  }): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    this.resolveObject(statement.table);
    const page = await this.search(statement.table, statement.filterGroups, [], null, 1, undefined);
    const total = page.total ?? page.records.length;
    const warnings: QueryWarning[] | undefined =
      total >= COUNT_CAP ? [{ message: COUNT_CAP_WARNING, severity: "WARNING" }] : undefined;
    return {
      rows: [{ row_count: total }],
      fields: ["row_count"],
      rowCount: 1,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  private async select(
    statement: HubSpotSelect,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const object = this.resolveObject(statement.table);
    if (statement.offset >= MAX_ROWS) {
      throw new QueryError("HubSpot reads at most 1000 rows in one statement. Use a smaller OFFSET.", PROVIDER, sql);
    }
    const room = MAX_ROWS - statement.offset;
    const want = statement.limit === null ? room : Math.min(statement.limit, room);
    const schemaNames = object.properties.map((property) => property.name);
    if (want === 0) return rowsOf([], statement.columns, schemaNames);
    const maxRecords = statement.offset + want;
    const collected: HubSpotRecord[] = [];
    let cursor: string | undefined;
    let more = false;
    while (collected.length < maxRecords) {
      const pageSize = Math.min(PAGE_SIZE, maxRecords - collected.length);
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is the offset this page returns.
      const page = await this.search(
        object.name,
        statement.filterGroups,
        statement.sorts,
        statement.columns,
        pageSize,
        cursor,
      );
      collected.push(...page.records);
      if (page.after === undefined || page.records.length === 0) {
        more = false;
        break;
      }
      cursor = page.after;
      more = collected.length >= maxRecords;
    }
    const slice = collected.slice(statement.offset, statement.offset + want);
    const projected = rowsOf(slice, statement.columns, schemaNames);
    const warnings: QueryWarning[] | undefined =
      more && maxRecords === MAX_ROWS ? [{ message: CAP_WARNING, severity: "WARNING" }] : undefined;
    return warnings === undefined ? projected : { ...projected, warnings };
  }

  private async search(
    object: string,
    filterGroups: readonly HubSpotFilterGroup[],
    sorts: HubSpotSelect["sorts"],
    columns: readonly string[] | null,
    limit: number,
    after: string | undefined,
  ): Promise<{ records: HubSpotRecord[]; after?: string; total?: number }> {
    const properties = columns === null ? undefined : columns.filter((column) => column.toLowerCase() !== "id");
    const body = await this.request(`/crm/v3/objects/${encodeURIComponent(object)}/search`, {
      method: "POST",
      body: JSON.stringify({
        ...(filterGroups.length === 0
          ? {}
          : {
              filterGroups: filterGroups.map((group) => ({
                filters: group.filters.map((filter) => ({
                  propertyName: filter.property,
                  operator: filter.operator,
                  ...(filter.value === undefined ? {} : { value: filter.value }),
                })),
              })),
            }),
        ...(sorts.length === 0
          ? {}
          : { sorts: sorts.map((sort) => ({ propertyName: sort.property, direction: sort.direction })) }),
        ...(properties === undefined ? {} : { properties }),
        limit,
        ...(after === undefined ? {} : { after }),
      }),
    });
    return readPage(body);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = this.config.password?.trim() ?? "";
    const host = hubSpotApiHost(this.config);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}${path}`, {
        ...init,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "HubSpot could not be reached.";
      throw new ConnectionError(redactSecret(message, token), PROVIDER, host);
    }
    const text = await readApiAnswer(response, PROVIDER, "HubSpot");
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text };
      }
    }
    if (!response.ok) {
      const message = redactSecret(hubSpotMessage(body) ?? `HubSpot answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function rowsOf(
  records: readonly HubSpotRecord[],
  columns: readonly string[] | null,
  schemaNames: readonly string[],
): Pick<QueryResult, "rows" | "fields" | "rowCount"> {
  const names = columns === null ? schemaNames : columns.filter((name) => name.toLowerCase() !== "id");
  const declared = uniqueFieldNames(["id", ...names]);
  const rows = records.map((record) => {
    const row: Record<string, unknown> = { id: record.id };
    for (const name of names) {
      assignOwnField(row, name, Object.hasOwn(record.properties, name) ? record.properties[name] : null);
    }
    if (columns === null) {
      for (const [key, value] of Object.entries(record.properties)) {
        if (!Object.hasOwn(row, key)) assignOwnField(row, key, value);
      }
    }
    return row;
  });
  const extra = columns === null ? rows.flatMap((row) => Object.keys(row)) : [];
  return { rows, fields: extra.length === 0 ? declared : uniqueFieldNames(extra), rowCount: rows.length };
}
