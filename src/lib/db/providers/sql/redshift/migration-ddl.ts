/**
 * Amazon Redshift table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: distribution style and sort keys are part of the table,
 * and this connection does not invent them.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "Amazon Redshift table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand.";

export const REDSHIFT_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- Amazon Redshift: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
