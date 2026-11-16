import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { DATADOG_RESOURCES } from "./translate";

const DATADOG_LISTS = DATADOG_RESOURCES.map((entry) => entry.name);
const DATADOG_COLUMNS = [
  ...new Set(DATADOG_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name))),
].sort();
const DATADOG_FILTERS = [...new Set(DATADOG_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();
const DATADOG_VALUES = ["'Alert'", "'Warn'", "'OK'", "'No Data'", "'true'", "'false'", "'asc'", "'desc'"];

/**
 * The SQL the Datadog editor reads. Datadog itself has list endpoints, not this
 * subset; the provider translates it. Completion offers only the words that
 * subset runs, the lists this connection reads, and the filters those lists accept.
 */
const DATADOG_GRAMMAR: SqlGrammar = {
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
        label: "Monitors in alert",
        insertText:
          "SELECT ${1:Id}, ${2:Name}, ${3:Status}, ${4:Type}\nFROM Monitor\nWHERE Status = '${5:Alert}'\nLIMIT ${6:30}",
      },
      {
        label: "Monitor search",
        insertText:
          "SELECT ${1:Id}, ${2:Name}, ${3:Query}, ${4:Tags}\nFROM Monitor\nWHERE Query = '${5:type:metric}'\nLIMIT ${6:30}",
      },
      {
        label: "Count alerting monitors",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM Monitor\nWHERE Status = '${1:Alert}'",
      },
      {
        label: "Hosts",
        insertText:
          "SELECT ${1:Name}, ${2:Up}, ${3:Cpu}, ${4:Platform}, ${5:Tags}\nFROM Host\nWHERE Filter = '${6:env:prod}'\nLIMIT ${7:100}",
      },
      {
        label: "Count hosts",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM Host",
      },
      {
        label: "Dashboards",
        insertText: "SELECT ${1:Id}, ${2:Title}, ${3:AuthorHandle}, ${4:LayoutType}\nFROM Dashboard\nLIMIT ${5:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: DATADOG_LISTS, when: "any", detail: "List" },
      SELECT: { words: DATADOG_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...DATADOG_FILTERS, ...DATADOG_VALUES], when: "any", detail: "Filter" },
    },
  },
};

function formatDatadogIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Datadog statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DATADOG_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DATADOG_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatDatadogIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
