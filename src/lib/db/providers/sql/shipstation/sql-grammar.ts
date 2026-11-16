import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { SHIPSTATION_RESOURCES } from "./translate";

/** Order statuses the list documents, written as the quoted literals a filter accepts. */
const SHIPSTATION_STATUSES = [
  "'awaiting_payment'",
  "'awaiting_shipment'",
  "'pending_fulfillment'",
  "'shipped'",
  "'on_hold'",
  "'cancelled'",
  "'rejected_fulfillment'",
];

const SHIPSTATION_LISTS = SHIPSTATION_RESOURCES.map((entry) => entry.name);
const SHIPSTATION_COLUMNS = [
  ...new Set(SHIPSTATION_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name))),
].sort();
const SHIPSTATION_FILTERS = [...new Set(SHIPSTATION_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();

/**
 * The SQL the ShipStation editor reads. ShipStation itself has list endpoints,
 * not this subset; the provider translates it. Completion offers only the words
 * that subset runs, the lists this connection reads, and the filters those lists accept.
 */
const SHIPSTATION_GRAMMAR: SqlGrammar = {
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
        label: "Orders awaiting shipment",
        insertText:
          "SELECT ${1:OrderId}, ${2:OrderNumber}, ${3:OrderStatus}, ${4:OrderTotal}\nFROM \"Order\"\nWHERE OrderStatus = '${5:awaiting_shipment}'\nLIMIT ${6:100}",
      },
      {
        label: "Shipments",
        insertText:
          "SELECT ${1:ShipmentId}, ${2:OrderNumber}, ${3:TrackingNumber}, ${4:ShipDate}\nFROM Shipment\nWHERE ShipDateStart = '${5:2024-07-01}'\nLIMIT ${6:100}",
      },
      {
        label: "Products",
        insertText:
          "SELECT ${1:ProductId}, ${2:Sku}, ${3:Name}, ${4:Price}\nFROM Product\nWHERE SKU = '${5:BEAU-000}'\nLIMIT ${6:100}",
      },
      {
        label: "Stores",
        insertText: "SELECT ${1:StoreId}, ${2:StoreName}, ${3:MarketplaceName}\nFROM Store",
      },
      {
        label: "Count orders",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM \"Order\"\nWHERE OrderStatus = '${1:awaiting_shipment}'",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: SHIPSTATION_LISTS, when: "any", detail: "List" },
      SELECT: { words: SHIPSTATION_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...SHIPSTATION_FILTERS, ...SHIPSTATION_STATUSES], when: "any", detail: "Filter" },
    },
  },
};

function formatShipStationIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How ShipStation statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SHIPSTATION_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SHIPSTATION_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatShipStationIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
