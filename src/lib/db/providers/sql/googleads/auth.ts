/**
 * A Google access token for the Google Ads API.
 *
 * A pasted token is used as-is and sent only to googleads.googleapis.com.
 * A service-account key is signed here and exchanged only at oauth2.googleapis.com.
 * The private key is not sent to the Ads API. A developer token is not sent: Google
 * retired that header, and access is the Cloud project's.
 */
import { importPKCS8, SignJWT } from "jose";
import { AuthenticationError, ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost, redactSecret } from "@/lib/db/http/pinned-api-host";
import type { NodeTransport } from "@/lib/db/http/node-transport";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "googleads" as const;
export const ADS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_HOST = "googleads.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/adwords";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const KEY_REQUIRED = "A Google Ads access token or service-account key is required.";
const KEY_LINE = "A Google Ads access token must be a single line of printable text.";
const KEY_JSON = "A Google Ads service-account key must be JSON with client_email and private_key.";
const KEY_SIZE = "A Google Ads credential is larger than Studio will read.";
const EXACT_HOST = "The API host must be googleads.googleapis.com. The access token is sent only there.";
const CUSTOMER_REQUIRED = "A Google Ads customer id is required.";
const CUSTOMER_DIGITS = "A Google Ads customer id is 10 digits, with or without hyphens.";
const MANAGER_DIGITS = "A manager customer id is 10 digits, with or without hyphens.";

export interface AdsAccessToken {
  readonly kind: "access_token";
  readonly token: string;
}

export interface AdsServiceAccount {
  readonly kind: "service_account";
  readonly clientEmail: string;
  readonly privateKey: string;
}

export type AdsCredential = AdsAccessToken | AdsServiceAccount;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The password field: a bearer token, or one line of service-account JSON. */
export function readAdsCredential(secret: string | undefined): AdsCredential {
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

/** The host the access token is sent to. Only googleads.googleapis.com is accepted. */
export function adsApiHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "googleapis.com", ADS_HOST, PROVIDER);
  if (host !== ADS_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

function tenDigits(raw: string): string | null {
  const digits = raw.replaceAll("-", "");
  return /^[0-9]{10}$/.test(digits) ? digits : null;
}

/** The customer id in the search path, 10 digits, so it cannot change the request path. */
export function adsCustomerId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (id === "") throw new DatabaseConfigError(CUSTOMER_REQUIRED, PROVIDER);
  const digits = tenDigits(id);
  if (digits === null) throw new DatabaseConfigError(CUSTOMER_DIGITS, PROVIDER);
  return digits;
}

/**
 * The manager account, when the token reaches the customer through one.
 * An empty user field means the token belongs to the customer itself, and no
 * login-customer-id header is sent.
 */
export function adsManagerId(config: DatabaseConnection): string | null {
  const id = config.user?.trim() ?? "";
  if (id === "") return null;
  const digits = tenDigits(id);
  if (digits === null) throw new DatabaseConfigError(MANAGER_DIGITS, PROVIDER);
  return digits;
}

/** The form body of one token exchange. The private key stays inside the signed assertion. */
export async function adsTokenForm(account: AdsServiceAccount, now: number): Promise<Record<string, string>> {
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
    .setAudience(ADS_TOKEN_URL)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);
  return { grant_type: JWT_BEARER, assertion };
}

export interface AdsTokenGrant {
  readonly token: string;
  readonly expiresAt: number;
}

/** Reads a token response. The error does not include the assertion or the key. */
export function readAdsTokenGrant(
  status: number,
  text: string,
  now: number,
  secrets: readonly string[] = [],
): AdsTokenGrant {
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
  if (status !== 200 || typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token) || token.length > 8000) {
    const reason = record.error_description ?? record.error ?? `HTTP ${status}`;
    const raw = typeof reason === "string" ? reason : `HTTP ${status}`;
    const hidden = redactSecret(raw, ...secrets);
    const message = hidden.length > 300 ? hidden.slice(0, 300) : hidden;
    throw new AuthenticationError(`Google token request failed: ${message}`, PROVIDER);
  }
  const ttl = typeof record.expires_in === "number" && record.expires_in > 60 ? record.expires_in - 60 : 0;
  return { token, expiresAt: now + ttl * 1000 };
}

const REDIRECT_REFUSED = "Google Ads answered with a redirect, which Studio does not follow.";

/** Exchanges a service-account key. Callers send this request only to oauth2.googleapis.com. */
export async function exchangeAdsToken(
  account: AdsServiceAccount,
  transport: NodeTransport,
  now: number,
  secrets: readonly string[] = [],
): Promise<AdsTokenGrant> {
  const form = await adsTokenForm(account, now);
  const response = await transport.request({
    method: "POST",
    url: ADS_TOKEN_URL,
    form,
    signal: AbortSignal.timeout(30_000),
    maxResponseBytes: 64 * 1024,
  });
  if (response.status >= 300 && response.status < 400) throw new ConnectionError(REDIRECT_REFUSED, PROVIDER);
  return readAdsTokenGrant(response.status, response.text, now, [form.assertion, account.privateKey, ...secrets]);
}
