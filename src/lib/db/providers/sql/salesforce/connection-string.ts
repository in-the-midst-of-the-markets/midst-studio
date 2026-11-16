import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `salesforce`: no paste. The connection is an access token and a My Domain host.
 * A `postgresql://` string belongs to Postgres or Supabase.
 */
export const SALESFORCE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
