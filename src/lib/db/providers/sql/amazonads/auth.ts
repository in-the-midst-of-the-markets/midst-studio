/**
 * Amazon Ads credentials. The client secret and the refresh token are sent only to the Login with Amazon host. The
 * access token, the client id and the profile id are sent only to an official advertising host.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "amazonads" as const;
/** The only host that receives the client secret and the refresh token. */
export const TOKEN_HOST = "api.amazon.com";
export const TOKEN_PATH = "/auth/O2/token";
/** North America, and the host an empty field means. */
const DEFAULT_HOST = "advertising-api.amazon.com";
/** Official advertising hosts. A product host or any other amazon.com name is not one of them. */
const API_HOSTS = new Set([
  "advertising-api.amazon.com",
  "advertising-api-eu.amazon.com",
  "advertising-api-fe.amazon.com",
]);

const CLIENT_ID_MAX = 256;
const SECRET_MAX = 512;
const REFRESH_MAX = 2048;
const HOST_REFUSED = "Invalid Amazon Ads connection: the host must be an official advertising host.";
const PROFILE_REFUSED =
  "Invalid Amazon Ads connection: the profile id must be the digits Amazon shows for that profile.";

function credential(value: string | undefined, label: string, max: number): string {
  const text = value?.trim() ?? "";
  if (text === "" || text.length > max || !/^[\x21-\x7e]+$/.test(text)) {
    throw new DatabaseConfigError(`Invalid Amazon Ads connection: the ${label} is not usable.`, PROVIDER);
  }
  return text;
}

/** The client id. It is not a secret: Amazon requires it on every advertising call. */
export function amazonAdsClientId(config: DatabaseConnection): string {
  return credential(config.user, "client id", CLIENT_ID_MAX);
}

/** The client secret. It leaves this process only on the token request. */
export function amazonAdsClientSecret(config: DatabaseConnection): string {
  return credential(config.password, "client secret", SECRET_MAX);
}

/** The refresh token. It leaves this process only on the token request. */
export function amazonAdsRefreshToken(config: DatabaseConnection): string {
  return credential(config.database, "refresh token", REFRESH_MAX);
}

/** The advertising profile, sent as Amazon-Advertising-API-Scope and never as a secret. */
export function amazonAdsProfileId(config: DatabaseConnection): string {
  const text = config.schema?.trim() ?? "";
  if (!/^[1-9][0-9]{0,19}$/.test(text)) throw new DatabaseConfigError(PROFILE_REFUSED, PROVIDER);
  return text;
}

/**
 * An official advertising host. The suffix check runs first and does not repeat a rejected name; the allowlist then
 * refuses a product host that still ends in amazon.com.
 */
export function amazonAdsHost(value: string | undefined): string {
  const host = pinnedApiHost(value, "amazon.com", DEFAULT_HOST, PROVIDER);
  if (!API_HOSTS.has(host)) throw new DatabaseConfigError(HOST_REFUSED, PROVIDER);
  return host;
}
