/**
 * Where a Dynamics credential may be sent.
 *
 * A pasted access token is used as-is and sent only to the organization's Dynamics 365 host.
 * A client secret is exchanged only at login.microsoftonline.com. The secret is not sent to
 * the organization host, and Studio does not follow a redirect on either call.
 */
import { AuthenticationError, DatabaseConfigError } from "@/lib/db/errors";
import { redactSecret } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/types";

const PROVIDER = "dynamics" as const;

export const DYNAMICS_TOKEN_HOST = "login.microsoftonline.com";
const HOST_REQUIRED = "An organization host is required. The access token is sent only to that Dynamics 365 host.";
const HOST_REFUSED =
  "The API host must be the organization's Dynamics 365 host, such as contoso.crm.dynamics.com. The access token is sent only there.";
const SECRET_REQUIRED = "A Dynamics client secret or access token is required.";
const SECRET_LINE = "A Dynamics client secret or access token must be a single line of printable text.";
const SECRET_SIZE = "A Dynamics credential is larger than Studio will send.";
const PAIR_REQUIRED =
  "A client id and a tenant id are both required to exchange a client secret. Paste an access token alone to skip the exchange.";
const GUID_REQUIRED = "Write the client id and the tenant id as GUIDs.";
const ORG_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.crm(?:[1-9]\d?)?\.dynamics\.com$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE = /^[\x21-\x7e]+$/;
const TOKEN_MAX = 8000;
const SECRET_MAX = 1024;

export interface DynamicsAccessToken {
  readonly kind: "token";
  readonly token: string;
}

export interface DynamicsClientSecret {
  readonly kind: "client";
  readonly clientId: string;
  readonly tenantId: string;
  readonly secret: string;
}

export type DynamicsCredential = DynamicsAccessToken | DynamicsClientSecret;

export interface DynamicsTokenGrant {
  readonly token: string;
  readonly expiresAt: number;
}

function printable(value: string, limit: number): boolean {
  return value.length >= 1 && value.length <= limit && PRINTABLE.test(value);
}

/** The organization host the access token is sent to. Anything else is refused, and the refusal does not repeat it. */
export function dynamicsOrgHost(config: DatabaseConnection): string {
  const trimmed = config.host?.trim() ?? "";
  if (trimmed === "") throw new DatabaseConfigError(HOST_REQUIRED, PROVIDER);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new DatabaseConfigError(HOST_REFUSED, PROVIDER);
  }
  const path = url.pathname === "/" || url.pathname === "" ? "" : url.pathname;
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || path !== "") {
    throw new DatabaseConfigError(HOST_REFUSED, PROVIDER);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!ORG_HOST.test(host)) throw new DatabaseConfigError(HOST_REFUSED, PROVIDER);
  return host;
}

/** The password field: an access token, or a client secret when the client id and tenant id are both set. */
export function dynamicsCredential(config: DatabaseConnection): DynamicsCredential {
  const clientId = config.user?.trim() ?? "";
  const tenantId = config.database?.trim() ?? "";
  const written = config.password?.trim() ?? "";
  const secret = clientId === "" && tenantId === "" ? written.replace(/^Bearer\s+/i, "") : written;
  if (secret === "") throw new DatabaseConfigError(SECRET_REQUIRED, PROVIDER);
  if ((clientId === "") !== (tenantId === "")) throw new DatabaseConfigError(PAIR_REQUIRED, PROVIDER);
  if (!printable(secret, clientId === "" ? TOKEN_MAX : SECRET_MAX)) {
    throw new DatabaseConfigError(secret.length > SECRET_MAX ? SECRET_SIZE : SECRET_LINE, PROVIDER);
  }
  if (clientId === "") return { kind: "token", token: secret };
  if (!GUID.test(clientId) || !GUID.test(tenantId)) throw new DatabaseConfigError(GUID_REQUIRED, PROVIDER);
  return { kind: "client", clientId: clientId.toLowerCase(), tenantId: tenantId.toLowerCase(), secret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a token response. The error does not include the secret or the access token. */
export function readDynamicsTokenGrant(
  status: number,
  text: string,
  now: number,
  secrets: readonly string[],
): DynamicsTokenGrant {
  let body: unknown = {};
  if (text !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = {};
    }
  }
  const record = isRecord(body) ? body : {};
  const token = record.access_token;
  const usable = typeof token === "string" && printable(token, TOKEN_MAX);
  if (status !== 200 || !usable) {
    const reason = record.error_description ?? record.error ?? `HTTP ${status}`;
    const raw = typeof reason === "string" ? reason : `HTTP ${status}`;
    throw new AuthenticationError(`Dynamics token request failed: ${redactSecret(raw, ...secrets)}`, PROVIDER);
  }
  const ttl = typeof record.expires_in === "number" && record.expires_in > 60 ? record.expires_in - 60 : 0;
  return { token, expiresAt: now + ttl * 1000 };
}
