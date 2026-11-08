import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `quickbooks`: no paste. The connection is an OAuth access token and a company id. */
export const QUICKBOOKS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
