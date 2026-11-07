import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Airtable editor reads. Airtable itself has no SQL parser; the provider
 * translates a subset (`translate.ts`). The editor still highlights, formats and completes
 * that subset, and the shared limiter can append `LIMIT` because this grammar's trailing
 * limit list is the default (no clause has to follow the bound).
 */
const AIRTABLE_GRAMMAR: SqlGrammar = {
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
    ],
    functions: [],
    snippets: [
      { label: "SELECT", insertText: 'SELECT * FROM "${1:table}" LIMIT ${2:50}' },
      { label: "INSERT", insertText: "INSERT INTO \"${1:table}\" (${2:column}) VALUES ('${3:value}')" },
      { label: "UPDATE", insertText: "UPDATE \"${1:table}\" SET ${2:column} = '${3:value}' WHERE _id = '${4:rec}'" },
      { label: "DELETE", insertText: "DELETE FROM \"${1:table}\" WHERE _id = '${2:rec}'" },
    ],
  },
  completionClauses: {
    column: ["ORDER BY", "WHERE"],
    table: ["FROM", "INTO", "UPDATE", "JOIN"],
  },
};

function formatAirtableIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Airtable statement text is read: grammar, SQL text, redaction, update target and completion. */
export const AIRTABLE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: AIRTABLE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatAirtableIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
