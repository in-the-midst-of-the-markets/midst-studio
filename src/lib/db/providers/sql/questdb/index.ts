/**
 * QuestDB provider.
 *
 * QuestDB answers PostgreSQL wire protocol on port 8812. It is not a `postgres`
 * connection: that provider issues `SELECT pg_backend_pid()` when a run carries a
 * query id, and QuestDB has no such function. This provider sends the statement
 * it was given. The catalog is `tables()` and `table_columns('name')`, not
 * `pg_total_relation_size` or `pg_stat_*`.
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
import { readOnlySeedRefusal } from "@/lib/db/credential-warnings";
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
  openQuestDbSession,
  type QuestDbQueryResult,
  type QuestDbSession,
  type QuestDbSessionFactory,
} from "./session";

const PROVIDER = "questdb" as const;
const HIDDEN_TABLES = new Set(["telemetry", "telemetry_config"]);
const PARAMS_REFUSED = "QuestDB connections in Studio do not bind parameters; write the value in the statement.";
const NOT_CONNECTED = "Not connected to QuestDB.";
const SEED_REFUSED =
  "This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.";

const QUESTDB_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

const QUESTDB_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const QUESTDB_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A QuestDB",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A QuestDB", attachedSegment: "required" };

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

function rowsOf(result: QuestDbQueryResult): { rows: Record<string, unknown>[]; fields: string[]; rowCount: number } {
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

export class QuestDbProvider extends SQLBaseProvider {
  private session: QuestDbSession | undefined;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    _execution?: unknown,
    private readonly sessions: QuestDbSessionFactory = openQuestDbSession,
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
      defaultPort: 8812,
      identifierQuoting: "double",
      containerLevels: QUESTDB_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: QUESTDB_OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...super.getLabels(), entityName: "Table", entityNamePlural: "Tables" };
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined) return;
    const host = this.config.host?.trim() ?? "";
    if (host === "") throw new DatabaseConfigError("QuestDB needs a host.", PROVIDER);
    this.refuseReadOnlySeed();
    let opened: QuestDbSession | undefined;
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
    const name = this.config.database?.trim() || "qdb";
    return [{ path: [name], name, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, QUESTDB_CONTAINER_PATH_ENGINE);
    try {
      const tables = await this.tableNames();
      return { table: { count: tables.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { table: { unavailable: message } };
    }
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    assertContainerPathShape(this.getCapabilities(), container, QUESTDB_CONTAINER_PATH_ENGINE);
    const tables = await this.tableNames();
    return tables.map((name) => ({ path: [...container, name], name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const result = await this.read(`SELECT "column", "type", designated FROM table_columns(${sqlString(name)})`);
    const columns: ColumnSchema[] = result.rows.map((row) => {
      const designated = cell(row, "designated");
      const isPrimary = designated === true || designated === "true" || designated === "t";
      return {
        name: text(cell(row, "column")),
        type: text(cell(row, "type")),
        nullable: !isPrimary,
        isPrimary,
      };
    });
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A QuestDB bulk column read limit must be a positive whole number, received ${limit}`,
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
    throw new QueryError("QuestDB has no ANALYZE or VACUUM for Studio to run.", PROVIDER);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const version = await this.read("SELECT build()");
    const tables = await this.tableNames();
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

  private refuseReadOnlySeed(): void {
    if (this.config.readOnly !== true || this.config.seedId === undefined || this.config.seedId === "") return;
    const refusal = readOnlySeedRefusal(PROVIDER, { user: this.config.user, password: this.config.password });
    if (refusal !== undefined) throw new DatabaseConfigError(`${refusal} ${SEED_REFUSED}`, PROVIDER);
  }

  private requireSession(): QuestDbSession {
    if (this.session === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.session;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`QuestDB declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async tableNames(): Promise<string[]> {
    const result = await this.read("SELECT table_name FROM tables()");
    const names: string[] = [];
    for (const row of result.rows) {
      const name = text(cell(row, "table_name"));
      if (name !== "" && !HIDDEN_TABLES.has(name.toLowerCase())) names.push(name);
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
