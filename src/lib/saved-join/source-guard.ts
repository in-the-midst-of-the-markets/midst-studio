import { isDestructiveNonSqlQuery, statementRefusal } from "@/lib/db/destructive-commands";
import { isReadOnlySql } from "@/lib/ai/assist-readonly";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { hasConditionalExecutionComment } from "@/lib/sql/optimizer-hints";
import { hasLoneCarriageReturnInLineComment, hasUnterminatedSpan } from "@/lib/sql/spans";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

/**
 * Why this saved query cannot be a table in a join, or null when it can run.
 *
 * The outer statement is DuckDB. The saved query stays in its own database's language
 * and runs there first, so it has to be one read: a join must not be a way to run a
 * write that the editor would have asked about. There is no confirmation on this path,
 * so a non-SQL command the editor would stop for is refused here instead.
 */
const READ_REQUIRED =
  "A saved query in a join has to be a read. The join runs it on its own database before the DuckDB statement.";

export function sourceReadRefusal(type: DatabaseType, query: string): string | null {
  const refused = statementRefusal(query, type);
  if (refused !== undefined) return refused;

  if (!readsSqlText(type)) {
    return isDestructiveNonSqlQuery(query, type) ? READ_REQUIRED : null;
  }

  const grammar = resolveSqlGrammar(type);
  if (
    countCodeStatements(query, grammar) > 1 ||
    hasUnterminatedSpan(query, grammar) ||
    hasLoneCarriageReturnInLineComment(query, grammar)
  ) {
    return "A saved query in a join has to be one statement.";
  }
  if (!isReadOnlySql(query)) return READ_REQUIRED;
  // MySQL and MariaDB execute a block comment that opens with an exclamation mark. The read
  // check above skips every block comment, so a write in one of these would run with no confirmation.
  if (hasConditionalExecutionComment(query)) {
    return "A saved query in a join cannot include a comment the database executes.";
  }
  return null;
}
