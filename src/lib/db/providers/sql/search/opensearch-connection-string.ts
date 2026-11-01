import { parseGenericURL, withSSLMode } from "@/lib/db/connection-string/shared";
import type { ConnectionStringSpec, ParsedConnection } from "@/lib/db/connection-string/types";

/**
 * OpenSearch's own HTTP port, and the port DigitalOcean uses for a managed OpenSearch
 * `https://` URL. A bare `http://` or `https://` URL is ClickHouse's catch-all, so this row
 * claims only these ports and a host that says `opensearch`.
 */
const OPENSEARCH_HTTP_PORT = "9200";
const OPENSEARCH_MANAGED_PORT = "25060";

function openSearchURL(text: string): URL | null {
  if (!text.startsWith("http://") && !text.startsWith("https://")) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * An OpenSearch paste: `https://` or `http://` on port 9200 or 25060, or any port on a host
 * whose name contains `opensearch`. A ClickHouse or Snowflake host stays with that row.
 */
function claimsOpenSearch(text: string): boolean {
  const url = openSearchURL(text);
  if (url === null) return false;
  const host = url.hostname.toLowerCase();
  if (host.includes("clickhouse") || host.includes("snowflake")) return false;
  if (host.includes("opensearch")) return true;
  return url.port === OPENSEARCH_HTTP_PORT || url.port === OPENSEARCH_MANAGED_PORT;
}

function parseOpenSearchPaste(text: string): ParsedConnection | null {
  if (!claimsOpenSearch(text)) return null;
  const secure = text.startsWith("https://");
  return withSSLMode(parseGenericURL(text, "opensearch", OPENSEARCH_HTTP_PORT, null), secure ? "require" : "disable");
}

/**
 * `opensearch`: no scheme of its own (a DigitalOcean URL is `https://`), no TLS read from a URL query
 * (the scheme is the transport), a paste of an OpenSearch `http(s)://` URL, no seed load check.
 */
export const OPENSEARCH_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: {
    catchAll: false,
    claims: claimsOpenSearch,
    names: claimsOpenSearch,
    parse: parseOpenSearchPaste,
    formats: ["https://host:9200", "https://host:25060"],
  },
  validateSeed: null,
};
