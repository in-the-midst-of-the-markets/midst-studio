import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Xero editor reads. Xero itself has list endpoints, not this subset;
 * the provider translates it. Completion offers only the words that subset runs.
 */
const XERO_GRAMMAR: SqlGrammar = {
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
          "SELECT ${1:InvoiceNumber}, ${2:Total}\nFROM Invoices\nWHERE Status = ${3:'AUTHORISED'}\nORDER BY Date\nLIMIT ${4:100}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS totalCount\nFROM Invoices\nWHERE Status = ${1:'AUTHORISED'}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatXeroIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Xero statement text is read: grammar, SQL text, redaction, update target and completion. */
export const XERO_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: XERO_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatXeroIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
