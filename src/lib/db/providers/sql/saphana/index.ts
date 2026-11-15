/**
 * SAP HANA provider.
 *
 * The session is the pure JavaScript `hdb` client on the indexserver port (30015 for
 * instance 00; 443 when the server is HANA Cloud). A current schema, when the connection
 * names one, is set with `SET SCHEMA` after the probe. The catalog is `SYS.SCHEMAS`,
 * `SYS.TABLES` and `SYS.TABLE_COLUMNS`. `SYS`, `SYSTEM` and `_SYS*` schemas stay hidden
 * unless the connection names one of them.
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
  openSapHanaSession,
  type SapHanaQueryResult,
  type SapHanaSession,
  type SapHanaSessionFactory,
} from "./session";

const PROVIDER = "saphana" as const;
const PARAMS_REFUSED = "SAP HANA connections in Studio do not bind parameters; write the value in the statement.";
const NOT_CONNECTED = "Not connected to SAP HANA.";

const SAPHANA_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Schema", labelPlural: "Schemas" },
] as const);

const SAPHANA_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const SAPHANA_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A SAP HANA",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A SAP HANA", attachedSegment: "required" };

function cell(row: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : row[found];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function hiddenSchema(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "SYS" || upper === "SYSTEM" || upper.startsWith("_SYS");
}

function rowsOf(result: SapHanaQueryResult): { rows: Record<string, unknown>[]; fields: string[]; rowCount: number } {
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

export class SapHanaProvider extends SQLBaseProvider {
  private session: SapHanaSession | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    _execution?: unknown,
    private readonly sessions: SapHanaSessionFactory = openSapHanaSession,
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
      defaultPort: 30015,
      identifierQuoting: "double",
      containerLevels: SAPHANA_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: SAPHANA_OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...super.getLabels(), entityName: "Table", entityNamePlural: "Tables" };
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined) return;
    const host = this.config.host?.trim() ?? "";
    if (host === "") throw new DatabaseConfigError("SAP HANA needs a host.", PROVIDER);
    const user = this.config.user?.trim() ?? "";
    if (user === "") throw new DatabaseConfigError("SAP HANA needs a user.", PROVIDER);
    let opened: SapHanaSession | undefined;
    try {
      opened = await this.sessions(this.config);
      await opened.query("SELECT 1 FROM DUMMY");
      const schema = this.config.database?.trim() ?? "";
      if (schema !== "") await opened.query(`SET SCHEMA ${quoteIdent(schema)}`);
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
    const named = this.config.database?.trim() ?? "";
    if (named !== "") return [{ path: [named], name: named, level: 0 }];
    const result = await this.read("SELECT SCHEMA_NAME FROM SYS.SCHEMAS");
    const containers: Container[] = [];
    for (const row of result.rows) {
      const name = text(cell(row, "SCHEMA_NAME"));
      if (name === "" || hiddenSchema(name)) continue;
      containers.push({ path: [name], name, level: 0 });
    }
    return containers;
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, SAPHANA_CONTAINER_PATH_ENGINE);
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
    assertContainerPathShape(this.getCapabilities(), container, SAPHANA_CONTAINER_PATH_ENGINE);
    const tables = await this.tableNames(container[0] ?? "");
    return tables.map((name) => ({ path: [...container, name], name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const schema = path[0] ?? "";
    const name = path[path.length - 1] ?? "";
    const columns = await this.read(
      `SELECT COLUMN_NAME, DATA_TYPE_NAME, IS_NULLABLE, POSITION FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ${sqlString(schema)} AND TABLE_NAME = ${sqlString(name)} ORDER BY POSITION`,
    );
    const keys = await this.read(
      `SELECT COLUMN_NAME FROM SYS.INDEX_COLUMNS WHERE SCHEMA_NAME = ${sqlString(schema)} AND TABLE_NAME = ${sqlString(name)} AND CONSTRAINT = 'PRIMARY KEY'`,
    );
    const primary = new Set(keys.rows.map((row) => text(cell(row, "COLUMN_NAME"))));
    const described: ColumnSchema[] = columns.rows.map((row) => {
      const column = text(cell(row, "COLUMN_NAME"));
      const nullable = text(cell(row, "IS_NULLABLE")).toUpperCase();
      return {
        name: column,
        type: text(cell(row, "DATA_TYPE_NAME")),
        nullable: nullable !== "FALSE" && nullable !== "NO",
        isPrimary: primary.has(column),
      };
    });
    return { path, columns: described, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A SAP HANA bulk column read limit must be a positive whole number, received ${limit}`,
        PROVIDER,
      );
    }
    const objects = await this.listObjects(container, kind);
    const bounded = limit === undefined ? objects : objects.slice(0, limit);
    const details: ObjectDetail[] = [];
    for (const object of bounded) {
      // oxlint-disable-next-line no-await-in-loop -- the describes share the one client, one at a time.
      details.push(await this.describeObject(object.path, kind));
    }
    if (limit !== undefined && objects.length > limit) {
      return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
    }
    return { details };
  }

  public async getHealth(): Promise<HealthInfo> {
    return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
  }

  public async runMaintenance(_type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError("SAP HANA has no ANALYZE or VACUUM for Studio to run.", PROVIDER);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const version = await this.read("SELECT VERSION FROM SYS.M_DATABASE");
    const tables = await this.tableNames(this.config.database?.trim() || "");
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

  private requireSession(): SapHanaSession {
    if (this.session === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.session;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`SAP HANA declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async tableNames(schema: string): Promise<string[]> {
    const result = await this.read(
      `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ${sqlString(schema)} AND TABLE_TYPE IN ('ROW', 'COLUMN')`,
    );
    const names: string[] = [];
    for (const row of result.rows) {
      const name = text(cell(row, "TABLE_NAME"));
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
