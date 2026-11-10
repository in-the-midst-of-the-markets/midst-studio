import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `xero`: no paste. The connection is an OAuth access token and an organisation id. */
export const XERO_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
