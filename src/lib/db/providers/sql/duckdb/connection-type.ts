import type { DatabaseType } from "@/lib/types";

/** Whether this saved query was stored for DuckDB, the engine `write_duckdb_query` replaces. */
export function isDuckDbConnectionType(type: DatabaseType): boolean {
  return type === "duckdb";
}
