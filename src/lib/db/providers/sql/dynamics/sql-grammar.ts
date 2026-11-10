import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Dynamics editor reads. Dynamics itself has no SQL parser; the provider
 * translates a read-only subset. Completion offers only the words that subset runs.
 */
const DYNAMICS_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: [
      "SELECT",
      "FROM",
      "WHERE",
      "AND",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "COUNT",
      "LIKE",
      "IS NULL",
      "IS NOT NULL",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:name}\nFROM ${2:accounts}\nWHERE name LIKE '${3:%Contoso%}'\nORDER BY name\nLIMIT ${4:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS row_count\nFROM ${1:accounts}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatDynamicsIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Dynamics statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DYNAMICS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DYNAMICS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatDynamicsIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
