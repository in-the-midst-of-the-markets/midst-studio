import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the HubSpot editor reads. HubSpot itself has no SQL parser; the provider
 * translates a subset (`translate.ts`). The editor still highlights, formats and completes
 * that subset. Completion offers only the words the subset runs (`lists: "only"`), so a suggestion
 * is a statement the connection can run. The shared limiter can append `LIMIT`.
 */
const HUBSPOT_GRAMMAR: SqlGrammar = {
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
      "INSERT INTO",
      "VALUES",
      "UPDATE",
      "SET",
      "DELETE FROM",
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
        insertText:
          "SELECT *\nFROM \"${1:contacts}\"\nWHERE ${2:email} = '${3:value}'\nORDER BY ${2:email}\nLIMIT ${4:50}",
      },
      { label: "COUNT", insertText: 'SELECT COUNT(*) AS row_count\nFROM "${1:contacts}"' },
      { label: "INSERT", insertText: "INSERT INTO \"${1:contacts}\" (${2:email}) VALUES ('${3:value}')" },
      { label: "UPDATE", insertText: "UPDATE \"${1:contacts}\" SET ${2:email} = '${3:value}' WHERE id = '${4:id}'" },
      { label: "DELETE", insertText: "DELETE FROM \"${1:contacts}\" WHERE id = '${2:id}'" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "SET", "ORDER BY"],
    table: ["FROM", "INTO", "UPDATE"],
  },
};

function formatHubSpotIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How HubSpot statement text is read: grammar, SQL text, redaction, update target and completion. */
export const HUBSPOT_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: HUBSPOT_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatHubSpotIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
