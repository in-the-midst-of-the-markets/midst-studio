/**
 * Odoo object changes are not generated. The migration prints `refusal` after its
 * header. There is no transaction wrapper: a change is not a statement this
 * connection sends.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Odoo object changes are not generated here; this connection is read-only.";

export const ODOO_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Odoo: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
