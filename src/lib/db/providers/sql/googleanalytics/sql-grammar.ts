import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Google Analytics editor reads. The Data API has no SQL parser; the
 * provider translates a read-only subset. Completion offers only the words that subset runs.
 */
const GOOGLEANALYTICS_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "ORDER BY", "ASC", "DESC", "LIMIT", "OFFSET"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:country}, ${2:activeUsers}\nFROM report\nWHERE startDate = '${3:7daysAgo}' AND endDate = '${4:yesterday}'\nORDER BY activeUsers DESC\nLIMIT ${5:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatGaIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Google Analytics statement text is read. */
export const GOOGLEANALYTICS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: GOOGLEANALYTICS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatGaIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
