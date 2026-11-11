import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `googlesheets`: no paste. The connection is a spreadsheet id, and a service-account key or an access token. */
export const GOOGLESHEETS_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
