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
    values: {
      TIMESERIES: { words: ["hour", "day", "week", "month", "quarter", "year"], when: "first", detail: "Time step" },
      DURING: {
        words: [
          "today",
          "yesterday",
          "this_week",
          "this_month",
          "this_quarter",
          "this_year",
          "last_week",
          "last_month",
          "last_quarter",
          "last_year",
        ],
        when: "first",
        detail: "Date range",
      },
      "COMPARE TO": {
        words: ["previous_period", "previous_week", "previous_month", "previous_quarter", "previous_year"],
        when: "first",
        detail: "Comparison",
      },
      SINCE: { words: ["today", "yesterday", "-7d", "-30d", "-12m", "-1y"], when: "first", detail: "Date" },
      UNTIL: { words: ["today", "yesterday", "-7d", "-30d", "-12m"], when: "first", detail: "Date" },
      VISUALIZE: {
        words: ["bar", "line", "stacked_bar", "stacked_area", "donut", "single_metric", "list", "horizontal_bar"],
        when: "first",
        detail: "Chart",
      },
      TYPE: {
        words: ["bar", "line", "stacked_bar", "stacked_area", "donut", "single_metric", "list", "horizontal_bar"],
        when: "first",
        detail: "Chart",
      },
      WITH: {
        words: ["totals", "group_totals", "percent_change", "cumulative_values"],
        when: "first",
        detail: "Modifier",
      },
    },
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
