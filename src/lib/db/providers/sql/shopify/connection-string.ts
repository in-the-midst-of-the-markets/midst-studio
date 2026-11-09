import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `shopify`: no paste. The connection is an Admin API access token and a shop host. */
export const SHOPIFY_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
