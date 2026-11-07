import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Stripe editor reads. Stripe itself has no SQL parser; the provider
 * translates a read-only subset (`translate.ts`). Completion offers only the words
 * that subset runs (`lists: "only"`). The shared limiter can append `LIMIT`.
 */
const STRIPE_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "ORDER BY", "DESC", "LIMIT", "OFFSET", "TRUE", "FALSE", "COUNT"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT *\nFROM \"${1:customers}\"\nWHERE ${2:email} = '${3:value}'\nORDER BY created DESC\nLIMIT ${4:50}",
      },
      { label: "COUNT", insertText: 'SELECT COUNT(*) AS row_count\nFROM "${1:customers}"' },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatStripeIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Stripe statement text is read: grammar, SQL text, redaction, update target and completion. */
export const STRIPE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: STRIPE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatStripeIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
