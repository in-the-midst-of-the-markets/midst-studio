import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Notion editor reads. Notion itself has no SQL parser; the provider
 * translates a read-only subset. Completion offers only the words that subset runs.
 */
const NOTION_GRAMMAR: SqlGrammar = {
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
      "OR",
      "NOT",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "COUNT",
      "LIKE",
      "IS",
      "NULL",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:Name}, ${2:Status}\nFROM ${3:Tasks}\nWHERE Status = '${4:Done}'\nORDER BY Name\nLIMIT ${5:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS row_count\nFROM ${1:Tasks}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatNotionIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Notion statement text is read: grammar, SQL text, redaction, update target and completion. */
export const NOTION_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: NOTION_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatNotionIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
