/**
 * Odoo Online provider.
 *
 * Odoo Online is a JSON-2 API, not a SQL server. The editor runs a small SQL subset
 * (`translate.ts`): SELECT and COUNT(*) against one model. Each statement is one
 * search_read or search_count. Nothing is copied into another database, and a write
 * is refused before a request.
 *
 * The API key is sent only to a host under odoo.com, such as mycompany.odoo.com, over
 * TLS, on the shared HTTP transport. That path does not use global fetch, so a proxy
 * variable cannot carry the key. A custom domain that does not end in odoo.com is
 * refused. A redirect is not followed. The key is not refreshed: an Odoo API key lasts
 * at most three months.
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
import type { ColumnSchema, QueryWarning } from "@/lib/types";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, assignOwnField, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { odooCallBody, translateOdooSql, type OdooStatement } from "./translate";

const PROVIDER = "odoo" as const;
const MAX_SOCKETS = 4;
const MODEL_CAP = 200;
const FIELD_CAP = 200;
const CONTAINER_NAME = "database";
const HOST_REQUIRED = "An Odoo host is required.";
const KEY_REQUIRED = "An Odoo API key is required.";
const KEY_LINE = "An Odoo API key must be a single line of printable text.";
const REDIRECT_REFUSED = "Odoo answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Odoo's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Odoo does not bind parameters.";
const NOT_CONNECTED = "Not connected to Odoo.";
const PAGE_WARNING = "Odoo returned this page only. Raise LIMIT or add OFFSET for the next page.";
const CAP_WARNING = "Odoo returns at most 200 rows in one page. This query asked for more, so the page is 200.";
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "An Odoo", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "An Odoo", attachedSegment: "required" };

interface OdooModel {
  readonly model: string;
  readonly label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the API key is sent to. Only a host under odoo.com is accepted. */
export function odooApiHost(config: DatabaseConnection): string {
  const raw = config.host?.trim() ?? "";
  if (raw === "") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return pinnedApiHost(raw, "odoo.com", "unused.odoo.com", PROVIDER);
}

/** The API key, refused when it could split an HTTP header or is too long to send. */
export function odooApiKey(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return token;
}

function odooMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const message = body.message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

function many2one(value: unknown): readonly [number, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "string") return null;
  return [value[0], value[1]];
}

function writeFields(row: Record<string, unknown>, source: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(source)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    const pair = many2one(value);
    if (pair !== null) {
      assignOwnField(row, name, pair[0]);
      assignOwnField(row, `${name}.name`, pair[1]);
      continue;
    }
    if (Array.isArray(value)) {
      assignOwnField(row, name, null);
      continue;
    }
    if (isRecord(value)) {
      writeFields(row, value, name);
      continue;
    }
    assignOwnField(row, name, value);
  }
}

function flattenRecord(value: unknown): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (isRecord(value)) writeFields(row, value, "");
  return row;
}

function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const found = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? null : row[found];
}

function unionNames(rows: readonly Record<string, unknown>[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names.length === 0 ? ["id"] : names;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) assignOwnField(projected, field, cell(row, field));
  return projected;
}

function columnType(ttype: string): string {
  if (ttype === "boolean") return "boolean";
  if (ttype === "integer") return "integer";
  if (ttype === "float" || ttype === "monetary") return "double";
  return "varchar";
}

function safeModel(name: string): boolean {
  return name.length <= 80 && SAFE_NAME.test(name);
}

export class OdooProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private modelList: OdooModel[] | null = null;

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
    odooApiKey(this.config);
    odooApiHost(this.config);
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
      const body = await this.call("res.users", "context_get", {});
      if (!isRecord(body)) throw new QueryError("Odoo did not return a session.", PROVIDER);
    } catch (error) {
      this.closeTransport();
      throw error;
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransport();
    this.modelList = null;
    this.ready = false;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateOdooSql(sql);
    const result = await this.run(statement);
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
    const models = await this.models();
    return { table: { count: models.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    const models = await this.models();
    return models.map((model) => ({ path: [...container, model.model], name: model.model, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    if (!safeModel(name)) throw new QueryError("Odoo has no table with that name.", PROVIDER);
    const body = await this.call("ir.model.fields", "search_read", {
      domain: [["model", "=", name]],
      fields: ["name", "ttype", "required"],
      order: "name asc",
      limit: FIELD_CAP,
    });
    return { path, columns: fieldColumns(body), indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `An Odoo bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Odoo has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    const models = await this.models();
    return {
      version: "Odoo JSON-2 API",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: models.length,
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
    if (spec === undefined) throw new QueryError(`Odoo declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async models(): Promise<readonly OdooModel[]> {
    if (this.modelList !== null) return this.modelList;
    const body = await this.call("ir.model", "search_read", {
      domain: [["transient", "=", false]],
      fields: ["model", "name"],
      order: "model asc",
      limit: MODEL_CAP,
    });
    if (!Array.isArray(body)) throw new QueryError("Odoo did not return a model list.", PROVIDER);
    const models: OdooModel[] = [];
    const seen = new Set<string>();
    for (const entry of body) {
      if (!isRecord(entry) || typeof entry.model !== "string" || !safeModel(entry.model)) continue;
      if (seen.has(entry.model)) continue;
      seen.add(entry.model);
      const label = typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.model;
      models.push({ model: entry.model, label });
    }
    this.modelList = models.slice(0, MODEL_CAP);
    return this.modelList;
  }

  private async run(statement: OdooStatement): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const method = statement.kind === "count" ? "search_count" : "search_read";
    const body = await this.call(statement.model, method, odooCallBody(statement));
    const warnings: QueryWarning[] = [];
    if (statement.kind === "count") {
      if (typeof body !== "number") throw new QueryError("Odoo did not return a count.", PROVIDER);
      return { rows: [{ [statement.alias]: body }], fields: [statement.alias], rowCount: 1, warnings };
    }
    if (!Array.isArray(body)) throw new QueryError("Odoo did not return a query.", PROVIDER);
    const rows = body.map((entry) => flattenRecord(entry));
    if (statement.capped) warnings.push({ message: CAP_WARNING, severity: "WARNING" });
    if (rows.length === statement.limit) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
    const fields = uniqueFieldNames(statement.columns === null ? unionNames(rows) : [...statement.columns]);
    const projected = rows.map((row) => project(row, fields));
    return { rows: projected, fields, rowCount: projected.length, warnings };
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = odooApiHost(this.config);
    const token = odooApiKey(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "LibreDB-Studio" },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.transport;
  }

  private closeTransport(): void {
    this.transport?.close();
    this.transport = null;
  }

  private wireFailure(error: unknown, token: string, host: string): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") return new ConnectionError(REDIRECT_REFUSED, PROVIDER);
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, token), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Odoo could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async call(model: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    const token = odooApiKey(this.config);
    const host = odooApiHost(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(httpOrigin("https", host, 443), `/json/2/${encodeURIComponent(model)}/${method}`);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host);
    }
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    const text = response.text;
    if (text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    let body: unknown = {};
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(odooMessage(body) ?? `Odoo answered ${response.status}.`, token);
      if (response.status === 401) throw new AuthenticationError(message, PROVIDER);
      if (response.status === 403) throw new PermissionDeniedError(message, PROVIDER);
      throw new QueryError(message, PROVIDER);
    }
    return body;
  }
}

function fieldColumns(body: unknown): ColumnSchema[] {
  if (!Array.isArray(body)) throw new QueryError("Odoo did not return fields.", PROVIDER);
  const columns: ColumnSchema[] = [];
  const seen = new Set<string>();
  for (const entry of body) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !safeModel(entry.name)) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const ttype = typeof entry.ttype === "string" ? entry.ttype : "char";
    const required = entry.required === true || entry.name === "id";
    columns.push({
      name: entry.name,
      type: columnType(ttype),
      nullable: !required,
      isPrimary: entry.name === "id",
    });
  }
  if (!seen.has("id")) {
    columns.unshift({ name: "id", type: "integer", nullable: false, isPrimary: true });
  }
  return columns.slice(0, FIELD_CAP);
}
