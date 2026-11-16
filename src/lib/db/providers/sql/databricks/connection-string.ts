import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `databricks`: no paste. The workspace is a host, a token and a warehouse id.
 * A `snowflake://` or `spark://` string belongs to those connections.
 */
export const DATABRICKS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
