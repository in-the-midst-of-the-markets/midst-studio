/**
 * Where a bearer token may be sent.
 *
 * Airtable and HubSpot are one vendor's API, not a host the user picks. The token is sent only
 * to a hostname under that vendor's domain. A lookalike, an address with a user or a port, or a
 * redirect is refused, and a response is not read past 2 MB. The refusal does not repeat the
 * host that was rejected.
 */
import { BodyLimitExceededError, readBoundedText } from "@/lib/db/http/bounded-body";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";

export const API_ANSWER_LIMIT = 2 * 1024 * 1024;

const RESERVED_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

/** The host the token is sent to. An empty field uses `fallback`. Anything else must be under `suffix`. */
export function pinnedApiHost(
  raw: string | undefined,
  suffix: string,
  fallback: string,
  provider: DatabaseType,
): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  const refusal = `The API host must be a host under ${suffix}. The access token is sent only there.`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new DatabaseConfigError(refusal, provider);
  }
  const schemeOk = url.protocol === "https:" || url.protocol === "http:";
  if (!schemeOk || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new DatabaseConfigError(refusal, provider);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(`.${suffix}`) || host.length <= suffix.length + 1) {
    throw new DatabaseConfigError(refusal, provider);
  }
  return host;
}

/** A copy of `message` that does not carry the access token, and that stops after 500 characters. */
export function redactSecret(message: string, secret: string): string {
  const capped = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  if (secret.length < 8 || !capped.includes(secret)) return capped;
  return capped.split(secret).join("••••");
}

/**
 * The response body, when it is not a redirect and not larger than {@link API_ANSWER_LIMIT}.
 * A redirect is cancelled unread: following it would send the token wherever it points.
 */
export async function readApiAnswer(response: Response, provider: DatabaseType, service: string): Promise<string> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ConnectionError(`${service} answered with a redirect, which Studio does not follow.`, provider);
  }
  try {
    return await readBoundedText(response, API_ANSWER_LIMIT);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw new QueryError(`${service}'s answer was larger than 2 MB and was not read.`, provider);
    }
    throw error;
  }
}

/** Sets an own field. `__proto__`, `prototype` and `constructor` are skipped so a property name cannot change the row. */
export function assignOwnField(row: object, key: string, value: unknown): void {
  if (RESERVED_FIELDS.has(key)) return;
  Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The same pairs as an object, without a reserved field name. */
export function ownEntries<T>(pairs: readonly (readonly [string, T])[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of pairs) assignOwnField(out, key, value);
  return out;
}
