import type { ConnectionStringSpec } from "@/lib/db/connection-string/types";

/** `odoo`: no paste. The connection is an API key and a host under odoo.com. */
export const ODOO_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: null,
};
