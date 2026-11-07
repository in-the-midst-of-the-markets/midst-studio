/**
 * Airtable table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: an Airtable change is one Web API request, not a
 * BEGIN/COMMIT pair.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Airtable table changes are not generated here; create the field in Airtable.";

export const AIRTABLE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Airtable: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
