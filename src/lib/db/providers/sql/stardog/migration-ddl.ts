/**
 * Stardog class changes are not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a graph change is not a BEGIN/COMMIT pair.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Stardog class changes are not generated here; add the class in Stardog.";

export const STARDOG_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Stardog: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
