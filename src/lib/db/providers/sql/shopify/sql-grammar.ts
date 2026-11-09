import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The ShopifyQL the editor reads. Completion offers the clauses a ShopifyQL
 * query uses. The provider sends the text through `shopifyqlQuery`.
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
    keywords: [
      "FROM",
      "SHOW",
      "WHERE",
      "GROUP BY",
      "TIMESERIES",
      "WITH",
      "HAVING",
      "SINCE",
      "UNTIL",
      "DURING",
      "COMPARE TO",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "VISUALIZE",
      "AND",
      "OR",
      "AS",
      "TYPE",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "FROM",
        insertText: "FROM sales\n  SHOW ${1:total_sales}, ${2:orders}\n  TIMESERIES month\n  SINCE -12m UNTIL today",
      },
      {
        label: "SHOW",
        insertText:
          "FROM sales\n  SHOW ${1:total_sales}\n  GROUP BY ${2:sales_channel}\n  DURING last_month\n  ORDER BY total_sales DESC\n  LIMIT ${3:10}",
      },
    ],
  },
  completionClauses: {
    column: ["SHOW", "WHERE", "GROUP BY", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatShopifyIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How ShopifyQL text is read: grammar, statement text, redaction and completion. */
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
