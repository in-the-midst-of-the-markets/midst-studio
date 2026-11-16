import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `stardog`: no paste. The connection is a host, a database, a user and a password.
 * A `postgresql://` string belongs to Postgres or Supabase.
 */
export const STARDOG_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
