/**
 * A Meta Ads access token.
 *
 * The token is pasted and sent only to graph.facebook.com, as an Authorization Bearer
 * header. Studio does not exchange or refresh it, and it does not put the token in the URL.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "metaads" as const;
const PRODUCTION_HOST = "graph.facebook.com";
const TOKEN_REQUIRED = "A Meta Ads access token is required.";
const TOKEN_SIZE = "A Meta Ads access token is larger than Studio will read.";
const TOKEN_LINE = "A Meta Ads access token must be a single line of printable text.";
const ACCOUNT_REQUIRED = "A Meta Ads ad account id is required.";
const ACCOUNT_SHAPE = "A Meta Ads ad account id is a whole number up to 20 digits, with an optional act_ prefix.";
const EXACT_HOST = "The API host must be graph.facebook.com. The access token is sent only there.";

/** The password field: a Marketing API access token. An optional `Bearer ` prefix is removed. */
export function readMetaAdsToken(secret: string | undefined): string {
  let text = secret?.trim() ?? "";
  if (/^bearer\s+/i.test(text)) text = text.replace(/^bearer\s+/i, "");
  if (text === "") throw new DatabaseConfigError(TOKEN_REQUIRED, PROVIDER);
  if (text.length > 8000) throw new DatabaseConfigError(TOKEN_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(TOKEN_LINE, PROVIDER);
  return text;
}

/**
 * The ad account id, sent in the path as `act_<id>`. A pasted `act_` prefix is removed.
 * The id stays a string: a Meta id can be longer than a JavaScript integer. The refusal
 * does not repeat the value.
 */
export function metaAdsAccountId(config: DatabaseConnection): string {
  const text = config.database?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(ACCOUNT_REQUIRED, PROVIDER);
  const id = /^(?:act_)?([1-9][0-9]{0,19})$/i.exec(text)?.[1];
  if (id === undefined) throw new DatabaseConfigError(ACCOUNT_SHAPE, PROVIDER);
  return id;
}

/**
 * The Marketing API host. An empty field is `graph.facebook.com`. The refusal does not
 * repeat the host that was rejected.
 */
export function metaAdsHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "facebook.com", PRODUCTION_HOST, PROVIDER);
  if (host !== PRODUCTION_HOST) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}
