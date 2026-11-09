/**
 * A Google access token for the Analytics Data API.
 *
 * A pasted token is used as-is and sent only to analyticsdata.googleapis.com.
 * A service-account key is signed here and exchanged only at oauth2.googleapis.com.
 * The private key is not sent to the Data API.
 */
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError, DatabaseConfigError } from "@/lib/db/errors";
import { redactSecret } from "@/lib/db/http/pinned-api-host";
import type { NodeTransport } from "@/lib/db/http/node-transport";

const PROVIDER = "googleanalytics" as const;
export const GA_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const KEY_REQUIRED = "A Google Analytics access token or service-account key is required.";
const KEY_LINE = "A Google Analytics access token must be a single line of printable text.";
const KEY_JSON = "A Google Analytics service-account key must be JSON with client_email and private_key.";
const KEY_SIZE = "A Google Analytics credential is larger than Studio will read.";

export interface GaAccessToken {
  readonly kind: "access_token";
  readonly token: string;
}

export interface GaServiceAccount {
  readonly kind: "service_account";
  readonly clientEmail: string;
  readonly privateKey: string;
}

export type GaCredential = GaAccessToken | GaServiceAccount;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The password field: a bearer token, or one line of service-account JSON. */
export function readGaCredential(secret: string | undefined): GaCredential {
  const text = secret?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  if (text.length > 16_000) throw new DatabaseConfigError(KEY_SIZE, PROVIDER);
  if (!text.startsWith("{")) {
    const token = text.replace(/^Bearer\s+/i, "");
    if (!/^[\x21-\x7e]+$/.test(token)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
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
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(parsed.client_email) || parsed.client_email.length > 254) {
    throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  }
  if (!parsed.private_key.includes("PRIVATE KEY")) throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  return { kind: "service_account", clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

/** The form body of one token exchange. The private key stays inside the signed assertion. */
export async function gaTokenForm(account: GaServiceAccount, now: number): Promise<Record<string, string>> {
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
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.clientEmail)
    .setAudience(GA_TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);
  return { grant_type: JWT_BEARER, assertion };
}

export interface GaTokenGrant {
  readonly token: string;
  readonly expiresAt: number;
}

/** Reads a token response. The error does not include the assertion or the key. */
export function readGaTokenGrant(
  status: number,
  text: string,
  now: number,
  secrets: readonly string[] = [],
): GaTokenGrant {
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
  if (status !== 200 || typeof token !== "string" || token === "") {
    const reason = record.error_description ?? record.error ?? `HTTP ${status}`;
    const raw = typeof reason === "string" ? reason : `HTTP ${status}`;
    const hidden = redactSecret(raw, ...secrets);
    const message = hidden.length > 300 ? hidden.slice(0, 300) : hidden;
    throw new AuthenticationError(`Google token request failed: ${message}`, PROVIDER);
  }
  const ttl = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 3600;
  return { token, expiresAt: now + ttl * 1000 };
}

/** Exchanges a service-account key. Callers send this request only to oauth2.googleapis.com. */
export async function exchangeGaToken(
  account: GaServiceAccount,
  transport: NodeTransport,
  now: number,
): Promise<GaTokenGrant> {
  const form = await gaTokenForm(account, now);
  const response = await transport.request({
    method: "POST",
    url: GA_TOKEN_URL,
    form,
    signal: AbortSignal.timeout(30_000),
    maxResponseBytes: 64 * 1024,
  });
  return readGaTokenGrant(response.status, response.text, now, [form.assertion, account.privateKey]);
}
