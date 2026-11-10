/**
 * A Microsoft Advertising access token and developer token.
 *
 * Both are pasted in one JSON object and sent only to the Campaign Management host.
 * Studio does not exchange or refresh them, and it does not read a refresh token.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "microsoftads" as const;
const PRODUCTION_HOST = "campaign.api.bingads.microsoft.com";
const SANDBOX_HOST = "campaign.api.sandbox.bingads.microsoft.com";
const HOSTS = new Set([PRODUCTION_HOST, SANDBOX_HOST]);
const KEY_REQUIRED = "A Microsoft Ads access token and developer token are required.";
const KEY_JSON = "A Microsoft Ads credential must be JSON with accessToken and developerToken.";
const KEY_SIZE = "A Microsoft Ads credential is larger than Studio will read.";
const KEY_LINE = "A Microsoft Ads token must be a single line of printable text.";
const EXACT_HOST =
  "The API host must be campaign.api.bingads.microsoft.com or campaign.api.sandbox.bingads.microsoft.com. The access token is sent only there.";
const CUSTOMER_REQUIRED = "A Microsoft Ads customer id is required.";
const CUSTOMER_DIGITS = "A Microsoft Ads customer id is a whole number up to 15 digits.";
const ACCOUNT_REQUIRED = "A Microsoft Ads account id is required.";
const ACCOUNT_DIGITS = "A Microsoft Ads account id is a whole number up to 15 digits.";

export interface MicrosoftAdsCredential {
  readonly accessToken: string;
  readonly developerToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printable(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().replace(/^Bearer\s+/i, "");
  if (token.length < 8 || token.length > max || !/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}

/** The password field: one JSON object with the access token and the developer token. */
export function readMicrosoftAdsCredential(secret: string | undefined): MicrosoftAdsCredential {
  const text = secret?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  if (text.length > 16_000) throw new DatabaseConfigError(KEY_SIZE, PROVIDER);
  if (!text.startsWith("{")) throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  }
  if (!isRecord(parsed)) throw new DatabaseConfigError(KEY_JSON, PROVIDER);
  const access = printable(parsed.accessToken ?? parsed.access_token, 8000);
  const developer = printable(parsed.developerToken ?? parsed.developer_token, 200);
  if (access === null || developer === null) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return { accessToken: access, developerToken: developer };
}

/** The Campaign Management host. Production is the default. The sandbox host is the other accepted host. */
export function microsoftAdsHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "bingads.microsoft.com", PRODUCTION_HOST, PROVIDER);
  if (!HOSTS.has(host)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

function wholeId(raw: string): string | null {
  const text = raw.trim();
  if (!/^[0-9]{1,15}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

/** The manager customer id, sent as CustomerId. */
export function microsoftAdsCustomerId(config: DatabaseConnection): string {
  const id = config.user?.trim() ?? "";
  if (id === "") throw new DatabaseConfigError(CUSTOMER_REQUIRED, PROVIDER);
  const digits = wholeId(id);
  if (digits === null) throw new DatabaseConfigError(CUSTOMER_DIGITS, PROVIDER);
  return digits;
}

/** The ad account id, sent as CustomerAccountId and as AccountId. */
export function microsoftAdsAccountId(config: DatabaseConnection): string {
  const id = config.database?.trim() ?? "";
  if (id === "") throw new DatabaseConfigError(ACCOUNT_REQUIRED, PROVIDER);
  const digits = wholeId(id);
  if (digits === null) throw new DatabaseConfigError(ACCOUNT_DIGITS, PROVIDER);
  return digits;
}
