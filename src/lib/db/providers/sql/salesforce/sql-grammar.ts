import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Salesforce editor reads. Salesforce itself speaks SOQL; the provider
 * translates a subset (`translate.ts`). The editor still highlights, formats and completes
 * that subset. Completion offers only the words the subset runs (`lists: "only"`).
 */
const SALESFORCE_GRAMMAR: SqlGrammar = {
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
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "IS NULL",
      "IS NOT NULL",
      "LIKE",
      "TRUE",
      "FALSE",
      "NULL",
      "COUNT",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT Id, Name\nFROM \"${1:Account}\"\nWHERE Name = '${2:Acme}'\nORDER BY Name\nLIMIT ${3:50}",
      },
      { label: "COUNT", insertText: 'SELECT COUNT(*) AS row_count\nFROM "${1:Account}"' },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatSalesforceIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Salesforce statement text is read: grammar, SQL text, redaction and completion. */
export const SALESFORCE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SALESFORCE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatSalesforceIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
