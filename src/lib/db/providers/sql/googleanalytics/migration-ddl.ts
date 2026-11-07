/**
 * Google Analytics object changes are not generated. The migration prints `refusal` after its header.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Google Analytics object changes are not generated here; this connection is read-only.";

export const GOOGLEANALYTICS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Google Analytics: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
