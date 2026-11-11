/**
 * A TikTok Ads access token.
 *
 * The token is pasted and sent only to business-api.tiktok.com, as the `Access-Token`
 * header. Studio does not exchange or refresh it, and it does not put the token in the URL.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "tiktokads" as const;
const PRODUCTION_HOST = "business-api.tiktok.com";
const TOKEN_REQUIRED = "A TikTok Ads access token is required.";
const TOKEN_SIZE = "A TikTok Ads access token is larger than Studio will read.";
const TOKEN_LINE = "A TikTok Ads access token must be a single line of printable text.";
const ADVERTISER_REQUIRED = "A TikTok Ads advertiser id is required.";
const ADVERTISER_SHAPE = "A TikTok Ads advertiser id is a whole number up to 20 digits.";
const EXACT_HOST = "The API host must be business-api.tiktok.com. The access token is sent only there.";

/** The password field: a Marketing API access token. An optional `Bearer ` prefix is removed. */
export function readTikTokAdsToken(secret: string | undefined): string {
  let text = secret?.trim() ?? "";
  if (/^bearer\s+/i.test(text)) text = text.replace(/^bearer\s+/i, "");
  if (text === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  if (text.length > 8000) throw new DatabaseConfigError(TOKEN_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return text;
}

/**
 * The advertiser id, sent as `advertiser_id`. It stays a string: a TikTok id can be longer
 * than a JavaScript integer. The refusal does not repeat the value.
 */
export function tiktokAdsAdvertiserId(config: DatabaseConnection): string {
  const text = config.database?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(ADVERTISER_REQUIRED, PROVIDER);
  if (!/^[1-9][0-9]{0,19}$/.test(text)) throw new DatabaseConfigError(ADVERTISER_SHAPE, PROVIDER);
  return text;
}

/**
 * The Marketing API host. An empty field is `business-api.tiktok.com`. The refusal does not
 * repeat the host that was rejected.
 */
export function tiktokAdsHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "tiktok.com", PRODUCTION_HOST, PROVIDER);
  if (host !== PRODUCTION_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}
