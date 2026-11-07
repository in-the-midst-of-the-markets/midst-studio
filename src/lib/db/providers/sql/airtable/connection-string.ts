import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `airtable`: no paste. The connection is an access token and a base id. A `postgresql://`
 * string belongs to Postgres or Supabase, and claiming it here would take a paste that
 * belongs to one of those types.
 */
export const AIRTABLE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
