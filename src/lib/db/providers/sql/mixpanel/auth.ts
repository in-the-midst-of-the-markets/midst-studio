/**
 * A Mixpanel service account.
 *
 * The username and secret are sent as HTTP Basic, and only to mixpanel.com,
 * eu.mixpanel.com, or in.mixpanel.com. Studio does not put either value in a URL.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/db/types";

const PROVIDER = "mixpanel" as const;
const US_HOST = "mixpanel.com";
const EU_HOST = "eu.mixpanel.com";
const IN_HOST = "in.mixpanel.com";
const ACCOUNT_REQUIRED = "A Mixpanel service account username is required.";
const SECRET_REQUIRED = "A Mixpanel service account secret is required.";
const PROJECT_REQUIRED = "A Mixpanel project id is required.";
const CREDENTIAL_SIZE = "A Mixpanel service account or secret is larger than Studio will send.";
const CREDENTIAL_LINE = "A Mixpanel service account and secret must each be a single line of printable text.";
const ACCOUNT_COLON = "A Mixpanel service account username cannot contain a colon.";
const PROJECT_DIGITS = "A Mixpanel project id must be a positive whole number.";
const EXACT_HOST =
  "The API host must be mixpanel.com, eu.mixpanel.com, or in.mixpanel.com. The service account secret is sent only there.";

const ALLOWED = new Set([US_HOST, EU_HOST, IN_HOST]);

/** The user field: the service account username. */
export function readMixpanelAccount(user: string | undefined): string {
  const text = user?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(ACCOUNT_REQUIRED, PROVIDER);
  if (text.length > 200) throw new DatabaseConfigError(CREDENTIAL_SIZE, PROVIDER);
  if (!/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  if (text.includes(":")) throw new DatabaseConfigError(ACCOUNT_COLON, PROVIDER);
  return text;
}

/** The password field: the service account secret. */
export function readMixpanelSecret(secret: string | undefined): string {
  const text = secret?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(SECRET_REQUIRED, PROVIDER);
  if (text.length > 300) throw new DatabaseConfigError(CREDENTIAL_SIZE, PROVIDER);
  if (text.length < 8 || !/^[\x21-\x7e]+$/.test(text)) throw new DatabaseConfigError(CREDENTIAL_LINE, PROVIDER);
  return text;
}

/** The database field: the numeric project id. It is not a secret. */
export function readMixpanelProjectId(database: string | undefined): string {
  const text = database?.trim() ?? "";
  if (text === "") throw new DatabaseConfigError(PROJECT_REQUIRED, PROVIDER);
  if (!/^[1-9][0-9]{0,19}$/.test(text)) throw new DatabaseConfigError(PROJECT_DIGITS, PROVIDER);
  return text;
}

/**
 * The Mixpanel host. An empty field is the US host. EU and India residency are the
 * other two hosts Studio will send the secret to. The refusal does not repeat a
 * rejected host.
 */
export function mixpanelHost(config: DatabaseConnection): string {
  const trimmed = config.host?.trim() ?? "";
  if (trimmed === "") return US_HOST;
  if (/:\d/.test(trimmed)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  }
  const schemeOk = url.protocol === "https:" || url.protocol === "http:";
  const barePath = url.pathname === "/" || url.pathname === "";
  if (
    !schemeOk ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !barePath
  ) {
    throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!ALLOWED.has(host)) throw new DatabaseConfigError(EXACT_HOST, PROVIDER);
  return host;
}

/** `Authorization: Basic …`. The account and secret limits keep this header inside 1024 bytes. */
export function mixpanelAuthorization(account: string, secret: string): string {
  return `Basic ${Buffer.from(`${account}:${secret}`, "utf8").toString("base64")}`;
}
