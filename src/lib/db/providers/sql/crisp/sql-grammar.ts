import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { CRISP_RESOURCES } from "./translate";

const CRISP_LISTS = CRISP_RESOURCES.map((entry) => entry.name);
const CRISP_COLUMNS = [
  ...new Set(CRISP_RESOURCES.flatMap((entry) => entry.columns.map((column) => column.name))),
].sort();
const CRISP_FILTERS = [...new Set(CRISP_RESOURCES.flatMap((entry) => Object.keys(entry.filters)))].sort();

/**
 * The SQL the Crisp editor reads. Crisp itself has list endpoints, not this
 * subset; the provider translates it. Completion offers only the words that
 * subset runs, the lists this connection reads, and the filters those lists accept.
 */
const CRISP_GRAMMAR: SqlGrammar = {
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
        label: "Unresolved conversations",
        insertText:
          "SELECT ${1:SessionId}, ${2:State}, ${3:Nickname}, ${4:Email}\nFROM Conversation\nWHERE FilterNotResolved = '${5:1}'\nLIMIT ${6:20}",
      },
      {
        label: "Conversations in a date window",
        insertText:
          "SELECT ${1:SessionId}, ${2:LastMessage}, ${3:UpdatedAt}\nFROM Conversation\nWHERE FilterDateStart = '${4:2024-07-01T00:00:00Z}' AND FilterDateEnd = '${5:2024-07-31T00:00:00Z}'\nLIMIT ${6:20}",
      },
      {
        label: "People",
        insertText:
          "SELECT ${1:PeopleId}, ${2:Email}, ${3:Nickname}, ${4:Company}\nFROM People\nWHERE SearchText = '${5:acme}'\nLIMIT ${6:20}",
      },
      {
        label: "Operators",
        insertText: "SELECT ${1:UserId}, ${2:Email}, ${3:Role}, ${4:Availability}\nFROM Operator",
      },
      {
        label: "Count operators",
        insertText: "SELECT COUNT(*) AS totalCount\nFROM Operator",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE"],
    table: ["FROM"],
    values: {
      FROM: { words: CRISP_LISTS, when: "any", detail: "List" },
      SELECT: { words: CRISP_COLUMNS, when: "any", detail: "Column" },
      WHERE: { words: [...CRISP_FILTERS, "'0'", "'1'"], when: "any", detail: "Filter" },
    },
  },
};

function formatCrispIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Crisp statement text is read: grammar, SQL text, redaction, update target and completion. */
export const CRISP_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: CRISP_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatCrispIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
