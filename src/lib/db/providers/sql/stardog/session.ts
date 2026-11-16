/**
 * The Stardog session.
 *
 * Studio talks to one database through the SPARQL protocol
 * (`POST /{database}/query`) on the server host, over the shared node transport.
 * The user and password are a Basic header. Results are SPARQL JSON. No Stardog
 * client library is loaded. Tests pass their own HTTP.
 */
import { endpointUrl, httpOrigin, plaintextSecretRefusal, type HttpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, nodeTlsMaterial, type NodeTransport } from "@/lib/db/http/node-transport";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

const PROVIDER = "stardog" as const;
const DEFAULT_PORT = 5820;
const REQUEST_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DATABASE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** One SPARQL JSON answer, rows keyed by variable. `ask` is set only for an ASK. */
export interface StardogAnswer {
  readonly fields: readonly string[];
  readonly rows: Record<string, unknown>[];
  readonly ask: boolean | null;
}

/** The dial the provider holds. Tests pass their own; production opens the query API. */
export interface StardogSession {
  query(sparql: string): Promise<StardogAnswer>;
  end(): Promise<void>;
}

/** One HTTP call. Production is the node transport; tests pass a script. */
export interface StardogHttp {
  request(input: {
    method: "GET" | "POST";
    path: string;
    form?: Readonly<Record<string, string>>;
  }): Promise<{ status: number; text: string }>;
  close(): void;
}

/** The database name the path will carry. Anything else is refused before a request. */
export function stardogDatabase(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!DATABASE_NAME.test(name)) {
    throw new DatabaseConfigError(
      "Stardog needs a database name of letters, digits, hyphens or underscores.",
      PROVIDER,
    );
  }
  return name;
}

/** The host, port and scheme. A pasted http:// or https:// address keeps that scheme. */
export function stardogAddress(config: DatabaseConnection): {
  origin: HttpOrigin;
  tls: ReturnType<typeof nodeTlsMaterial>;
} {
  const raw = config.host?.trim() ?? "";
  if (raw === "") throw new DatabaseConfigError("Stardog needs a host.", PROVIDER);
  const pasted = /^https?:\/\//i.test(raw) ? raw : "";
  let host = raw;
  let port = config.port;
  let scheme: "http" | "https" | undefined;
  if (pasted !== "") {
    let url: URL;
    try {
      url = new URL(pasted);
    } catch {
      throw new DatabaseConfigError("Stardog needs a host.", PROVIDER);
    }
    if (url.username !== "" || url.password !== "") {
      throw new DatabaseConfigError("Put the user and password in their fields, not in the host.", PROVIDER);
    }
    host = url.hostname;
    scheme = url.protocol === "https:" ? "https" : "http";
    if (url.port !== "") port = Number(url.port);
  }
  const tls = nodeTlsMaterial(scheme === "http" ? { mode: "disable" } : (config.ssl ?? { mode: "verify-full" }), host);
  const spoken = tls === null ? "http" : "https";
  if (scheme === "https" && tls === null) {
    throw new DatabaseConfigError("An https:// host cannot use SSL mode disable.", PROVIDER);
  }
  const origin = httpOrigin(spoken, host, port ?? DEFAULT_PORT);
  const refusal = plaintextSecretRefusal({
    host: origin.host,
    tunnelled: config.sshTunnel?.enabled === true,
    tls: tls !== null,
    hasSecret: (config.password ?? "") !== "",
  });
  if (refusal !== undefined && config.allowInsecureAuth !== true) {
    throw new DatabaseConfigError(refusal, PROVIDER);
  }
  return { origin, tls };
}

function credential(config: DatabaseConnection): string {
  const user = config.user?.trim() ?? "";
  const password = config.password ?? "";
  if (user === "") throw new DatabaseConfigError("Stardog needs a user.", PROVIDER);
  if (/[\r\n:]/.test(user) || /[\r\n]/.test(password)) {
    throw new DatabaseConfigError("The user or password has a character the request cannot send.", PROVIDER);
  }
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/** The node transport for one server. The password is a connection header. */
export function stardogNodeTransport(config: DatabaseConnection): { origin: HttpOrigin; transport: NodeTransport } {
  const { origin, tls } = stardogAddress(config);
  stardogDatabase(config.database);
  const transport = createNodeTransport({
    origin,
    tls,
    maxSockets: 2,
    headers: { authorization: credential(config), accept: "application/sparql-results+json" },
    refusesLinkLocal: true,
    refusesUpgrade: true,
  });
  return { origin, transport };
}

export function stardogHttp(transport: NodeTransport, origin: HttpOrigin): StardogHttp {
  return {
    async request(input) {
      const response = await transport.request({
        method: input.method,
        url: endpointUrl(origin, input.path),
        ...(input.form === undefined ? {} : { form: input.form }),
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

function messageOf(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return body.message;
    }
  } catch {
    return text.trim() === "" ? undefined : text.trim();
  }
  return undefined;
}

/** The SPARQL JSON body, or an error the status names. */
export function readStardogAnswer(status: number, text: string, sparql: string): StardogAnswer {
  if (status === 401)
    throw new AuthenticationError(messageOf(text) ?? "Stardog refused the user or password.", PROVIDER);
  if (status === 403)
    throw new PermissionDeniedError(messageOf(text) ?? "Stardog refused this query.", PROVIDER, sparql);
  if (status < 200 || status >= 300) {
    throw new QueryError((messageOf(text) ?? `Stardog answered ${status}.`).slice(0, 300), PROVIDER, sparql);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new QueryError("Stardog did not return JSON.", PROVIDER, sparql);
  }
  if (typeof body !== "object" || body === null) {
    throw new QueryError("Stardog did not return a result.", PROVIDER, sparql);
  }
  if ("boolean" in body) {
    if (typeof body.boolean !== "boolean")
      throw new QueryError("Stardog did not return an ASK result.", PROVIDER, sparql);
    return { fields: ["ask"], rows: [{ ask: body.boolean }], ask: body.boolean };
  }
  const head = "head" in body ? body.head : undefined;
  const vars =
    typeof head === "object" && head !== null && "vars" in head && Array.isArray(head.vars)
      ? head.vars.filter((name): name is string => typeof name === "string" && name !== "")
      : [];
  const results = "results" in body ? body.results : undefined;
  const bindings =
    typeof results === "object" && results !== null && "bindings" in results && Array.isArray(results.bindings)
      ? results.bindings
      : undefined;
  if (bindings === undefined) throw new QueryError("Stardog did not return rows.", PROVIDER, sparql);
  const rows = bindings.map((binding) => rowOf(binding, vars));
  return { fields: vars, rows, ask: null };
}

function rowOf(binding: unknown, vars: readonly string[]): Record<string, unknown> {
  const source = typeof binding === "object" && binding !== null ? (binding as Record<string, unknown>) : {};
  const row: Record<string, unknown> = {};
  for (const name of vars) row[name] = cellOf(source[name]);
  return row;
}

function cellOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("value" in value)) return null;
  const raw = value.value;
  if (typeof raw !== "string") return null;
  const datatype = "datatype" in value && typeof value.datatype === "string" ? value.datatype : "";
  if (/#(integer|int|decimal|double|float)$/.test(datatype)) {
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return raw.length > 4000 ? raw.slice(0, 4000) : raw;
}

function fromNode(config: DatabaseConnection): StardogHttp {
  const { origin, transport } = stardogNodeTransport(config);
  return stardogHttp(transport, origin);
}

/** Production opens the node transport. A test passes the HTTP it wants the query to use. */
export async function openStardogSession(config: DatabaseConnection, http?: StardogHttp): Promise<StardogSession> {
  const database = stardogDatabase(config.database);
  const opened = http ?? fromNode(config);
  const path = `/${encodeURIComponent(database)}/query`;
  return {
    async query(sparql) {
      const response = await opened.request({ method: "POST", path, form: { query: sparql } });
      return readStardogAnswer(response.status, response.text, sparql);
    },
    async end() {
      opened.close();
    },
  };
}
