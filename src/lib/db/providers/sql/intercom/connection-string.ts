import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `intercom`: no paste. The connection is an access token. */
export const INTERCOM_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
