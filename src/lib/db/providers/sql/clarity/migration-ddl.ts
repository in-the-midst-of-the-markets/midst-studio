/**
 * Clarity object changes are not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a Clarity change is not a statement this connection sends.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Clarity object changes are not generated here; this connection is read-only.";

export const CLARITY_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Clarity: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
