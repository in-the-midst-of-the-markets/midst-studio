import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Stripe editor reads. A query is Sigma SQL and is sent to a query run.
 * Completion offers the read-only words a query run accepts, plus `REPORT`. A write,
 * `CREATE`, and the shared function list stay out, because this connection refuses them.
 * The shared limiter can append `LIMIT`.
 */
const STRIPE_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  completionWords: {
    keywords: [
      "SELECT",
      "FROM",
      "WHERE",
      "AND",
      "OR",
      "NOT",
      "IN",
      "BETWEEN",
      "LIKE",
      "IS NULL",
      "IS NOT NULL",
      "GROUP BY",
      "HAVING",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "JOIN",
      "INNER JOIN",
      "LEFT JOIN",
      "ON",
      "AS",
      "WITH",
      "DISTINCT",
      "UNION",
      "ALL",
      "CASE",
      "WHEN",
      "THEN",
      "ELSE",
      "END",
      "REPORT",
    ],
    functions: ["COUNT", "SUM", "AVG", "MIN", "MAX", "date_format", "date_trunc"],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ${1:id}\nFROM ${2:balance_transactions}\nLIMIT ${3:100}",
      },
      {
        label: "REPORT",
        insertText:
          "REPORT ${1:balance.summary} (\n  interval_start => '${2:2026-01-01T00:00:00.000Z}',\n  interval_end => '${3:2026-02-01T00:00:00.000Z}'\n)",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY", "GROUP BY", "JOIN"],
    table: ["FROM", "JOIN"],
  },
};

function formatStripeIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Stripe statement text is read: grammar, SQL text, redaction, update target and completion. */
export const STRIPE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: STRIPE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatStripeIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
