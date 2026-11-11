/**
 * A Pipedrive API token.
 *
 * The token is pasted and sent only to a Pipedrive host, as the `x-api-token` header.
 * Studio does not exchange or refresh it, and it does not put the token in the URL.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "pipedrive" as const;
const PRODUCTION_HOST = "api.pipedrive.com";
const KEY_REQUIRED = "A Pipedrive API token is required.";
const KEY_SIZE = "A Pipedrive API token is larger than Studio will read.";
const KEY_LINE = "A Pipedrive API token must be a single line of printable text.";
const EXACT_HOST =
  "The API host must be api.pipedrive.com or your company host, one name ending in .pipedrive.com. The API token is sent only there.";

const COMPANY_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pipedrive\.com$/;

/** The password field: the API token from Settings, Personal preferences, API. */
export function readPipedriveToken(secret: string | undefined): string {
  const text = secret?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(KEY_REQUIRED, PROVIDER);
  if (text.length > 8000) throw new DatabaseConfigError(KEY_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(KEY_LINE, PROVIDER);
  return text;
}

/**
 * The Pipedrive host. An empty field is `api.pipedrive.com`. A company domain is one
 * label under `pipedrive.com`. The refusal does not repeat the host that was rejected.
 */
export function pipedriveHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "pipedrive.com", PRODUCTION_HOST, PROVIDER);
  if (!COMPANY_HOST.test(host)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}
