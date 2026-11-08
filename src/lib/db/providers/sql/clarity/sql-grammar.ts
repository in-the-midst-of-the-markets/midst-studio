import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Clarity editor reads. Clarity itself has no SQL parser; the provider
 * translates a read-only subset. Completion offers only the words that subset runs.
 */
const CLARITY_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET", "COUNT"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ${1:OS}, ${2:totalSessionCount}\nFROM insights\nWHERE days = ${3:1}\nLIMIT ${4:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS row_count\nFROM insights\nWHERE days = ${1:1}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatClarityIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Clarity statement text is read: grammar, SQL text, redaction, update target and completion. */
export const CLARITY_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: CLARITY_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatClarityIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
