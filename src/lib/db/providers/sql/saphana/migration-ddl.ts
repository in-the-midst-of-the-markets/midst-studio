/**
 * SAP HANA table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a HANA statement is not bracketed by BEGIN/COMMIT
 * in the migration file.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "SAP HANA table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand.";

export const SAPHANA_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- SAP HANA: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
