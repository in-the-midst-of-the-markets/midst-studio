/**
 * Salesforce object changes are not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a Salesforce change is not a BEGIN/COMMIT pair.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Salesforce object changes are not generated here; create the field in Salesforce.";

export const SALESFORCE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Salesforce: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
