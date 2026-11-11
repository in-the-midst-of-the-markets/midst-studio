/**
 * A PayPal REST app.
 *
 * The client id and secret are exchanged for an access token, and both are sent
 * only to api-m.paypal.com or api-m.sandbox.paypal.com. Studio does not put them
 * in a URL.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { pinnedApiHost } from "@/lib/db/http/pinned-api-host";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "paypal" as const;
const LIVE_HOST = "api-m.paypal.com";
const SANDBOX_HOST = "api-m.sandbox.paypal.com";
const CLIENT_REQUIRED = "A PayPal client id is required.";
const SECRET_REQUIRED = "A PayPal client secret is required.";
const CREDENTIAL_SIZE = "A PayPal client id or secret is larger than Studio will send.";
const CREDENTIAL_LINE = "A PayPal client id and secret must each be a single line of printable text.";
const CLIENT_COLON = "A PayPal client id cannot contain a colon.";
const EXACT_HOST =
  "The API host must be api-m.paypal.com or api-m.sandbox.paypal.com. The client secret is sent only there.";

const ALLOWED = new Set([LIVE_HOST, SANDBOX_HOST]);

/** The user field: the REST app client id. */
export function readPayPalClientId(user: string | undefined): string {
  const text = user?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(CLIENT_REQUIRED, PROVIDER);
  if (text.length > 300) throw new DatabaseConfigError(CREDENTIAL_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  if (text.includes(":")) throw new DatabaseConfigError(CLIENT_COLON, PROVIDER);
  return text;
}

/** The password field: the REST app secret. */
export function readPayPalSecret(secret: string | undefined): string {
  const text = secret?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(SECRET_REQUIRED, PROVIDER);
  if (text.length > 300) throw new DatabaseConfigError(CREDENTIAL_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/**
 * The PayPal host. An empty field is the live host. The sandbox host is the other
 * one Studio will send the secret to. The refusal does not repeat a rejected host.
 */
export function paypalHost(config: DatabaseConnection): string {
  const host = pinnedApiHost(config.host, "paypal.com", LIVE_HOST, PROVIDER);
  if (!ALLOWED.has(host)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}
