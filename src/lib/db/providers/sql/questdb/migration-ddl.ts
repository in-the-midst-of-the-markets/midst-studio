/**
 * QuestDB table DDL is not generated. The migration prints `refusal` after its header.
 * There is no transaction wrapper: a QuestDB statement is not bracketed by BEGIN/COMMIT
 * in the migration file.
 */
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const REASON = "QuestDB table changes are not generated here; write the CREATE TABLE or ALTER TABLE by hand.";

export const QUESTDB_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "refused",
  refusal: `-- QuestDB: Cannot generate table DDL. ${REASON}`,
  transactionWrapper: null,
  reasons: [REASON],
};
