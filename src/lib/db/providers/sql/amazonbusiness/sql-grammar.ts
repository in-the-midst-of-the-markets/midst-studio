import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { AMAZON_BUSINESS_RESOURCES } from "./translate";

/** Regions the product search documents, written as the quoted literals a filter accepts. */
const AMAZON_REGIONS = ["'US'", "'CA'", "'MX'", "'UK'", "'DE'", "'FR'", "'IT'", "'ES'", "'IN'", "'JP'", "'AU'"];

const AMAZON_LISTS = AMAZON_BUSINESS_RESOURCES.map((entry) => entry.name);
const AMAZON_COLUMNS = [
  ...new Set(AMAZON_BUSINESS_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name))),
].sort();
const AMAZON_FILTERS = [...new Set(AMAZON_BUSINESS_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();

/**
 * The SQL the Amazon Business editor reads. Amazon Business itself has list
 * endpoints, not this subset; the provider translates it. Completion offers only
 * the words that subset runs, the lists this connection reads, and the filters
 * those lists accept.
 */
const AMAZON_BUSINESS_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "Search products",
        insertText:
          "SELECT ${1:ASIN}, ${2:Title}, ${3:Price}, ${4:Currency}\nFROM Product\nWHERE Keywords = '${5:paper}'\nLIMIT ${6:24}",
      },
      {
        label: "One product",
        insertText:
          "SELECT ${1:ASIN}, ${2:Title}, ${3:Price}, ${4:Merchant}\nFROM Product\nWHERE ASIN = '${5:B06XC9321S}'",
      },
      {
        label: "Orders in a day",
        insertText:
          "SELECT ${1:OrderId}, ${2:OrderDate}, ${3:OrderStatus}, ${4:NetTotal}, ${5:Currency}\nFROM \"Order\"\nWHERE StartDate = '${6:2024-07-18T00:00:00Z}' AND EndDate = '${7:2024-07-18T23:59:59Z}'\nLIMIT ${8:100}",
      },
      {
        label: "Order lines",
        insertText:
          "SELECT ${1:OrderId}, ${2:ASIN}, ${3:Title}, ${4:Quantity}, ${5:Price}\nFROM LineItem\nWHERE StartDate = '${6:2024-07-18T00:00:00Z}' AND EndDate = '${7:2024-07-18T23:59:59Z}'\nLIMIT ${8:100}",
      },
      {
        label: "Transactions",
        insertText:
          "SELECT ${1:TransactionId}, ${2:TransactionDate}, ${3:Amount}, ${4:Currency}\nFROM Transaction\nWHERE FeedStartDate = '${5:2024-07-01T00:00:00Z}' AND FeedEndDate = '${6:2024-07-31T23:59:59Z}'\nLIMIT ${7:100}",
      },
      {
        label: "Count products",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM Product\nWHERE Keywords = '${1:paper}'",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: AMAZON_LISTS, when: "any", detail: "List" },
      SELECT: { words: AMAZON_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...AMAZON_FILTERS, ...AMAZON_REGIONS], when: "any", detail: "Filter" },
    },
  },
};

function formatAmazonBusinessIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Amazon Business statement text is read: grammar, SQL text, redaction, update target and completion. */
export const AMAZONBUSINESS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: AMAZON_BUSINESS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatAmazonBusinessIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
