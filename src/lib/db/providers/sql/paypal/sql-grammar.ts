import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the PayPal editor reads. PayPal itself has no SQL parser; the provider
 * translates a read-only subset into one REST list. Completion offers only the words
 * that subset runs.
 */
const PAYPAL_GRAMMAR: SqlGrammar = {
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
        insertText:
          "SELECT transaction.id, transaction.amount\nFROM transaction\nWHERE transaction.status = 'S'\nORDER BY transaction.amount DESC\nLIMIT ${1:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatPayPalIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How PayPal statement text is read: grammar, SQL text, redaction, update target and completion. */
export const PAYPAL_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: PAYPAL_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatPayPalIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
