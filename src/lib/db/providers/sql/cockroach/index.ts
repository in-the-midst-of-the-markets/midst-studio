/**
 * CockroachDB provider.
 *
 * Cockroach answers the PostgreSQL wire protocol on port 26257. It is not a `postgres`
 * connection: that provider issues `SELECT pg_backend_pid()` when a run carries a
 * query id, and it reads sizes from `pg_total_relation_size`. This provider sends
 * the statement it was given. The catalog is `information_schema.tables` and
 * `information_schema.columns`. Schemas named `information_schema`, `pg_catalog`,
 * beginning with `pg_`, `crdb_internal` or `pg_extension` are hidden. Sizes stay
 * unmeasured: the overview does not call `pg_total_relation_size`. Maintenance is
 * not offered: a bare `ANALYZE` is not a statement this connection sends.
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
  openCockroachSession,
  type CockroachQueryResult,
  type CockroachSession,
  type CockroachSessionFactory,
} from "./session";

const PROVIDER = "cockroach" as const;
const PARAMS_REFUSED = "CockroachDB connections in Studio do not bind parameters; write the value in the statement.";
const NOT_CONNECTED = "Not connected to CockroachDB.";
const HOST_REQUIRED = "CockroachDB needs a host.";
const DATABASE_REQUIRED = "CockroachDB needs a database name.";
const USER_REQUIRED = "CockroachDB needs a user.";

const COCKROACH_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Schema", labelPlural: "Schemas" },
] as const);

const COCKROACH_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasColumns: true },
] as const);

const COCKROACH_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A CockroachDB",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A CockroachDB",
  attachedSegment: "required",
};

interface CatalogRow {
  readonly schema: string;
  readonly name: string;
  readonly kind: "table" | "view";
}

function cell(row: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : row[found];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hiddenSchema(name: string): boolean {
  const schema = name.toLowerCase();
  return (
    schema === "" ||
    schema === "information_schema" ||
    schema === "pg_catalog" ||
    schema === "crdb_internal" ||
    schema === "pg_extension" ||
    schema.startsWith("pg_")
  );
}

function kindOf(tableType: string): "table" | "view" | undefined {
  const type = tableType.toUpperCase();
  if (type === "VIEW") return "view";
  if (type === "BASE TABLE" || type === "EXTERNAL TABLE") return "table";
  return undefined;
}

function rowsOf(result: CockroachQueryResult): { rows: Record<string, unknown>[]; fields: string[]; rowCount: number } {
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

export class CockroachProvider extends SQLBaseProvider {
  private session: CockroachSession | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    _execution?: unknown,
    private readonly sessions: CockroachSessionFactory = openCockroachSession,
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
      defaultPort: 26257,
      identifierQuoting: "double",
      containerLevels: COCKROACH_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: COCKROACH_OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...super.getLabels(), entityName: "Table", entityNamePlural: "Tables" };
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined) return;
    const host = this.config.host?.trim() ?? "";
    if (host === "") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
    const database = this.config.database?.trim() ?? "";
    if (database === "") throw new DatabaseConfigError(DATABASE_REQUIRED, PROVIDER);
    const user = this.config.user?.trim() ?? "";
    if (user === "") throw new DatabaseConfigError(USER_REQUIRED, PROVIDER);
    let opened: CockroachSession | undefined;
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
    if (parent !== undefined && parent.length > 0) return [];
    const catalog = await this.catalog();
    const names: string[] = [];
    for (const row of catalog) {
      if (!names.includes(row.schema)) names.push(row.schema);
    }
    return names.map((name) => ({ path: [name], name, level: 0 }));
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, COCKROACH_CONTAINER_PATH_ENGINE);
    try {
      const rows = (await this.catalog()).filter((row) => row.schema === container[0]);
      return {
        table: { count: rows.filter((row) => row.kind === "table").length },
        view: { count: rows.filter((row) => row.kind === "view").length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { table: { unavailable: message }, view: { unavailable: message } };
    }
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    assertContainerPathShape(this.getCapabilities(), container, COCKROACH_CONTAINER_PATH_ENGINE);
    const rows = (await this.catalog()).filter((row) => row.schema === container[0] && row.kind === kind);
    return rows.map((row) => ({ path: [...container, row.name], name: row.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const schema = path[0] ?? "";
    const name = path[path.length - 1] ?? "";
    const result = await this.read(
      `SELECT c.column_name, c.data_type, c.is_nullable, CASE WHEN k.column_name IS NULL THEN 'NO' ELSE 'YES' END AS is_primary FROM information_schema.columns c LEFT JOIN (SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ${sqlString(schema)} AND tc.table_name = ${sqlString(name)}) k ON k.column_name = c.column_name WHERE c.table_schema = ${sqlString(schema)} AND c.table_name = ${sqlString(name)} ORDER BY c.ordinal_position`,
    );
    const columns: ColumnSchema[] = result.rows.map((row) => {
      const primary = text(cell(row, "is_primary")).toUpperCase() === "YES";
      const nullable = text(cell(row, "is_nullable")).toUpperCase() !== "NO";
      return {
        name: text(cell(row, "column_name")),
        type: text(cell(row, "data_type")),
        nullable: primary ? false : nullable,
        isPrimary: primary,
      };
    });
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A CockroachDB bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details: ObjectDetail[] = [];
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
    throw new QueryError(
      "CockroachDB maintenance is not run from Studio. ANALYZE names one table in the statement.",
      PROVIDER,
    );
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const version = await this.read("SELECT version()");
    const tables = (await this.catalog()).filter((row) => row.kind === "table");
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

  private requireSession(): CockroachSession {
    if (this.session === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.session;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`CockroachDB declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async catalog(): Promise<CatalogRow[]> {
    const result = await this.read(
      "SELECT table_schema, table_name, table_type FROM information_schema.tables ORDER BY table_schema, table_name",
    );
    const rows: CatalogRow[] = [];
    for (const row of result.rows) {
      const schema = text(cell(row, "table_schema"));
      const name = text(cell(row, "table_name"));
      const kind = kindOf(text(cell(row, "table_type")));
      if (name === "" || kind === undefined || hiddenSchema(schema)) continue;
      rows.push({ schema, name, kind });
    }
    return rows;
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
