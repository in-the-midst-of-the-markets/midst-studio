import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `stripe`: no paste. The connection is a secret key. A `postgresql://` string belongs
 * to Postgres or Supabase, and claiming it here would take a paste that belongs to one of those types.
 */
export const STRIPE_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
