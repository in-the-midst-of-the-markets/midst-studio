/**
 * Where a Google Sheets credential may be sent.
 *
 * A pasted access token is used as-is and sent only to sheets.googleapis.com.
 * A service-account key is signed here and exchanged only at oauth2.googleapis.com.
 * The private key is not sent to the Sheets API, and Studio does not follow a redirect
 * on either call.
 */
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError, DatabaseConfigError } from "@/lib/db/errors";
import { redactSecret } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/types";

const PROVIDER = "googlesheets" as const;

export const SHEETS_HOST = "sheets.googleapis.com";
export const SHEETS_TOKEN_HOST = "oauth2.googleapis.com";
export const SHEETS_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const KEY_REQUIRED = "A Google Sheets access token or service-account key is required.";
const KEY_LINE = "A Google Sheets access token must be a single line of printable text.";
const KEY_JSON = "A Google Sheets service-account key must be JSON with client_email and private_key.";
const KEY_SIZE = "A Google Sheets credential is larger than Studio will read.";
const ID_REQUIRED = "A spreadsheet id is required. The access token is sent only to sheets.googleapis.com.";
const ID_REFUSED =
  "The spreadsheet id must be the id from the sheet's address, with no URL. The access token is sent only to sheets.googleapis.com.";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,128}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
const TOKEN_MAX = 8000;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;

export interface SheetsAccessToken {
  readonly kind: "access_token";
  readonly token: string;
}

export interface SheetsServiceAccount {
  readonly kind: "service_account";
  readonly clientEmail: string;
  readonly privateKey: string;
}

export type SheetsCredential = SheetsAccessToken | SheetsServiceAccount;

export interface SheetsTokenGrant {
  readonly token: string;
  readonly expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The password field: a bearer token, or service-account JSON. */
export function sheetsCredential(config: DatabaseConnection): SheetsCredential {
  const text = config.password?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  if (text.length > 16_000) throw new DatabaseConfigError(KEY_SIZE, PROVIDER);
  if (!text.startsWith("{")) {
    const token = text.replace(/^Bearer\s+/i, "");
    if (!PRINTABLE.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
    if (token.length > TOKEN_MAX) throw new DatabaseConfigError(KEY_SIZE, PROVIDER);
    return { kind: "access_token", token };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  }
  if (!isRecord(parsed) || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  }
  if (!EMAIL.test(parsed.client_email) || parsed.client_email.length > 254) {
    throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  }
  if (!parsed.private_key.includes("PRIVATE KEY")) throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  return { kind: "service_account", clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

/**
 * The spreadsheet the Sheets API reads. The id from the address, and nothing else.
 * The refusal does not repeat a rejected id.
 */
export function sheetsSpreadsheetId(config: DatabaseConnection): string {
  const raw = config.schema?.trim() ?? "";
  if (raw === "") throw new DatabaseConfigError(ID_REQUIRED, PROVIDER);
  if (!SPREADSHEET_ID.test(raw)) throw new DatabaseConfigError(ID_REFUSED, PROVIDER);
  return raw;
}

/** The form body of one token exchange. The private key stays inside the signed assertion. */
export async function sheetsTokenForm(account: SheetsServiceAccount, now: number): Promise<Record<string, string>> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(account.privateKey, "RS256");
  } catch {
    throw new AuthenticationError(
      "The service-account private_key could not be read, so Studio cannot sign with it.",
      PROVIDER,
    );
  }
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: SHEETS_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.clientEmail)
    .setAudience(SHEETS_TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);
  return { grant_type: JWT_BEARER, assertion };
}

/** Reads a token response. The error does not include the assertion or the key. */
export function readSheetsTokenGrant(
  status: number,
  text: string,
  now: number,
  secrets: readonly string[],
): SheetsTokenGrant {
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
  const usable = typeof token === "string" && token !== "" && PRINTABLE.test(token) && token.length <= TOKEN_MAX;
  if (status !== 200 || !usable) {
    const reason = record.error_description ?? record.error ?? `HTTP ${status}`;
    const raw = typeof reason === "string" ? reason : `HTTP ${status}`;
    const hidden = redactSecret(raw, ...secrets);
    throw new AuthenticationError(
      `Google Sheets token request failed: ${hidden.length > 300 ? hidden.slice(0, 300) : hidden}`,
      PROVIDER,
    );
  }
  const ttl = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 3600;
  return { token, expiresAt: now + ttl * 1000 };
}
