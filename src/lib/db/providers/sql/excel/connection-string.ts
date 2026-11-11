import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `excel`: no paste. The connection is a workbook path, and a client secret or an access token. */
export const EXCEL_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
