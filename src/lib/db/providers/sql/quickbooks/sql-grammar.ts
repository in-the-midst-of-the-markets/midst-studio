import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the QuickBooks Online editor reads. QuickBooks Online itself has a query
 * language, not this subset; the provider translates it. Completion offers only the
 * words that subset runs.
 */
const QUICKBOOKS_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET", "COUNT", "LIKE", "IN"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:DisplayName}, ${2:Balance}\nFROM Customer\nWHERE Active = ${3:true}\nORDER BY DisplayName\nLIMIT ${4:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS totalCount\nFROM Customer\nWHERE Active = ${1:true}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatQuickBooksIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How QuickBooks Online statement text is read: grammar, SQL text, redaction, update target and completion. */
export const QUICKBOOKS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: QUICKBOOKS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatQuickBooksIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
