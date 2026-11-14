/**
 * A custom API the user defined: a public HTTPS host, a secret sent only as a header,
 * and the GET paths that become tables. Nothing here opens a socket.
 */
import { DatabaseConfigError } from "@/lib/db/errors";

export const REST_CATALOG_LIMIT = 16_000;
export const REST_RESOURCE_CAP = 24;

export type RestAuth = "bearer" | "header" | "basic";

export interface RestResource {
  readonly name: string;
  readonly path: string;
  readonly rows: string;
}

export interface RestCatalog {
  readonly auth: RestAuth;
  readonly headerName: string;
  readonly resources: readonly RestResource[];
}

const HOST_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const RESOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const ROWS_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const HEADER_DENY = new Set([
  "authorization",
  "host",
  "cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
  "te",
  "trailer",
  "via",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The hostname a custom API may be saved with, or the reason it may not. */
export function restHostIssue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "Add the API hostname.";
  if (/^http:\/\//i.test(trimmed)) return "Use HTTPS. The secret is not sent over plain HTTP.";
  let host = trimmed.replace(/^https:\/\//i, "");
  if (host.endsWith("/")) host = host.slice(0, -1);
  host = host.toLowerCase();
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return "Use the API's hostname. An IP address is not accepted.";
  }
  if (/[/?#@\s\\]/.test(host) || host.includes("%")) {
    return "Use the hostname on its own, such as api.example.com.";
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  ) {
    return "That name is not a public API host.";
  }
  if (!HOST_LABEL.test(host)) return "Use the API's hostname, such as api.example.com.";
  return null;
}

/** The hostname `restHostIssue` accepted, with a leading https:// removed. */
export function restHost(raw: string): string {
  const issue = restHostIssue(raw);
  if (issue !== null) throw new DatabaseConfigError(issue, "customapi");
  let host = raw.trim().replace(/^https:\/\//i, "");
  if (host.endsWith("/")) host = host.slice(0, -1);
  return host.toLowerCase();
}

function resourceIssue(value: unknown, seen: Set<string>): string | null {
  if (!isRecord(value)) return "Each resource needs a name, a path, and a rows path.";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const rows = typeof value.rows === "string" ? value.rows.trim() : "";
  if (!RESOURCE_NAME.test(name)) return "Name a resource with letters, digits, and underscores.";
  if (seen.has(name.toLowerCase())) return "Use a different name for each resource.";
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\\")) {
    return "A resource path starts with / and has no query.";
  }
  const segments = path.slice(1).split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))
  ) {
    return "A resource path starts with / and has no query.";
  }
  if (rows !== "" && !ROWS_PATH.test(rows)) return "The rows path names one JSON field, such as data.";
  seen.add(name.toLowerCase());
  return null;
}

/** The catalog text a connection may store, or the reason it may not. The secret is not part of it. */
export function restCatalogIssue(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return "Add a resource and draw a line from the API to it.";
  if (raw.length > REST_CATALOG_LIMIT) return "This API's resource list is too long.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "This API's resource list could not be read.";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.resources)) return "This API's resource list could not be read.";
  if (parsed.auth !== "bearer" && parsed.auth !== "header" && parsed.auth !== "basic") {
    return "Choose bearer, a header, or basic authentication.";
  }
  const headerName = typeof parsed.headerName === "string" ? parsed.headerName.trim() : "";
  if (parsed.auth === "header") {
    if (!HEADER_NAME.test(headerName) || HEADER_DENY.has(headerName.toLowerCase())) {
      return "Name the header the secret is sent in.";
    }
  }
  if (parsed.resources.length < 1) return "Add a resource and draw a line from the API to it.";
  if (parsed.resources.length > REST_RESOURCE_CAP) return "One API can have at most 24 resources.";
  const seen = new Set<string>();
  for (const resource of parsed.resources) {
    const issue = resourceIssue(resource, seen);
    if (issue !== null) return issue;
  }
  return null;
}

/** The catalog `restCatalogIssue` accepted. */
export function readRestCatalog(raw: string | undefined): RestCatalog {
  const issue = restCatalogIssue(raw);
  if (issue !== null) throw new DatabaseConfigError(issue, "customapi");
  const parsed = JSON.parse(raw ?? "") as {
    auth: RestAuth;
    headerName?: string;
    resources: { name: string; path: string; rows: string }[];
  };
  const headerName = typeof parsed.headerName === "string" ? parsed.headerName.trim() : "";
  return {
    auth: parsed.auth,
    headerName: parsed.auth === "header" ? headerName : "X-API-Key",
    resources: parsed.resources.map((resource) => ({
      name: resource.name.trim(),
      path: resource.path.trim(),
      rows: resource.rows.trim(),
    })),
  };
}

const SECRET_ISSUE = "Add the secret. It is sent as a header, never in the URL.";

/** The secret a custom API sends, with no newline that could become a second header. */
export function restSecret(raw: string | undefined): string {
  const secret = raw?.trim() ?? "";
  if (secret.length < 8 || /[\r\n]/.test(secret)) throw new DatabaseConfigError(SECRET_ISSUE, "customapi");
  return secret;
}

/** The username basic authentication sends beside the secret. */
export function restBasicUser(raw: string | undefined): string {
  const user = raw?.trim() ?? "";
  if (user === "" || /[\r\n:]/.test(user)) {
    throw new DatabaseConfigError("Add the username for basic authentication.", "customapi");
  }
  return user;
}
