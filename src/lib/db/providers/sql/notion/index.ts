/**
 * Notion provider.
 *
 * A statement is one read-only SELECT. Studio translates it into a query of one
 * data source the integration was invited to, and reads the pages back as rows.
 * A page body is not requested. Nothing is copied into another database, and a
 * write is refused before a request.
 *
 * The integration token is sent only to api.notion.com, over TLS, on the shared
 * HTTP transport. That path does not use global fetch, so a proxy setting cannot
 * carry the token. A redirect is not followed.
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
import {
  NOTION_ROW_CAP,
  notionFilter,
  notionSorts,
  translateNotionSql,
  type NotionProperty,
  type NotionStatement,
} from "./translate";
import { notionCell, notionTitle } from "./values";

const PROVIDER = "notion" as const;
const NOTION_VERSION = "2026-03-11";
const DEFAULT_HOST = "api.notion.com";
const MAX_SOCKETS = 4;
const PAGE_SIZE = 100;
const CONTAINER_NAME = "workspace";
const EXACT_HOST = "The API host must be api.notion.com. The token is sent only there.";
const TOKEN_REQUIRED = "A Notion integration token is required.";
const TOKEN_LINE = "A Notion integration token must be a single line of printable text.";
const REDIRECT_REFUSED = "Notion answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Notion's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Notion does not bind parameters.";
const NOT_CONNECTED = "Not connected to Notion.";
const BAD_ANSWER = "Notion's answer was not a list of pages.";
const ROW_CAP_WARNING = "Notion returned 1000 rows. Narrow the filter to see the rest.";
const OFFSET_WARNING = "Notion reads at most 1000 rows. An OFFSET past that returns nothing from this subset.";

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Workspace", labelPlural: "Workspaces" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Database", labelPlural: "Databases", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = { code: PROVIDER, label: "A Notion", shapeNames: "label" };
const OBJECT_PATH: ObjectPathShapeEngine = { code: PROVIDER, label: "A Notion", attachedSegment: "required" };

interface NotionSource {
  readonly id: string;
  readonly name: string;
  readonly properties: readonly NotionProperty[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host the token is sent to. Only api.notion.com is accepted. */
export function notionApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "notion.com", DEFAULT_HOST, PROVIDER);
  if (host !== DEFAULT_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** The integration token, refused when it could split an HTTP header or is too long to send. */
export function notionToken(config: DatabaseConnection): string {
  const token = config.password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  const header = `Bearer ${token}`;
  if (header.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return token;
}

function notionMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string" && body.message !== "") return body.message;
  return undefined;
}

function sqlType(type: string): string {
  if (type === "number") return "double";
  if (type === "unique_id") return "bigint";
  if (type === "checkbox") return "boolean";
  if (type === "date" || type === "created_time" || type === "last_edited_time") return "timestamptz";
  return "varchar";
}

function propertiesOf(value: unknown): NotionProperty[] {
  if (!isRecord(value)) return [];
  const properties: NotionProperty[] = [];
  for (const [name, property] of Object.entries(value)) {
    if (!isRecord(property) || typeof property.type !== "string" || property.type === "") continue;
    if (name === "__proto__" || name === "prototype" || name === "constructor") continue;
    properties.push({ name, type: property.type });
  }
  return properties;
}

function sourceName(title: string, id: string, shared: boolean): string {
  const shown = title === "" ? id : title;
  if (!shared) return shown;
  return `${shown} (${id.replaceAll("-", "").slice(0, 8)})`;
}

function readSources(results: readonly unknown[]): NotionSource[] {
  const pending = results.flatMap((item) => {
    if (!isRecord(item) || item.object !== "data_source" || typeof item.id !== "string" || item.id === "") return [];
    if (item.in_trash === true) return [];
    return [{ id: item.id, title: notionTitle(item.title), properties: propertiesOf(item.properties) }];
  });
  const counts = new Map<string, number>();
  for (const item of pending) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  return pending.map((item) => ({
    id: item.id,
    name: sourceName(item.title, item.id, (counts.get(item.title) ?? 0) > 1),
    properties: item.properties,
  }));
}

function columnsOf(source: NotionSource): ColumnSchema[] {
  const names = uniqueFieldNames(["_id", ...source.properties.map((property) => property.name)]);
  return names.map((name, index) => {
    const property = index === 0 ? undefined : source.properties[index - 1];
    return {
      name,
      type: property === undefined ? "varchar" : sqlType(property.type),
      nullable: property !== undefined,
      isPrimary: property === undefined,
    };
  });
}

function projectRow(
  page: Record<string, unknown>,
  source: NotionSource,
  fields: readonly string[],
): Record<string, unknown> {
  const names = uniqueFieldNames(["_id", ...source.properties.map((property) => property.name)]);
  const properties = isRecord(page.properties) ? page.properties : {};
  const row: Record<string, unknown> = {};
  names.forEach((field, index) => {
    if (!fields.includes(field)) return;
    if (index === 0) {
      assignOwnField(row, field, typeof page.id === "string" ? page.id : null);
      return;
    }
    const property = source.properties[index - 1];
    assignOwnField(row, field, property === undefined ? null : notionCell(properties[property.name]));
  });
  return row;
}

function selectedFields(statement: NotionStatement, source: NotionSource): string[] {
  const names = uniqueFieldNames(["_id", ...source.properties.map((property) => property.name)]);
  if (statement.kind === "count" || statement.columns === null) return names;
  return statement.columns.map((column) => {
    const exact = names.find((name) => name === column);
    if (exact !== undefined) return exact;
    const folded = names.filter((name) => name.toLowerCase() === column.toLowerCase());
    if (folded.length === 1) return folded[0];
    throw new QueryError(`Notion has no property named ${column}.`, PROVIDER);
  });
}

export class NotionProvider extends SQLBaseProvider {
  private ready = false;
  private transport: NodeTransport | null = null;
  private sources: readonly NotionSource[] = [];

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
    notionToken(this.config);
    notionApiHost(this.config);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      supportsExplain: false,
      supportsConstantPredicate: false,
      starterColumnLimit: {
        max: 8,
        starNote: "Name the properties. A Notion database has more of them than a list can usefully show.",
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
      entityName: "Database",
      entityNamePlural: "Databases",
      searchPlaceholder: "Search databases or properties...",
    };
  }

  public async connect(): Promise<void> {
    if (this.ready) return;
    try {
      this.sources = await this.loadSources();
    } catch (error) {
      this.closeTransport();
      throw error;
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransport();
    this.sources = [];
    this.ready = false;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateNotionSql(sql);
    const source = this.findSource(statement.table);
    const filter = notionFilter(statement.kind === "select" ? statement.where : statement.where, source.properties);
    const sorts = statement.kind === "select" ? notionSorts(statement.sorts, source.properties) : [];
    const fields = selectedFields(statement, source);
    const read = await this.readRows(source, filter, sorts, statement);
    if (statement.kind === "count") {
      const warnings = read.warnings;
      return {
        rows: [{ count: read.rows.length }],
        fields: ["count"],
        rowCount: 1,
        executionTime: Date.now() - started,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const rows = read.rows.map((page) => projectRow(page, source, fields));
    return {
      rows,
      fields,
      rowCount: rows.length,
      executionTime: Date.now() - started,
      ...(read.warnings.length > 0 ? { warnings: read.warnings } : {}),
    };
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.requireReady();
    if (parent !== undefined && parent.length > 0) return [];
    return [{ path: [CONTAINER_NAME], name: CONTAINER_NAME, level: 0 }];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return { table: { count: this.sources.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return this.sources.map((source) => ({ path: [...container, source.name], name: source.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const source = this.findSource(path[path.length - 1] ?? "");
    return { path, columns: columnsOf(source), indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Notion bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Notion has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: `Notion ${NOTION_VERSION}`,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: this.sources.length,
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
    if (spec === undefined) throw new QueryError(`Notion declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private findSource(name: string): NotionSource {
    const bare = name.replaceAll("-", "");
    const exact = this.sources.find(
      (source) => source.name === name || source.id === name || source.id.replaceAll("-", "") === bare,
    );
    if (exact !== undefined) return exact;
    const folded = this.sources.filter((source) => source.name.toLowerCase() === name.toLowerCase());
    if (folded.length === 1) return folded[0];
    throw new QueryError(
      "Notion has no database with that name. Share the database with the integration, then connect again.",
      PROVIDER,
    );
  }

  private ensureTransport(): NodeTransport {
    if (this.transport !== null) return this.transport;
    const host = notionApiHost(this.config);
    const token = notionToken(this.config);
    this.transport = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
      },
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
    const message = error instanceof Error ? error.message : "Notion could not be reached.";
    return new ConnectionError(redactSecret(message, token), PROVIDER, host);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const token = notionToken(this.config);
    const host = notionApiHost(this.config);
    const transport = this.ensureTransport();
    const url = endpointUrl(httpOrigin("https", host, 443), path);
    let response: { status: number; text: string };
    try {
      response = await transport.request({
        method: "POST",
        url,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, token, host);
    }
    if (response.status === 401) throw new AuthenticationError("Notion refused the integration token.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("Notion refused this integration token.", PROVIDER);
    if (response.status === 429)
      throw new QueryError("Notion is limiting requests. Wait and run the statement again.", PROVIDER);
    if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    let parsed: unknown = {};
    if (response.text !== "") {
      try {
        parsed = JSON.parse(response.text) as unknown;
      } catch {
        throw new QueryError("Notion's answer was not JSON.", PROVIDER);
      }
    }
    const message = notionMessage(parsed);
    if (response.status >= 400) {
      throw new QueryError(redactSecret(message ?? "Notion refused the query.", token), PROVIDER);
    }
    if (message !== undefined && isRecord(parsed) && parsed.object === "error") {
      throw new QueryError(redactSecret(message, token), PROVIDER);
    }
    return parsed;
  }

  private async loadSources(): Promise<NotionSource[]> {
    const found: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        filter: { property: "object", value: "data_source" },
        page_size: PAGE_SIZE,
      };
      if (cursor !== undefined) body.start_cursor = cursor;
      const page = await this.post("/v1/search", body);
      if (!isRecord(page) || !Array.isArray(page.results)) throw new QueryError(BAD_ANSWER, PROVIDER);
      found.push(...page.results);
      if (page.has_more !== true || typeof page.next_cursor !== "string" || page.next_cursor === "") break;
      if (found.length >= NOTION_ROW_CAP) break;
      cursor = page.next_cursor;
    }
    return readSources(found);
  }

  private async readRows(
    source: NotionSource,
    filter: Record<string, unknown> | null,
    sorts: readonly Record<string, unknown>[],
    statement: NotionStatement,
  ): Promise<{ rows: Record<string, unknown>[]; warnings: QueryWarning[] }> {
    const offset = statement.kind === "select" ? statement.offset : 0;
    const requested = statement.kind === "select" && statement.limit !== null ? statement.limit : NOTION_ROW_CAP;
    const warnings: QueryWarning[] = [];
    if (offset >= NOTION_ROW_CAP) {
      warnings.push({ message: OFFSET_WARNING });
      return { rows: [], warnings };
    }
    const want = Math.min(NOTION_ROW_CAP, offset + requested);
    const capped = statement.kind === "select" && statement.limit !== null && statement.limit > NOTION_ROW_CAP;
    const rows: Record<string, unknown>[] = [];
    let seen = 0;
    let cursor: string | undefined;
    let more = false;
    while (seen < want) {
      const body: Record<string, unknown> = { page_size: Math.min(PAGE_SIZE, want - seen) };
      if (filter !== null) body.filter = filter;
      if (sorts.length > 0) body.sorts = sorts;
      if (cursor !== undefined) body.start_cursor = cursor;
      const page = await this.post(`/v1/data_sources/${encodeURIComponent(source.id)}/query`, body);
      if (!isRecord(page) || !Array.isArray(page.results)) throw new QueryError(BAD_ANSWER, PROVIDER);
      seen += page.results.length;
      for (const item of page.results) {
        if (isRecord(item) && item.object === "page") rows.push(item);
      }
      more = page.has_more === true && typeof page.next_cursor === "string" && page.next_cursor !== "";
      if (!more || page.results.length === 0) break;
      cursor = page.next_cursor as string;
    }
    if (capped || (more && want === NOTION_ROW_CAP)) warnings.push({ message: ROW_CAP_WARNING });
    return { rows: rows.slice(offset, want), warnings };
  }
}
