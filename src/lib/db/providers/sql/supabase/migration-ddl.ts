/**
 * Supabase table DDL is the same shape as Postgres. The statements are this module's own
 * row, built from the shared blocks, and the migration is wrapped in `BEGIN;` and `COMMIT;`.
 */
import {
  BEGIN_COMMIT,
  standardAddColumn,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropForeignKey,
  standardDropIndex,
  standardDropTable,
  standardModifyColumn,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

export const SUPABASE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: BEGIN_COMMIT,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: standardDropForeignKey,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: standardModifyColumn,
  dropTable: standardDropTable,
  reasons: [],
};
