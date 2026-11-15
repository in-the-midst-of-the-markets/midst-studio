/**
 * The Databricks SQL session.
 *
 * Studio talks to a SQL warehouse through the statement execution API
 * (`POST /api/2.0/sql/statements`) on the workspace host, over the shared node
 * transport. The access token is a bearer header. Results are read inline as
 * `JSON_ARRAY`. A result the API will only hand out as an external link is
 * refused. No Databricks client library is loaded. Tests pass their own HTTP.
 */
import { endpointUrl, httpOrigin, type HttpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, nodeTlsMaterial, type NodeTransport } from "@/lib/db/http/node-transport";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

const PROVIDER = "databricks" as const;
const STATEMENT_PATH = "/api/2.0/sql/statements";
const WAIT_TIMEOUT = "30s";
const MAX_POLLS = 20;
const POLL_MS = 500;
const MAX_CHUNKS = 8;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 50_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WAREHOUSE_ID = /^[A-Za-z0-9-]{1,64}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{1,1000}$/;

/** One result, rows in column order so a repeated name can be kept apart. */
export interface DatabricksQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount: number | null;
}

/** The dial the provider holds. Tests pass their own; production opens the statement API. */
export interface DatabricksSession {
  query(sql: string): Promise<DatabricksQueryResult>;
  end(): Promise<void>;
}

export type DatabricksSessionFactory = (config: DatabaseConnection) => Promise<DatabricksSession>;

/** One HTTPS call. Production is the node transport; tests pass a script. */
export interface DatabricksHttp {
  request(input: { method: "GET" | "POST"; path: string; body?: string }): Promise<{ status: number; text: string }>;
  close(): void;
}

export type DatabricksSleeper = (ms: number) => Promise<void>;

/** The pause between polls. A test that never waits calls this with `0`. */
export function waitForPoll(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The workspace host and port. A pasted `https://` address keeps the host; anything else is refused. */
export function databricksAddress(host: string | undefined, port: number | undefined): { host: string; port: number } {
  const raw = host?.trim() ?? "";
  if (raw === "" || /[\s\u0000-\u001f]/.test(raw)) {
    throw new DatabaseConfigError("Databricks SQL needs a workspace host.", PROVIDER);
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DatabaseConfigError("Databricks SQL needs a workspace host.", PROVIDER);
  }
  if (url.protocol !== "https:") throw new DatabaseConfigError("Databricks SQL speaks HTTPS only.", PROVIDER);
  if (url.username !== "" || url.password !== "") {
    throw new DatabaseConfigError("Put the access token in the token field, not in the host.", PROVIDER);
  }
  if (url.hostname === "") throw new DatabaseConfigError("Databricks SQL needs a workspace host.", PROVIDER);
  const fromUrl = url.port === "" ? 443 : Number(url.port);
  const chosen = port !== undefined && port !== 0 ? port : fromUrl;
  return { host: url.hostname, port: chosen };
}

function accessToken(password: string | undefined): string {
  const token = password?.trim() ?? "";
  if (token === "") throw new DatabaseConfigError("Databricks SQL needs an access token.", PROVIDER);
  if (!TOKEN.test(token)) {
    throw new DatabaseConfigError("The access token has a character the request cannot send.", PROVIDER);
  }
  return token;
}

function warehouseId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (!WAREHOUSE_ID.test(id)) throw new DatabaseConfigError("Databricks SQL needs a SQL warehouse id.", PROVIDER);
  return id;
}

function optionalName(value: string | undefined, label: string): string | undefined {
  const name = value?.trim() ?? "";
  if (name === "") return undefined;
  if (!NAME.test(name)) {
    throw new DatabaseConfigError(`The Databricks SQL ${label} has a character the statement will not send.`, PROVIDER);
  }
  return name;
}

/** The JSON body of one statement. Catalog and schema are sent only when the connection names them. */
export function statementRequestBody(config: DatabaseConnection, sql: string): string {
  const body: Record<string, string> = {
    warehouse_id: warehouseId(config.warehouse),
    statement: sql,
    wait_timeout: WAIT_TIMEOUT,
    disposition: "INLINE",
    format: "JSON_ARRAY",
  };
  const catalog = optionalName(config.database, "catalog");
  const schema = optionalName(config.schema, "schema");
  if (catalog !== undefined) body.catalog = catalog;
  if (schema !== undefined) body.schema = schema;
  return JSON.stringify(body);
}

function plain(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorText(payload: Record<string, unknown> | null): string {
  const status = plain(payload?.status);
  const nested = plain(status?.error);
  const fromStatus = nested?.message;
  if (typeof fromStatus === "string" && fromStatus.trim() !== "") return fromStatus.trim().slice(0, 300);
  const top = payload?.message;
  if (typeof top === "string" && top.trim() !== "") return top.trim().slice(0, 300);
  return "";
}

function httpFailure(status: number, payload: Record<string, unknown> | null, sql: string): Error {
  const message = errorText(payload) || `Databricks SQL returned HTTP ${status}.`;
  if (status === 401) return new AuthenticationError(message, PROVIDER);
  if (status === 403) return new PermissionDeniedError(message, PROVIDER, sql);
  return new QueryError(message, PROVIDER, sql);
}

/** One JSON_ARRAY cell. A struct is kept as JSON text, cut at 4000 characters. */
export function databricksCell(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 4000 ? text.slice(0, 4000) : text;
  }
  return null;
}

function rowsOf(payload: Record<string, unknown>): unknown[][] {
  const result = plain(payload.result);
  const data = result?.data_array ?? payload.data_array;
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data))
    throw new QueryError("Databricks SQL returned a result that is not a list of rows.", PROVIDER);
  return data.map((row) => {
    if (!Array.isArray(row)) throw new QueryError("Databricks SQL returned a row that is not a list.", PROVIDER);
    return row.map((value) => databricksCell(value));
  });
}

function fieldsOf(payload: Record<string, unknown>): { name: string }[] {
  const manifest = plain(payload.manifest);
  const schema = plain(manifest?.schema);
  const columns = schema?.columns;
  if (!Array.isArray(columns)) return [];
  // Array order is the row order. `position` is the API's index into that row, and sorting the
  // names without the cells would pair a value with the wrong name.
  return columns.map((column, index) => {
    const record = plain(column);
    const name = record?.name;
    return { name: typeof name === "string" && name !== "" ? name : `column_${index}` };
  });
}

function chunkCountOf(payload: Record<string, unknown>): number {
  const manifest = plain(payload.manifest);
  const count = manifest?.total_chunk_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return 1;
  return count;
}

function rowCountOf(payload: Record<string, unknown>, fallback: number): number | null {
  const manifest = plain(payload.manifest);
  const count = manifest?.total_row_count;
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  return fallback;
}

function statementIdOf(payload: Record<string, unknown>): string {
  const id = payload.statement_id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new QueryError("Databricks SQL returned a statement id Studio will not request.", PROVIDER);
  }
  return id;
}

function refuseIncomplete(payload: Record<string, unknown>, sql: string): void {
  const manifest = plain(payload.manifest);
  if (manifest?.truncated === true) {
    throw new QueryError("This result is larger than an inline page. Add a LIMIT and run it again.", PROVIDER, sql);
  }
  const result = plain(payload.result);
  const links = result?.external_links;
  if (Array.isArray(links) && links.length > 0) {
    throw new QueryError("This result is larger than an inline page. Add a LIMIT and run it again.", PROVIDER, sql);
  }
}

function stateOf(payload: Record<string, unknown>): string | null {
  const status = plain(payload.status);
  const state = status?.state;
  return typeof state === "string" ? state.toUpperCase() : null;
}

function parseBody(status: number, text: string, sql: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QueryError(`Databricks SQL returned HTTP ${status}.`, PROVIDER, sql);
  }
  const payload = plain(parsed);
  if (payload === null) throw new QueryError(`Databricks SQL returned HTTP ${status}.`, PROVIDER, sql);
  if (status !== 200) throw httpFailure(status, payload, sql);
  return payload;
}

/**
 * Run one statement to completion: the POST waits up to 30 seconds, then this polls,
 * then it reads inline chunks on the same host. An external link is refused.
 */
export async function runStatement(
  http: DatabricksHttp,
  config: DatabaseConnection,
  sql: string,
  sleep: DatabricksSleeper = waitForPoll,
): Promise<DatabricksQueryResult> {
  const opened = await http.request({ method: "POST", path: STATEMENT_PATH, body: statementRequestBody(config, sql) });
  let payload = parseBody(opened.status, opened.text, sql);
  let polls = 0;
  while (stateOf(payload) === "PENDING" || stateOf(payload) === "RUNNING") {
    if (polls >= MAX_POLLS) {
      throw new QueryError("The statement was still running after the wait.", PROVIDER, sql);
    }
    const id = statementIdOf(payload);
    // oxlint-disable-next-line no-await-in-loop -- one statement, polled on the one connection.
    await sleep(POLL_MS);
    polls += 1;
    // oxlint-disable-next-line no-await-in-loop -- the next poll is the same statement.
    const next = await http.request({ method: "GET", path: `${STATEMENT_PATH}/${id}` });
    payload = parseBody(next.status, next.text, sql);
  }
  const state = stateOf(payload);
  if (state === "FAILED" || state === "CANCELED" || state === "CLOSED") {
    throw new QueryError(errorText(payload) || `Databricks SQL ${state ?? "stopped"}.`, PROVIDER, sql);
  }
  if (state !== null && state !== "SUCCEEDED") {
    throw new QueryError(`Databricks SQL returned a status Studio does not read (${state}).`, PROVIDER, sql);
  }
  refuseIncomplete(payload, sql);
  const chunks = chunkCountOf(payload);
  if (chunks > MAX_CHUNKS) {
    throw new QueryError("This result is larger than an inline page. Add a LIMIT and run it again.", PROVIDER, sql);
  }
  const rows = rowsOf(payload);
  if (chunks > 1) {
    const id = statementIdOf(payload);
    for (let index = 1; index < chunks; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- chunks of one statement, in order, on the one connection.
      const chunk = await http.request({ method: "GET", path: `${STATEMENT_PATH}/${id}/result/chunks/${index}` });
      const page = parseBody(chunk.status, chunk.text, sql);
      refuseIncomplete(page, sql);
      rows.push(...rowsOf(page));
    }
  }
  return { rows, fields: fieldsOf(payload), rowCount: rowCountOf(payload, rows.length) };
}

/** The node transport for one workspace. The token is a connection header, as Snowflake's bearer is. */
export function databricksNodeTransport(config: DatabaseConnection): { origin: HttpOrigin; transport: NodeTransport } {
  const address = databricksAddress(config.host, config.port);
  const origin = httpOrigin("https", address.host, address.port);
  const token = accessToken(config.password);
  warehouseId(config.warehouse);
  optionalName(config.database, "catalog");
  optionalName(config.schema, "schema");
  const tls = nodeTlsMaterial(config.ssl ?? { mode: "verify-full" }, address.host);
  if (tls === null) throw new DatabaseConfigError("Databricks SQL speaks HTTPS only.", PROVIDER);
  const transport = createNodeTransport({
    origin,
    tls,
    maxSockets: 2,
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    refusesLinkLocal: true,
    refusesUpgrade: true,
  });
  return { origin, transport };
}

export function databricksHttp(transport: NodeTransport, origin: HttpOrigin): DatabricksHttp {
  return {
    async request(input) {
      const response = await transport.request({
        method: input.method,
        url: endpointUrl(origin, input.path),
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: AbortSignal.timeout(REQUEST_MS),
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      return { status: response.status, text: response.text };
    },
    close() {
      transport.close();
    },
  };
}

function fromNode(config: DatabaseConnection): DatabricksHttp {
  const { origin, transport } = databricksNodeTransport(config);
  return databricksHttp(transport, origin);
}

/** Production opens the node transport. A test passes the HTTP it wants the statement to use. */
export async function openDatabricksSession(
  config: DatabaseConnection,
  http?: DatabricksHttp,
): Promise<DatabricksSession> {
  const opened = http ?? fromNode(config);
  return {
    query: (sql) => runStatement(opened, config, sql),
    async end() {
      opened.close();
    },
  };
}
