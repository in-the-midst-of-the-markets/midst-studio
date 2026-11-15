/**
 * Databricks SQL provider.
 *
 * A SQL warehouse is not a Spark connection and not a Snowflake connection. Studio
 * sends the statement it was given to the statement execution API on the workspace
 * host. The catalog is `system.information_schema`. Views are not listed. The
 * `information_schema` schema stays hidden unless the connection names it.
 */
import { SQLBaseProvider } from "../sql-base";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
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
  MaintenanceType,
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
import type { ColumnSchema } from "@/lib/types";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import {
  openDatabricksSession,
  type DatabricksQueryResult,
  type DatabricksSession,
  type DatabricksSessionFactory,
} from "./session";

const PROVIDER = "databricks" as const;
const HIDDEN_SCHEMAS = new Set(["information_schema"]);
const PARAMS_REFUSED = "Databricks SQL connections in Studio do not bind parameters; write the value in the statement.";
const NOT_CONNECTED = "Not connected to Databricks SQL.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Schema", labelPlural: "Schemas" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A Databricks SQL",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Databricks SQL", attachedSegment: "required" };

function cell(row: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : row[found];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function sqlString(value: string): string {
  if (/[\u0000\r\n\\]/.test(value)) {
    throw new QueryError("Databricks SQL returned a name Studio will not send back.", PROVIDER);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function catalogPredicate(config: DatabaseConnection): string {
  const catalog = config.database?.trim() ?? "";
  if (catalog === "") return "catalog_name = current_catalog()";
  return `catalog_name = ${sqlString(catalog)}`;
}

function rowsOf(result: DatabricksQueryResult): {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
} {
  const fields = uniqueFieldNames(result.fields.map((field) => field.name));
  const rows = result.rows.map((values) => {
    const row: Record<string, unknown> = {};
    fields.forEach((name, index) => {
      row[name] = values[index];
    });
    return row;
  });
  return { rows, fields, rowCount: result.rowCount ?? rows.length };
}

export class DatabricksProvider extends SQLBaseProvider {
  private session: DatabricksSession | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    _execution?: unknown,
    private readonly sessions: DatabricksSessionFactory = openDatabricksSession,
  ) {
    super(config, options);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      supportsTestDataGeneration: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 443,
      identifierQuoting: "backtick",
      containerLevels: CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...super.getLabels(), entityName: "Table", entityNamePlural: "Tables" };
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined) return;
    const host = this.config.host?.trim() ?? "";
    if (host === "") throw new DatabaseConfigError("Databricks SQL needs a workspace host.", PROVIDER);
    let opened: DatabricksSession | undefined;
    try {
      opened = await this.sessions(this.config);
      await opened.query("SELECT 1");
      this.session = opened;
    } catch (error) {
      await opened?.end().catch(() => undefined);
      throw this.mapError(error);
    }
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    await session.end().catch(() => undefined);
  }

  public async query(sql: string, params?: unknown[], _queryId?: string, _scope?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    const session = this.requireSession();
    const started = Date.now();
    try {
      const result = rowsOf(await session.query(sql));
      return { ...result, executionTime: Date.now() - started };
    } catch (error) {
      throw this.mapError(error, sql);
    }
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireSession();
    if (parent !== undefined && parent.length > 0) return [];
    const named = this.config.schema?.trim() ?? "";
    if (named !== "") return [{ path: [named], name: named, level: 0 }];
    const result = await this.read(
      `SELECT schema_name FROM system.information_schema.schemata WHERE ${catalogPredicate(this.config)}`,
    );
    const containers: Container[] = [];
    for (const row of result.rows) {
      const name = text(cell(row, "schema_name"));
      if (name === "" || HIDDEN_SCHEMAS.has(name.toLowerCase())) continue;
      containers.push({ path: [name], name, level: 0 });
    }
    return containers;
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    try {
      const tables = await this.tableNames(container[0] ?? "");
      return { table: { count: tables.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { table: { unavailable: message } };
    }
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    const tables = await this.tableNames(container[0] ?? "");
    return tables.map((name) => ({ path: [...container, name], name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const schema = path[0] ?? "";
    const name = path[path.length - 1] ?? "";
    const result = await this.read(
      `SELECT column_name, data_type, is_nullable FROM system.information_schema.columns WHERE ${catalogPredicate(this.config)} AND table_schema = ${sqlString(schema)} AND table_name = ${sqlString(name)} ORDER BY ordinal_position`,
    );
    const columns: ColumnSchema[] = result.rows.map((row) => ({
      name: text(cell(row, "column_name")),
      type: text(cell(row, "data_type")),
      nullable: text(cell(row, "is_nullable")).toUpperCase() !== "NO",
      isPrimary: false,
    }));
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Databricks SQL bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details: ObjectDetail[] = [];
    // oxlint-disable-next-line no-await-in-loop -- the describes share the one session, one at a time.
    for (const object of bounded) details.push(await this.describeObject(object.path, kind));
    if (limit !== undefined && objects.length > limit) {
      return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
    }
    return { details };
  }

  public async getHealth(): Promise<HealthInfo> {
    return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  public async runMaintenance(_type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError("Databricks SQL has no ANALYZE or VACUUM for Studio to run.", PROVIDER);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const version = await this.read("SELECT current_version()");
    const schema = this.config.schema?.trim() || "default";
    const tables = await this.tableNames(schema);
    const build = version.rows[0] ? text(Object.values(version.rows[0])[0]) : "";
    return {
      version: build === "" ? "unknown" : build,
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

  private requireSession(): DatabricksSession {
    if (this.session === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.session;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Databricks SQL declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async tableNames(schema: string): Promise<string[]> {
    const result = await this.read(
      `SELECT table_name FROM system.information_schema.tables WHERE ${catalogPredicate(this.config)} AND table_schema = ${sqlString(schema)} AND table_type IN ('MANAGED', 'EXTERNAL')`,
    );
    const names: string[] = [];
    for (const row of result.rows) {
      const name = text(cell(row, "table_name"));
      if (name !== "") names.push(name);
    }
    return names;
  }

  private async read(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    const session = this.requireSession();
    try {
      return rowsOf(await session.query(sql));
    } catch (error) {
      throw this.mapError(error, sql);
    }
  }
}
