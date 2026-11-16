import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `datadog`: no paste. The connection is an API key, an application key, and a site. */
export const DATADOG_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
