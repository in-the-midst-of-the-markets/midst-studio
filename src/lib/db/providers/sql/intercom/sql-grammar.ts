import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Intercom editor reads. Intercom itself has no SQL parser; the provider
 * translates a read-only subset. Completion offers only the words that subset runs.
 */
const INTERCOM_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET", "COUNT", "LIKE"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:email}, ${2:name}\nFROM ${3:Contacts}\nWHERE email LIKE '${4:%@example.com}'\nORDER BY name\nLIMIT ${5:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS row_count\nFROM ${1:Contacts}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatIntercomIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Intercom statement text is read: grammar, SQL text, redaction, update target and completion. */
export const INTERCOM_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: INTERCOM_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatIntercomIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
