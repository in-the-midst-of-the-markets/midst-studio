/**
 * Which statement a chat may keep for the engine it is talking to.
 *
 * SQL stays on the SQL read gate. Neo4j keeps a Cypher read and drops a SQL
 * statement, so a chat that just left PostgreSQL cannot put a SELECT into the
 * Neo4j editor. A search or vector request the editor can run is kept as
 * written, including a {{token}} the embedding model fills.
 */

import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { assistNativeRead } from "@/lib/ai/assist-dialect";
import { isReadOnlySql } from "@/lib/ai/assist-readonly";
import { applyQueryFilters } from "@/lib/charts/query-filters";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";

const LANGUAGES: Readonly<Record<string, AgentStatementLanguageId | null>> = AGENT_STATEMENT_LANGUAGE;

/** The statement language for a connection type, or null when this chat does not know it. */
export function assistStatementLanguage(databaseType: string): AgentStatementLanguageId | null {
  if (!Object.hasOwn(LANGUAGES, databaseType)) return null;
  return LANGUAGES[databaseType] ?? null;
}

/** Whether this statement is a read the named engine may run. */
export function isAssistRead(sql: string, databaseType: string): boolean {
  if (assistStatementLanguage(databaseType) === "cypher") {
    if (!checkCypherRead(sql, NEO4J_POLICY_PROFILE).allowed) return false;
    if (!isReadOnlySql(sql)) return true;
    return /^\s*show\b/i.test(sql);
  }
  const native = assistNativeRead(databaseType, sql);
  if (native !== null) return native;
  return isReadOnlySql(sql);
}

/**
 * The text a run sends. Cypher and a native request are left as written, so a
 * vector {{token}} is still there when the editor embeds it. SQL placeholders
 * are filled first. A write is null, so the page can say it only runs reads.
 */
export function assistRunnableStatement(sql: string, databaseType: string): string | null {
  if (assistStatementLanguage(databaseType) === "cypher" || assistNativeRead(databaseType, sql) === true) {
    return isAssistRead(sql, databaseType) ? sql : null;
  }
  const statement = applyQueryFilters(sql);
  return isAssistRead(statement, databaseType) ? statement : null;
}
