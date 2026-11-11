import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `paypal`: no paste. The connection is an API host, a client id and a client secret. */
export const PAYPAL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
