/**
 * One OpenSearch or Elasticsearch Dev Tools request, as the editor types it.
 *
 * The text is a method and a path, then one JSON object. SQL stays SQL: a statement
 * that does not open with that request line is left for the SQL plugin. A request
 * that changes or deletes documents is refused later, before anything is sent.
 */

export const DEV_TOOLS_BODY_MAX = 1_000_000;

const SEARCH_METHODS = ["GET", "POST", "PUT", "HEAD"] as const;

export type DevToolsMethod = (typeof SEARCH_METHODS)[number] | "DELETE";

export interface DevToolsRequest {
  readonly method: DevToolsMethod;
  readonly path: string;
  /** The JSON object, as written. Absent when the request has no body. */
  readonly body?: string;
}

export type DevToolsRead =
  | { kind: "sql" }
  | { kind: "request"; request: DevToolsRequest }
  | { kind: "invalid"; error: string };

const REQUEST_LINE = /^(GET|POST|PUT|HEAD)\s+(\S+)\s*$/i;
const DELETE_LINE = /^DELETE\s+(\S*\/\S+)\s*$/i;

const BODY_ERROR =
  "The request body must be one JSON object, and one request is sent at a time. The query was not sent.";
const PATH_ERROR = "A search request needs a path. The query was not sent.";
const LONG_ERROR = `The request body is over ${DEV_TOOLS_BODY_MAX} characters. The query was not sent.`;

function bodyText(lines: readonly string[], start: number): string {
  let index = start;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (line !== "" && !line.startsWith("#") && !line.startsWith("//")) break;
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

/** A Dev Tools request, or SQL when the text is not one. Invalid JSON is not sent as SQL. */
export function readDevToolsRequest(text: string): DevToolsRead {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (line !== "" && !line.startsWith("#") && !line.startsWith("//")) break;
    index += 1;
  }
  const requestLine = lines[index]?.trim() ?? "";
  if (requestLine === "") return { kind: "sql" };

  const matched = REQUEST_LINE.exec(requestLine);
  const deleted = matched === null ? DELETE_LINE.exec(requestLine) : null;
  if (matched === null && deleted === null) {
    const first = requestLine.split(/\s+/)[0]?.toUpperCase() ?? "";
    if (first === "GET" || first === "POST" || first === "PUT" || first === "HEAD") {
      return { kind: "invalid", error: PATH_ERROR };
    }
    return { kind: "sql" };
  }

  const method = (matched?.[1] ?? "DELETE").toUpperCase() as DevToolsMethod;
  const path = matched?.[2] ?? deleted?.[1] ?? "";
  const body = bodyText(lines, index + 1);
  if (body === "") return { kind: "request", request: { method, path } };
  if (body.length > DEV_TOOLS_BODY_MAX) return { kind: "invalid", error: LONG_ERROR };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid", error: BODY_ERROR };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", error: BODY_ERROR };
  }
  return { kind: "request", request: { method, path, body } };
}

/**
 * A POST the cluster treats as a search. A GET that carries a body is sent as POST
 * on these paths, which is the same search.
 */
export const SEARCH_POST_SUFFIXES = [
  "/_search",
  "/_count",
  "/_validate/query",
  "/_field_caps",
  "/_rank_eval",
  "/_eql/search",
  "/_async_search",
  "/_explain",
] as const;

/** Only an admin may insert or update a document from the editor. */
export const DOCUMENT_WRITE_ADMIN = "Only an admin can insert or update a document. The query was not sent.";

export type DevToolsAction = "read" | "insert" | "update" | "refused";

function searchPost(pathname: string): boolean {
  if (SEARCH_POST_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) return true;
  return /\/_explain\/[^/]+$/.test(pathname);
}

function oneIndex(name: string): boolean {
  return name !== "" && !name.startsWith("_") && !name.startsWith(".") && !/[*?,]/.test(name);
}

/**
 * What a Dev Tools request does.
 *
 * A search is a read. One document insert (`_doc`, `_create`) or update (`_update`)
 * is a write the editor can send. Anything that deletes, or that changes more than
 * one document, is refused.
 */
export function devToolsAction(request: { method: string; path: string }): DevToolsAction {
  const method = request.method.toUpperCase();
  const bare = request.path.split("?")[0]?.split("#")[0] ?? "";
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  const path = withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
  const parts = path.split("/").slice(1);
  const index = parts[0] ?? "";
  const kind = parts[1] ?? "";
  const id = parts[2] ?? "";

  if (oneIndex(index) && (method === "PUT" || method === "POST")) {
    if (parts.length === 2 && kind === "_doc") return "insert";
    if (parts.length === 3 && id !== "" && (kind === "_doc" || kind === "_create")) return "insert";
    if (parts.length === 3 && id !== "" && kind === "_update" && method === "POST") return "update";
  }
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST" && searchPost(path)) return "read";
  return "refused";
}

/** Whether the editor text is one document insert or update. */
export function isDocumentWrite(text: string): boolean {
  const read = readDevToolsRequest(text);
  if (read.kind !== "request") return false;
  const action = devToolsAction(read.request);
  return action === "insert" || action === "update";
}

/**
 * Why this text is refused for `role`, or undefined when it may be sent.
 *
 * An admin's insert or update is sent. Every other role is refused before a
 * provider opens. A search, and text that is not a Dev Tools request, is undefined.
 */
export function documentWriteRefusal(texts: readonly string[], role: string): string | undefined {
  if (role === "admin") return undefined;
  for (const text of texts) {
    if (isDocumentWrite(text)) return DOCUMENT_WRITE_ADMIN;
  }
  return undefined;
}
