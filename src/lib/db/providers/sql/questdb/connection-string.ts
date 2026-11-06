import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `questdb`: no paste. A `postgresql://` string is the PostgreSQL connection's, and
 * claiming it here would take a paste that belongs to that type.
 */
export const QUESTDB_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
