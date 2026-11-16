import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { SHIPBOB_RESOURCES } from "./translate";

/** Sort orders the order list documents, written as the quoted literals a filter accepts. */
const SHIPBOB_SORTS = ["'Newest'", "'Oldest'"];

const SHIPBOB_LISTS = SHIPBOB_RESOURCES.map((entry) => entry.name);
const SHIPBOB_COLUMNS = [
  ...new Set(SHIPBOB_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name))),
].sort();
const SHIPBOB_FILTERS = [...new Set(SHIPBOB_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();

/**
 * The SQL the ShipBob editor reads. ShipBob itself has list endpoints, not this
 * subset; the provider translates it. Completion offers only the words that
 * subset runs, the lists this connection reads, and the filters those lists accept.
 */
const SHIPBOB_GRAMMAR: SqlGrammar = {
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
        label: "Orders",
        insertText:
          "SELECT ${1:Id}, ${2:OrderNumber}, ${3:Status}, ${4:RecipientCity}\nFROM \"Order\"\nWHERE StartDate = '${5:2024-07-18T00:00:00Z}' AND EndDate = '${6:2024-07-19T00:00:00Z}'\nLIMIT ${7:100}",
      },
      {
        label: "Products",
        insertText: "SELECT ${1:Id}, ${2:Name}, ${3:Sku}\nFROM Product\nWHERE SKU = '${4:WIDGET}'\nLIMIT ${5:50}",
      },
      {
        label: "Inventory",
        insertText:
          "SELECT ${1:InventoryId}, ${2:Sku}, ${3:Fulfillable}, ${4:OnHand}\nFROM Inventory\nWHERE IsActive = true\nLIMIT ${5:100}",
      },
      {
        label: "Channels",
        insertText: "SELECT ${1:Id}, ${2:Name}, ${3:ApplicationName}\nFROM Channel",
      },
      {
        label: "Count channels",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM Channel",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: SHIPBOB_LISTS, when: "any", detail: "List" },
      SELECT: { words: SHIPBOB_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...SHIPBOB_FILTERS, ...SHIPBOB_SORTS], when: "any", detail: "Filter" },
    },
  },
};

function formatShipBobIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How ShipBob statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SHIPBOB_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SHIPBOB_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatShipBobIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
