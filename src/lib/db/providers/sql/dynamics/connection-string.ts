import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `dynamics`: no paste. The connection is an organization host and a secret or an access token. */
export const DYNAMICS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
