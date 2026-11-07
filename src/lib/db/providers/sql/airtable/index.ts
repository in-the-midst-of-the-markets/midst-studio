/**
 * Airtable provider.
 *
 * Airtable is a REST API, not a SQL server. The editor still runs a small SQL subset
 * (`translate.ts`): SELECT with columns, WHERE, ORDER BY, LIMIT and OFFSET, plus a
 * single-table INSERT, an UPDATE addressed by `_id`, and a DELETE addressed by `_id`.
 * The object tree is the base's tables, from the metadata API.
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
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { translateAirtableSql, type AirtableSelect, type AirtableStatement, type AirtableValue } from "./translate";

const PROVIDER = "airtable" as const;
const DEFAULT_HOST = "api.airtable.com";
const MAX_ROWS = 1000;
const PAGE_SIZE = 100;
const PARAMS_REFUSED = "Write the value in the statement. Airtable does not bind parameters.";
const NOT_CONNECTED = "Not connected to Airtable.";
const READ_ONLY = "This Airtable connection is read-only.";
const CAP_WARNING = "Airtable returned the first 1000 matching rows. Add a WHERE clause to narrow them.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Base", labelPlural: "Bases" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "An Airtable",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "An Airtable", attachedSegment: "required" };

export type AirtableFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface MetaField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface MetaTable {
  readonly id: string;
  readonly name: string;
  readonly primaryFieldId: string;
  readonly fields: readonly MetaField[];
}

interface AirtableRecord {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the token is sent to. A pasted `https://api.airtable.com/...` keeps the host only. */
export function airtableApiHost(config: DatabaseConnection): string {
  const raw = config.host?.trim() || DEFAULT_HOST;
  const stripped = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return stripped === "" ? DEFAULT_HOST : stripped;
}

function airtableMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.error === "string" && body.error !== "") return body.error;
  if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message !== "") {
    return body.error.message;
  }
  return undefined;
}

function columnType(airtableType: string): string {
  switch (airtableType) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "count":
    case "autoNumber":
      return "numeric";
    case "checkbox":
      return "boolean";
    case "date":
    case "dateTime":
    case "createdTime":
    case "lastModifiedTime":
      return "timestamp";
    default:
      return "text";
  }
}

function readTables(body: unknown): MetaTable[] {
  if (!isRecord(body) || !Array.isArray(body.tables)) {
    throw new QueryError("Airtable did not return the base schema.", PROVIDER);
  }
  const tables: MetaTable[] = [];
  for (const entry of body.tables) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") {
      throw new QueryError("Airtable returned a table with no name.", PROVIDER);
    }
    const fields: MetaField[] = [];
    const rawFields = Array.isArray(entry.fields) ? entry.fields : [];
    for (const field of rawFields) {
      if (!isRecord(field) || typeof field.name !== "string" || field.name === "") continue;
      fields.push({
        id: typeof field.id === "string" ? field.id : field.name,
        name: field.name,
        type: typeof field.type === "string" ? field.type : "text",
      });
    }
    tables.push({
      id: typeof entry.id === "string" ? entry.id : entry.name,
      name: entry.name,
      primaryFieldId: typeof entry.primaryFieldId === "string" ? entry.primaryFieldId : "",
      fields,
    });
  }
  return tables;
}

function readRecords(body: unknown): { records: AirtableRecord[]; offset?: string } {
  if (!isRecord(body) || !Array.isArray(body.records)) {
    throw new QueryError("Airtable did not return records.", PROVIDER);
  }
  const records: AirtableRecord[] = [];
  for (const entry of body.records) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      throw new QueryError("Airtable returned a record with no id.", PROVIDER);
    }
    records.push({ id: entry.id, fields: isRecord(entry.fields) ? entry.fields : {} });
  }
  const offset = typeof body.offset === "string" && body.offset !== "" ? body.offset : undefined;
  return { records, offset };
}

function fieldObject(pairs: readonly (readonly [string, AirtableValue])[]): Record<string, AirtableValue> {
  return Object.fromEntries(pairs);
}

export class AirtableProvider extends SQLBaseProvider {
  private tables: MetaTable[] | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly fetchImpl: AirtableFetch = fetch,
  ) {
    super(config, options);
    this.validate();
  }

  public override validate(): void {
    super.validate();
    if (!this.config.password?.trim()) {
      throw new DatabaseConfigError("An Airtable access token is required.", PROVIDER);
    }
    if (!this.config.database?.trim()) {
      throw new DatabaseConfigError("An Airtable base id is required. It starts with app.", PROVIDER);
    }
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
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
      searchPlaceholder: "Search tables or columns...",
    };
  }

  public async connect(): Promise<void> {
    if (this.tables !== undefined) return;
    const base = this.config.database?.trim() ?? "";
    const body = await this.request(`/v0/meta/bases/${encodeURIComponent(base)}/tables`);
    this.tables = readTables(body);
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.tables = undefined;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    const started = Date.now();
    const statement = translateAirtableSql(sql);
    if (this.config.readOnly === true && statement.kind !== "select" && statement.kind !== "count") {
      throw new QueryError(READ_ONLY, PROVIDER, sql);
    }
    const result = await this.run(statement, sql);
    return { ...result, executionTime: Date.now() - started };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireTables();
    if (parent !== undefined && parent.length > 0) return [];
    const name = this.config.database?.trim() || "base";
    return [{ path: [name], name, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: this.requireTables().length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.requireTables().map((table) => ({ path: [...container, table.name], name: table.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const table = this.resolveTable(name);
    const columns: ColumnSchema[] = table.fields.map((field) => ({
      name: field.name,
      type: columnType(field.type),
      nullable: field.id !== table.primaryFieldId,
      isPrimary: field.id === table.primaryFieldId && table.primaryFieldId !== "",
    }));
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `An Airtable bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Airtable has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const tables = this.requireTables();
    return {
      version: "Airtable Web API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: tables.length,
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

  private requireTables(): readonly MetaTable[] {
    if (this.tables === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.tables;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Airtable declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private resolveTable(name: string): MetaTable {
    const tables = this.requireTables();
    const exact = tables.find((table) => table.name === name);
    if (exact !== undefined) return exact;
    const folded = tables.filter((table) => table.name.toLowerCase() === name.toLowerCase());
    if (folded.length === 1) return folded[0];
    if (folded.length > 1) {
      throw new QueryError(`Name ${name} matches more than one table. Quote the exact name.`, PROVIDER);
    }
    throw new QueryError(`Airtable has no table "${name}".`, PROVIDER);
  }

  private async run(
    statement: AirtableStatement,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "select") return this.select(statement, sql);
    if (statement.kind === "count") return this.countRows(statement, sql);
    const table = this.resolveTable(statement.table);
    const base = encodeURIComponent(this.config.database?.trim() ?? "");
    const tablePath = encodeURIComponent(table.name);
    if (statement.kind === "insert") {
      const body = await this.request(`/v0/${base}/${tablePath}`, {
        method: "POST",
        body: JSON.stringify({
          records: statement.rows.map((row) => ({ fields: fieldObject(row) })),
          typecast: true,
        }),
      });
      return rowsOf(
        readRecords(body).records,
        statement.rows[0].map(([name]) => name),
        [],
      );
    }
    if (statement.kind === "update") {
      const body = await this.request(`/v0/${base}/${tablePath}`, {
        method: "PATCH",
        body: JSON.stringify({
          records: [{ id: statement.recordId, fields: fieldObject(statement.fields) }],
          typecast: true,
        }),
      });
      return rowsOf(
        readRecords(body).records,
        statement.fields.map(([name]) => name),
        [],
      );
    }
    const query = new URLSearchParams();
    query.append("records[]", statement.recordId);
    await this.request(`/v0/${base}/${tablePath}?${query.toString()}`, { method: "DELETE" });
    return {
      rows: [{ _id: statement.recordId, deleted: true }],
      fields: ["_id", "deleted"],
      rowCount: 1,
    };
  }

  private async countRows(
    statement: { readonly table: string; readonly formula: string | null },
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const read = await this.select(
      {
        kind: "select",
        table: statement.table,
        columns: ["_id"],
        formula: statement.formula,
        sorts: [],
        limit: null,
        offset: 0,
      },
      sql,
    );
    const warnings = read.warnings;
    return {
      rows: [{ row_count: read.rowCount }],
      fields: ["row_count"],
      rowCount: 1,
      ...(warnings === undefined ? {} : { warnings }),
    };
  }

  private async select(
    statement: AirtableSelect,
    sql: string,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const table = this.resolveTable(statement.table);
    if (statement.offset >= MAX_ROWS) {
      throw new QueryError("Airtable reads at most 1000 rows in one statement. Use a smaller OFFSET.", PROVIDER, sql);
    }
    const room = MAX_ROWS - statement.offset;
    const want = statement.limit === null ? room : Math.min(statement.limit, room);
    const schemaNames = table.fields.map((field) => field.name);
    if (want === 0) return rowsOf([], statement.columns, schemaNames);
    const maxRecords = statement.offset + want;
    const collected: AirtableRecord[] = [];
    let cursor: string | undefined;
    let more = false;
    while (collected.length < maxRecords) {
      const pageSize = Math.min(PAGE_SIZE, maxRecords - collected.length);
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is the offset this page returns.
      const page = await this.listRecords(table, statement, pageSize, maxRecords, cursor);
      collected.push(...page.records);
      if (page.offset === undefined || page.records.length === 0) {
        more = false;
        break;
      }
      cursor = page.offset;
      more = collected.length >= maxRecords;
    }
    const slice = collected.slice(statement.offset, statement.offset + want);
    const projected = rowsOf(slice, statement.columns, schemaNames);
    const warnings: QueryWarning[] | undefined =
      more && maxRecords === MAX_ROWS ? [{ message: CAP_WARNING, severity: "WARNING" }] : undefined;
    return warnings === undefined ? projected : { ...projected, warnings };
  }

  private async listRecords(
    table: MetaTable,
    statement: AirtableSelect,
    pageSize: number,
    maxRecords: number,
    cursor: string | undefined,
  ): Promise<{ records: AirtableRecord[]; offset?: string }> {
    const params = new URLSearchParams();
    if (statement.formula !== null) params.set("filterByFormula", statement.formula);
    if (statement.columns !== null) {
      for (const column of statement.columns) {
        if (column !== "_id") params.append("fields[]", column);
      }
    }
    statement.sorts.forEach((sort, index) => {
      params.set(`sort[${index}][field]`, sort.field);
      params.set(`sort[${index}][direction]`, sort.direction);
    });
    params.set("pageSize", String(pageSize));
    params.set("maxRecords", String(maxRecords));
    if (cursor !== undefined) params.set("offset", cursor);
    const base = encodeURIComponent(this.config.database?.trim() ?? "");
    const body = await this.request(`/v0/${base}/${encodeURIComponent(table.name)}?${params.toString()}`);
    return readRecords(body);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = this.config.password?.trim() ?? "";
    const host = airtableApiHost(this.config);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Airtable could not be reached.";
      throw new ConnectionError(message, PROVIDER, host);
    }
    const text = await response.text();
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { error: { message: text } };
      }
    }
    if (!response.ok) {
      const message = airtableMessage(body) ?? `Airtable answered ${response.status}.`;
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function rowsOf(
  records: readonly AirtableRecord[],
  columns: readonly string[] | null,
  schemaNames: readonly string[],
): Pick<QueryResult, "rows" | "fields" | "rowCount"> {
  const names = columns === null ? schemaNames : columns.filter((name) => name !== "_id");
  const declared = uniqueFieldNames(["_id", ...names]);
  const rows = records.map((record) => {
    const row: Record<string, unknown> = { _id: record.id };
    for (const name of names) row[name] = Object.hasOwn(record.fields, name) ? record.fields[name] : null;
    if (columns === null) {
      for (const [key, value] of Object.entries(record.fields)) {
        if (!Object.hasOwn(row, key)) row[key] = value;
      }
    }
    return row;
  });
  const extra = columns === null ? rows.flatMap((row) => Object.keys(row)) : [];
  return { rows, fields: extra.length === 0 ? declared : uniqueFieldNames(extra), rowCount: rows.length };
}
