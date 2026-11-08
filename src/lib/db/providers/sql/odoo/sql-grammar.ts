import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Odoo editor reads. Odoo itself is a JSON-2 API, not this subset; the
 * provider translates it. Completion offers only the words that subset runs.
 */
const ODOO_GRAMMAR: SqlGrammar = {
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
      "ILIKE",
      "IN",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT ${1:name}, ${2:email}\nFROM res.partner\nWHERE is_company = ${3:true}\nORDER BY name\nLIMIT ${4:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS total\nFROM res.partner\nWHERE is_company = ${1:true}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatOdooIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Odoo statement text is read: grammar, SQL text, redaction, update target and completion. */
export const ODOO_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: ODOO_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatOdooIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
