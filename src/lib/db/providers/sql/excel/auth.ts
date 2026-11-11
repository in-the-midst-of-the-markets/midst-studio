/**
 * Where a Microsoft Excel credential may be sent.
 *
 * A pasted access token is used as-is and sent only to graph.microsoft.com.
 * A client secret is exchanged only at login.microsoftonline.com. The secret is not sent to
 * Graph, and Studio does not follow a redirect on either call.
 */
import { AuthenticationError, DatabaseConfigError } from "@/lib/db/errors";
import { redactSecret } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/types";

const PROVIDER = "excel" as const;

export const EXCEL_GRAPH_HOST = "graph.microsoft.com";
export const EXCEL_TOKEN_HOST = "login.microsoftonline.com";
export const EXCEL_SCOPE = "https://graph.microsoft.com/.default";

const SECRET_REQUIRED = "A Microsoft Excel client secret or access token is required.";
const SECRET_LINE = "A Microsoft Excel client secret or access token must be a single line of printable text.";
const SECRET_SIZE = "A Microsoft Excel credential is larger than Studio will send.";
const PAIR_REQUIRED =
  "A client id and a tenant id are both required to exchange a client secret. Paste an access token alone to skip the exchange.";
const GUID_REQUIRED = "Write the client id and the tenant id as GUIDs.";
const PATH_REQUIRED = "A workbook path is required. The access token is sent only to graph.microsoft.com.";
const PATH_REFUSED =
  "The workbook path must be /drives/<drive id>/items/<item id>. The access token is sent only to graph.microsoft.com.";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKBOOK =
  /^\/drives\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/items\/([A-Za-z0-9!_-]{8,200})$/i;
const PRINTABLE = /^[\x21-\x7e]+$/;
const TOKEN_MAX = 8000;
const SECRET_MAX = 1024;

export interface ExcelAccessToken {
  readonly kind: "token";
  readonly token: string;
}

export interface ExcelClientSecret {
  readonly kind: "client";
  readonly clientId: string;
  readonly tenantId: string;
  readonly secret: string;
}

export type ExcelCredential = ExcelAccessToken | ExcelClientSecret;

export interface ExcelTokenGrant {
  readonly token: string;
  readonly expiresAt: number;
}

function printable(value: string, limit: number): boolean {
  return value.length >= 1 && value.length <= limit && PRINTABLE.test(value);
}

/** The password field: an access token, or a client secret when the client id and tenant id are both set. */
export function excelCredential(config: DatabaseConnection): ExcelCredential {
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

/**
 * The workbook Graph reads. A drive id and an item id, and nothing else.
 * The refusal does not repeat a rejected path.
 */
export function excelWorkbookPath(config: DatabaseConnection): string {
  const raw = config.schema?.trim() ?? "";
  if (raw === "") throw new DatabaseConfigError(PATH_REQUIRED, PROVIDER);
  const match = WORKBOOK.exec(raw);
  const driveId = match?.[1];
  const itemId = match?.[2];
  if (driveId === undefined || itemId === undefined) throw new DatabaseConfigError(PATH_REFUSED, PROVIDER);
  return `/drives/${driveId.toLowerCase()}/items/${itemId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a token response. The error does not include the secret or the access token. */
export function readExcelTokenGrant(
  status: number,
  text: string,
  now: number,
  secrets: readonly string[],
): ExcelTokenGrant {
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
    throw new AuthenticationError(`Excel token request failed: ${redactSecret(raw, ...secrets)}`, PROVIDER);
  }
  const ttl = typeof record.expires_in === "number" && record.expires_in > 60 ? record.expires_in - 60 : 0;
  return { token, expiresAt: now + ttl * 1000 };
}
