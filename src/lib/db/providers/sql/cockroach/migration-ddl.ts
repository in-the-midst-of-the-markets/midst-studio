/**
 * CockroachDB table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper. Locality and stored columns are part of the table,
 * and this connection does not invent them.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "CockroachDB table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand.";

export const COCKROACH_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- CockroachDB: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
