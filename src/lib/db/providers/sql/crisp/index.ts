/**
 * Crisp provider.
 *
 * Crisp (gocrisp.com) is a messaging API, not a SQL server. The editor runs a
 * small SQL subset (`translate.ts`): SELECT and COUNT(*) against one listed
 * resource on the REST API. Each statement is one GET. Nothing is copied into
 * another database, and a write is refused before a request.
 *
 * The website token identifier and key are sent only to api.crisp.chat, as HTTP
 * Basic authentication, over TLS, on the shared HTTP transport. That path does
 * not use global fetch, so a proxy variable cannot carry the secret. A redirect
 * is not followed. The tier header is `website`.
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
import type { QueryWarning } from "@/lib/types";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  TransportError,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT, pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { CRISP_RESOURCES, type CrispResource, type CrispStatement, translateCrispSql } from "./translate";

const PROVIDER = "crisp" as const;
const MAX_SOCKETS = 4;
const CONTAINER_NAME = "workspace";
const HOST_REQUIRED = "The API host must be api.crisp.chat. The token is sent only there.";
const IDENTIFIER_REQUIRED = "The token identifier is required.";
const KEY_REQUIRED = "The token key is required.";
const WEBSITE_REQUIRED = "The workspace id is required.";
const WEBSITE_UUID = "The workspace id must be a UUID.";
const CREDENTIAL_LINE = "Crisp credentials must be a single line of printable text.";
const IDENTIFIER_COLON = "The token identifier must not contain a colon.";
const REDIRECT_REFUSED = "Crisp answered with a redirect, which Studio does not follow.";
const BODY_TOO_LARGE = "Crisp's answer was larger than 2 MB and was not read.";
const PARAMS_REFUSED = "Write the value in the statement. Crisp does not bind parameters.";
const NOT_CONNECTED = "Not connected to Crisp.";
const PAGE_WARNING = "Crisp returned this page only. Raise OFFSET for the next page.";
const SLOW = "Crisp asked the connection to slow down.";
const NOT_JSON = "Crisp returned an answer that was not JSON.";
const NOT_LIST = "Crisp returned an answer that was not a list.";
const NOT_OBJECT = "Crisp returned an answer that was not a JSON object.";
const REFUSED = "Crisp refused the request";
const REASON = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Workspace", labelPlural: "Workspaces" },
] as const);

const OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
] as const);

const CONTAINER_PATH: ContainerPathShapeEngine = {
  code: PROVIDER,
  label: "A Crisp workspace",
  shapeNames: "label",
};
const OBJECT_PATH: ObjectPathShapeEngine = {
  code: PROVIDER,
  label: "A Crisp workspace",
  attachedSegment: "required",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credential(value: string | undefined, empty: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(empty, PROVIDER);
  if (text.length > 200 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/** The REST API host. Empty uses production. The token is sent only there. */
export function crispHost(config: Pick<DatabaseConnection, "host">): string {
  const host = pinnedApiHost(config.host, "crisp.chat", "api.crisp.chat", PROVIDER);
  if (host !== "api.crisp.chat") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  return host;
}

/** The website token identifier, from the user field. */
export function crispTokenIdentifier(config: Pick<DatabaseConnection, "user">): string {
  const identifier = credential(config.user, IDENTIFIER_REQUIRED);
  if (identifier.includes(":")) throw new DatabaseConfigError(IDENTIFIER_COLON, PROVIDER);
  return identifier;
}

/** The website token key, from the password field. */
export function crispTokenKey(config: Pick<DatabaseConnection, "password">): string {
  return credential(config.password, KEY_REQUIRED);
}

/** The workspace id, a UUID, from the database field. */
export function crispWebsiteId(config: Pick<DatabaseConnection, "database">): string {
  const text = config.database?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(WEBSITE_REQUIRED, PROVIDER);
  if (!UUID.test(text)) throw new DatabaseConfigError(WEBSITE_UUID, PROVIDER);
  return text.toLowerCase();
}

/** `Authorization` for the REST API. The value is HTTP Basic, and the tier is `website`. */
export function crispAuthorization(config: Pick<DatabaseConnection, "user" | "password">): string {
  const identifier = crispTokenIdentifier(config);
  const key = crispTokenKey(config);
  return `Basic ${Buffer.from(`${identifier}:${key}`, "utf8").toString("base64")}`;
}

/** Crisp connection. The website token reads conversations, people and operators. */
export class CrispProvider extends SQLBaseProvider {
  private ready = false;
  private api: NodeTransport | null = null;

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
    crispHost(this.config);
    crispAuthorization(this.config);
    crispWebsiteId(this.config);
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
      await this.get(`/v1/website/${crispWebsiteId(this.config)}`, {}, "connect");
    } catch (error) {
      this.closeTransport();
      throw error;
    }
    this.ready = true;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.closeTransport();
    this.ready = false;
    this.setConnected(false);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new QueryError(PARAMS_REFUSED, PROVIDER, sql);
    this.requireReady();
    const started = Date.now();
    const statement = translateCrispSql(sql);
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
    return { table: { count: CRISP_RESOURCES.length } };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireReady();
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH);
    return CRISP_RESOURCES.map((entry) => ({ path: [...container, entry.name], name: entry.name, kind }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    this.requireReady();
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const name = path[path.length - 1] ?? "";
    const found = CRISP_RESOURCES.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new QueryError("Crisp has no table with that name.", PROVIDER);
    return {
      path,
      columns: found.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: true,
        isPrimary: false,
      })),
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Crisp bulk column read limit must be a positive whole number, received ${limit}`,
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
    return Promise.reject(new QueryError("Crisp has no maintenance operation for Studio to run.", PROVIDER));
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.requireReady();
    return {
      version: "Crisp REST API V1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: CRISP_RESOURCES.length,
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
    if (spec === undefined) throw new QueryError(`Crisp declares no object kind "${kind}"`, PROVIDER);
    return spec;
  }

  private async run(
    statement: CrispStatement,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    if (statement.kind === "count") return this.count(statement);
    if (statement.resource.paging.mode === "once") return this.once(statement);
    return this.page(statement);
  }

  private async page(
    statement: Extract<CrispStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const page = statement.offset / statement.limit + 1;
    const body = await this.get(
      pathOf(statement.resource, crispWebsiteId(this.config), page),
      queryOf(statement),
      "query",
    );
    const rows = listedRows(body).map((row) => project(mapRow(statement.resource, row), fields));
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length));
  }

  private async once(
    statement: Extract<CrispStatement, { kind: "list" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings">> {
    const fields = fieldsOf(statement);
    const listed = listedRows(
      await this.get(pathOf(statement.resource, crispWebsiteId(this.config), 1), {}, "query"),
    ).map((row) => mapRow(statement.resource, row));
    const slice = listed.slice(statement.offset, statement.offset + statement.limit);
    const rows = slice.map((row) => project(row, fields));
    const more = listed.length > statement.offset + statement.limit;
    return withWarnings({ rows, fields, rowCount: rows.length }, pageWarnings(statement, rows.length, more));
  }

  private async count(
    statement: Extract<CrispStatement, { kind: "count" }>,
  ): Promise<Pick<QueryResult, "rows" | "fields" | "rowCount">> {
    const listed = listedRows(await this.get(pathOf(statement.resource, crispWebsiteId(this.config), 1), {}, "query"));
    return { rows: [{ [statement.alias]: listed.length }], fields: [statement.alias], rowCount: 1 };
  }

  private async get(path: string, query: Record<string, string>, during: "connect" | "query"): Promise<unknown> {
    const header = crispAuthorization(this.config);
    const host = crispHost(this.config);
    const secret = crispTokenKey(this.config);
    const identifier = crispTokenIdentifier(this.config);
    const url = endpointUrl(httpOrigin("https", host, 443), path, new URLSearchParams(query));
    let response: { status: number; text: string };
    try {
      response = await this.transport(header).request({
        method: "GET",
        url,
        signal: AbortSignal.timeout(this.queryTimeout),
        maxResponseBytes: API_ANSWER_LIMIT,
      });
    } catch (error) {
      throw this.wireFailure(error, secret, identifier, host, during);
    }
    return this.read(response, secret, identifier, during);
  }

  private read(
    response: { status: number; text: string },
    secret: string,
    identifier: string,
    during: "connect" | "query",
  ): unknown {
    const asQuery = during === "query";
    if (response.status >= 300 && response.status < 400) {
      throw asQuery ? new QueryError(REDIRECT_REFUSED, PROVIDER) : new ConnectionError(REDIRECT_REFUSED, PROVIDER);
    }
    if (response.text.length > API_ANSWER_LIMIT) throw new QueryError(BODY_TOO_LARGE, PROVIDER);
    if (response.status === 401) throw new AuthenticationError("Crisp rejected the token.", PROVIDER);
    if (response.status === 403) throw new PermissionDeniedError("Crisp refused this request.", PROVIDER);
    if (response.status === 429) throw asQuery ? new QueryError(SLOW, PROVIDER) : new ConnectionError(SLOW, PROVIDER);
    if (response.status < 200 || response.status >= 300) {
      const message = redactSecret(response.text, secret, identifier);
      throw asQuery ? new QueryError(message, PROVIDER) : new ConnectionError(message, PROVIDER);
    }
    if (response.text === "")
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    let body: unknown;
    try {
      body = JSON.parse(response.text) as unknown;
    } catch {
      throw asQuery ? new QueryError(NOT_JSON, PROVIDER) : new ConnectionError(NOT_JSON, PROVIDER);
    }
    if (isRecord(body) && body.error === true) {
      const message = refusal(body.reason);
      throw asQuery ? new QueryError(message, PROVIDER) : new ConnectionError(message, PROVIDER);
    }
    return body;
  }

  private transport(header: string): NodeTransport {
    if (this.api !== null) return this.api;
    const host = crispHost(this.config);
    this.api = this.createTransport({
      origin: httpOrigin("https", host, 443),
      tls: { rejectUnauthorized: true, identity: host },
      maxSockets: MAX_SOCKETS,
      headers: {
        Accept: "application/json",
        authorization: header,
        "user-agent": "KnowSQL",
        "x-crisp-tier": "website",
      },
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
    return this.api;
  }

  private closeTransport(): void {
    this.api?.close();
    this.api = null;
  }

  private wireFailure(
    error: unknown,
    secret: string,
    identifier: string,
    host: string,
    during: "connect" | "query",
  ): Error {
    if (error instanceof TransportError) {
      if (error.kind === "redirect") {
        return during === "query"
          ? new QueryError(REDIRECT_REFUSED, PROVIDER)
          : new ConnectionError(REDIRECT_REFUSED, PROVIDER, host);
      }
      if (error.kind === "too-large") return new QueryError(BODY_TOO_LARGE, PROVIDER);
      return new ConnectionError(redactSecret(error.message, secret, identifier), PROVIDER, host);
    }
    if (error instanceof DatabaseConfigError) return error;
    const message = error instanceof Error ? error.message : "Crisp could not be reached.";
    return new ConnectionError(redactSecret(message, secret, identifier), PROVIDER, host);
  }
}

function pathOf(resource: CrispResource, websiteId: string, page: number): string {
  if (resource.name === "Conversation") return `/v1/website/${websiteId}/conversations/${page}`;
  if (resource.name === "People") return `/v1/website/${websiteId}/people/profiles/${page}`;
  return `/v1/website/${websiteId}/operators/list`;
}

function queryOf(statement: Extract<CrispStatement, { kind: "list" }>): Record<string, string> {
  const query: Record<string, string> = { per_page: String(statement.limit) };
  for (const filter of statement.filters) query[filter.param] = filter.value;
  if (statement.resource.name === "Conversation" && query.search_query !== undefined) query.search_type = "text";
  return query;
}

function fieldsOf(statement: Extract<CrispStatement, { kind: "list" }>): string[] {
  return uniqueFieldNames(
    statement.columns === null ? statement.resource.columns.map((column) => column.name) : [...statement.columns],
  );
}

function listedRows(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body)) throw new QueryError(NOT_OBJECT, PROVIDER);
  const items = body.data;
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new QueryError(NOT_LIST, PROVIDER);
  return items.filter(isRecord);
}

function mapRow(resource: CrispResource, row: Record<string, unknown>): Record<string, unknown> {
  if (resource.name === "People") return peopleRow(row);
  if (resource.name === "Operator") return operatorRow(row);
  return conversationRow(row);
}

function withWarnings(
  result: Pick<QueryResult, "rows" | "fields" | "rowCount">,
  warnings: QueryWarning[],
): Pick<QueryResult, "rows" | "fields" | "rowCount" | "warnings"> {
  return warnings.length === 0 ? result : { ...result, warnings };
}

function pageWarnings(
  statement: Extract<CrispStatement, { kind: "list" }>,
  rows: number,
  more = false,
): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  if (statement.capped) {
    warnings.push({
      message: `Crisp returns at most ${statement.limit} rows in one page. This query asked for more, so the page is ${statement.limit}.`,
      severity: "WARNING",
    });
  }
  if (rows === statement.limit || more) warnings.push({ message: PAGE_WARNING, severity: "WARNING" });
  return warnings;
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) projected[field] = row[field] ?? null;
  return projected;
}

function refusal(reason: unknown): string {
  return typeof reason === "string" && REASON.test(reason) ? `${REFUSED} (${reason}).` : `${REFUSED}.`;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1e11) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return asText(value);
}

function joined(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((item): item is string => typeof item === "string");
  return parts.length === 0 ? null : parts.join(", ");
}

function conversationRow(row: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(row.meta) ? row.meta : null;
  const device = meta !== null && isRecord(meta.device) ? meta.device : null;
  const geo = device !== null && isRecord(device.geolocation) ? device.geolocation : null;
  const assigned = isRecord(row.assigned) ? row.assigned : null;
  const unread = isRecord(row.unread) ? row.unread : null;
  return {
    SessionId: asText(row.session_id),
    State: asText(row.state),
    Availability: asText(row.availability),
    Nickname: asText(meta?.nickname),
    Email: asText(meta?.email),
    Country: asText(geo?.country),
    LastMessage: asText(row.last_message),
    Topic: asText(row.topic),
    AssignedUserId: asText(assigned?.user_id),
    PeopleId: asText(row.people_id),
    Unread: asNum(unread?.operator),
    IsBlocked: asText(row.is_blocked),
    CreatedAt: asTime(row.created_at),
    UpdatedAt: asTime(row.updated_at),
  };
}

function peopleRow(row: Record<string, unknown>): Record<string, unknown> {
  const person = isRecord(row.person) ? row.person : null;
  const company = isRecord(row.company) ? row.company : null;
  return {
    PeopleId: asText(row.people_id),
    Email: asText(row.email),
    Nickname: asText(person?.nickname),
    Phone: asText(person?.phone),
    Company: asText(company?.name),
    Domain: asText(company?.domain),
    Segments: joined(row.segments),
    Score: asNum(row.score),
    CreatedAt: asTime(row.created_at),
    UpdatedAt: asTime(row.updated_at),
  };
}

function operatorRow(row: Record<string, unknown>): Record<string, unknown> {
  const details = isRecord(row.details) ? row.details : null;
  return {
    UserId: asText(details?.user_id),
    Email: asText(details?.email),
    FirstName: asText(details?.first_name),
    LastName: asText(details?.last_name),
    Role: asText(details?.role),
    Availability: asText(details?.availability),
    Type: asText(row.type),
  };
}
