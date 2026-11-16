import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { CIN7_RESOURCES } from "./translate";

/** Status words the External API documents, written as the quoted literals a filter accepts. */
const CIN7_STATUSES = [
  "'AUTHORISED'",
  "'DRAFT'",
  "'VOIDED'",
  "'ORDERED'",
  "'BACKORDERED'",
  "'COMPLETED'",
  "'INVOICED'",
  "'PAID'",
  "'UNPAID'",
];

const CIN7_LISTS = CIN7_RESOURCES.map((entry) => entry.name);
const CIN7_COLUMNS = [...new Set(CIN7_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name)))].sort();
const CIN7_FILTERS = [...new Set(CIN7_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();

/**
 * The SQL the Cin7 Core editor reads. Cin7 Core itself has list endpoints, not this
 * subset; the provider translates it. Completion offers only the words that subset runs,
 * the lists this connection reads, and the filters those lists accept.
 */
const CIN7_GRAMMAR: SqlGrammar = {
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
        label: "Stock on hand",
        insertText:
          "SELECT ${1:SKU}, ${2:Name}, ${3:Location}, ${4:OnHand}, ${5:Available}\nFROM Stock\nWHERE SKU = '${6:ABC}'\nLIMIT ${7:100}",
      },
      {
        label: "Open sales",
        insertText:
          "SELECT ${1:OrderNumber}, ${2:Customer}, ${3:Status}, ${4:InvoiceAmount}, ${5:PaidAmount}\nFROM Sale\nWHERE Status = '${6:ORDERED}'\nLIMIT ${7:100}",
      },
      {
        label: "Open purchases",
        insertText:
          "SELECT ${1:OrderNumber}, ${2:Supplier}, ${3:Status}, ${4:InvoiceAmount}\nFROM Purchase\nWHERE OrderStatus = '${5:AUTHORISED}'\nLIMIT ${6:100}",
      },
      {
        label: "Product",
        insertText:
          "SELECT ${1:SKU}, ${2:Name}, ${3:Category}, ${4:Brand}, ${5:AverageCost}\nFROM Product\nWHERE SKU = '${6:ABC}'\nLIMIT ${7:100}",
      },
      { label: "Count", insertText: "SELECT COUNT(*) AS totalCount\nFROM ${1:Product}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: CIN7_LISTS, when: "any", detail: "List" },
      SELECT: { words: CIN7_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...CIN7_FILTERS, ...CIN7_STATUSES], when: "any", detail: "Filter" },
    },
  },
};

function formatCin7Identifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Cin7 Core statement text is read: grammar, SQL text, redaction, update target and completion. */
export const CIN7_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: CIN7_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatCin7Identifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
