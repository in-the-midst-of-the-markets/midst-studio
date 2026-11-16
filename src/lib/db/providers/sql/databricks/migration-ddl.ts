/**
 * Databricks SQL table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a warehouse statement is not bracketed by BEGIN/COMMIT
 * in the migration file.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Databricks SQL table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand.";

export const DATABRICKS_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Databricks SQL: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
