import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/**
 * `saphana`: no paste. HANA has no URI this form claims, and a `postgresql://` string
 * belongs to the PostgreSQL connection.
 */
export const SAPHANA_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
