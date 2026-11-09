import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Shopify editor reads. Shopify itself is a GraphQL API, not this
 * subset; the provider translates it. Completion offers only the words that
 * subset runs.
 */
const SHOPIFY_GRAMMAR: SqlGrammar = {
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
          "SELECT ${1:title}, ${2:vendor}\nFROM products\nWHERE status = ${3:'active'}\nORDER BY title\nLIMIT ${4:50}",
      },
      { label: "COUNT", insertText: "SELECT COUNT(*) AS count\nFROM products\nWHERE status = ${1:'active'}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatShopifyIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Shopify statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SHOPIFY_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SHOPIFY_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatShopifyIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
