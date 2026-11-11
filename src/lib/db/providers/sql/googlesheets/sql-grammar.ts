import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Google Sheets editor reads. Google Sheets itself has no SQL parser; the
 * provider translates a read-only subset. Completion offers only the words that subset runs.
 */
const SHEETS_GRAMMAR: SqlGrammar = {
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
      "LIKE",
      "IS NULL",
      "IS NOT NULL",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ${1:name}\nFROM ${2:sheet1}\nWHERE name LIKE '${3:%Ada%}'\nORDER BY name\nLIMIT ${4:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatSheetsIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Google Sheets statement text is read: grammar, SQL text, redaction, update target and completion. */
export const GOOGLESHEETS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SHEETS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatSheetsIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
