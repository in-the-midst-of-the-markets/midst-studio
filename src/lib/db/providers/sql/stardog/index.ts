/**
 * Stardog provider.
 *
 * One database on a Stardog server. The editor writes SPARQL. Studio sends a
 * SELECT or an ASK to `POST /{database}/query` and reads SPARQL JSON. Classes
 * are the objects and their properties are the columns. This connection does
 * not write. No live server was measured; tests pass a scripted HTTP client.
 */
import { SQLBaseProvider } from "../sql-base";
import { DatabaseError, QueryError } from "@/lib/db/errors";
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
  PreparedQuery,
  QueryPrepareOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { openStardogSession, type StardogAnswer, type StardogSession } from "./session";

const PROVIDER = "stardog" as const;
const CLASS_CAP = 200;
const PROPERTY_CAP = 80;
const PARAMS_REFUSED = "Stardog connections in Studio do not bind parameters; write the value in the statement.";
const NOT_CONNECTED = "Not connected to Stardog.";
const READ_ONLY = "This connection reads. Write one SELECT or ASK.";
const IRI = /^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]{1,400}$/;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "class", role: "relation", label: "Class", labelPlural: "Classes", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Stardog", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Stardog", attachedSegment: "required" };

type SessionFactory = (config: DatabaseConnection) => Promise<StardogSession>;

/** Comments, IRIs and quoted strings removed, so a word inside one is not a verb. */
function codeOf(sparql: string): string {
  return sparql
    .replace(/#[^\n]*/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ");
}

/** SELECT or ASK, after PREFIX and BASE. Anything else is refused before a request. */
export function assertStardogRead(sparql: string): void {
  const code = codeOf(sparql).trim();
  const body = code.replace(/^(?:(?:prefix\s+[A-Za-z][\w-]*:|base)\s*)+/i, "").trim();
  if (!/^(?:select|ask)\b/i.test(body)) throw new QueryError(READ_ONLY, PROVIDER, sparql);
  if (/\b(?:insert|delete|load|clear|drop|create|copy|move)\b/i.test(body)) {
    throw new QueryError(READ_ONLY, PROVIDER, sparql);
  }
}

function iriOf(value: unknown): string | undefined {
  return typeof value === "string" && IRI.test(value) ? value : undefined;
}

function classesOf(answer: StardogAnswer): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of answer.rows) {
    const iri = iriOf(row.class);
    if (iri === undefined || seen.has(iri)) continue;
    seen.add(iri);
    names.push(iri);
  }
  return names;
}

function countOf(answer: StardogAnswer): number {
  const value = answer.rows[0]?.count;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new QueryError("Stardog did not return a class count.", PROVIDER);
}

export class StardogProvider extends SQLBaseProvider {
  private session: StardogSession | undefined;
  private readonly properties = new Map<string, string[]>();

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    _execution?: unknown,
    private readonly sessions: SessionFactory = openStardogSession,
  ) {
    super(config, options);
  }

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return { query, wasLimited: false, limit: options.limit ?? 0, offset: options.offset ?? 0 };
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsTransactions: false,
      supportsTestDataGeneration: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 5820,
      identifierQuoting: "double",
      containerLevels: CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      entityName: "Class",
      entityNamePlural: "Classes",
      searchPlaceholder: "Search classes or properties...",
    };
  }

  public async connect(): Promise<void> {
    if (this.session !== undefined) return;
    let opened: StardogSession | undefined;
    try {
      opened = await this.sessions(this.config);
      await opened.query("ASK { ?s ?p ?o }");
      this.session = opened;
      this.setConnected(true);
    } catch (error) {
      await opened?.end().catch(() => undefined);
      if (error instanceof DatabaseError) throw error;
      throw new QueryError("Stardog could not be reached.", PROVIDER);
    }
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.properties.clear();
    this.setConnected(false);
    await session?.end().catch(() => undefined);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    assertStardogRead(sql);
    const session = this.requireSession();
    const started = Date.now();
    const answer = await session.query(sql);
    return {
      rows: answer.rows,
      fields: uniqueFieldNames(answer.fields),
      rowCount: answer.rows.length,
      executionTime: Date.now() - started,
    };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireSession();
    const name = this.config.database?.trim() ?? "";
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [name], name, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireSession();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    const answer = await this.requireSession().query("SELECT (COUNT(DISTINCT ?class) AS ?count) WHERE { ?s a ?class }");
    return { class: { count: countOf(answer) } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireSession();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    const answer = await this.requireSession().query(`SELECT DISTINCT ?class WHERE { ?s a ?class } LIMIT ${CLASS_CAP}`);
    return classesOf(answer).map((name) => ({ path: [...container, name], name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireSession();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    if (!IRI.test(name)) throw new QueryError("Stardog has no class with that name.", PROVIDER);
    const names = await this.propertiesOf(name);
    const columns: ColumnSchema[] = names.map((property) => ({
      name: property,
      type: "text",
      nullable: true,
      isPrimary: false,
    }));
    return { path, columns, indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Stardog bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Stardog has no maintenance operation for Studio to run.", PROVIDER));
  }

  public getOverview(): Promise<DatabaseOverview> {
    return Promise.resolve({
      version: "Stardog SPARQL",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 0,
      indexCount: 0,
    });
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

  private requireSession(): StardogSession {
    if (this.session === undefined) throw new QueryError(NOT_CONNECTED, PROVIDER);
    return this.session;
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Stardog declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async propertiesOf(iri: string): Promise<string[]> {
    const cached = this.properties.get(iri);
    if (cached !== undefined) return cached;
    const answer = await this.requireSession().query(
      `SELECT DISTINCT ?property WHERE { ?s a <${iri}> ; ?property ?o } LIMIT ${PROPERTY_CAP}`,
    );
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of answer.rows) {
      const property = iriOf(row.property);
      if (property === undefined || seen.has(property)) continue;
      seen.add(property);
      names.push(property);
    }
    this.properties.set(iri, names);
    return names;
  }
}
