import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `rest`: no paste. The connection is a hostname, a secret, and a resource list. */
export const REST_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
