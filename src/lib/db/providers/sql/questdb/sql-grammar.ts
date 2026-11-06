import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * QuestDB SQL as its reference describes it: comments are `--` and block comments,
 * names are double-quoted, and `//` is not a comment. `#` is left as code because
 * the reference's comment forms do not include it, which is the reading that does
 * not hide the rest of a line.
 */
const QUESTDB_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
  // sql-formatter's PostgreSQL language rejects `SAMPLE BY 1h` (`Unexpected "1h"`). Its MySQL language keeps the
  // interval in one token, and it leaves a double-quoted name quoted.
  formatterLanguage: "mysql",
  // QuestDB's own clauses and the functions a time-series query reaches for first, from QuestDB's SQL reference.
  completionWords: {
    keywords: [
      "SAMPLE BY",
      "FILL",
      "ALIGN TO CALENDAR",
      "ALIGN TO FIRST OBSERVATION",
      "LATEST ON",
      "ASOF JOIN",
      "LT JOIN",
      "SPLICE JOIN",
      "HORIZON JOIN",
      "WINDOW JOIN",
      "DECLARE",
      "TIMESTAMP",
      "SYMBOL",
      "ROLLUP",
      "CUBE",
      "GROUPING SETS",
      "TOLERANCE",
    ],
    functions: [
      "DATEADD",
      "DATEDIFF",
      "TIMESTAMP_FLOOR",
      "TIMESTAMP_CEIL",
      "TO_TIMESTAMP",
      "TO_STR",
      "TO_TIMEZONE",
      "TO_UTC",
      "TODAY",
      "TOMORROW",
      "YESTERDAY",
      "SYSTIMESTAMP",
      "SYSDATE",
      "HOUR",
      "MINUTE",
      "SECOND",
      "DAY",
      "MONTH",
      "YEAR",
      "DAY_OF_WEEK",
      "WEEK_OF_YEAR",
      "FIRST",
      "LAST",
      "FIRST_NOT_NULL",
      "LAST_NOT_NULL",
      "KSUM",
      "NSUM",
      "TWAP",
      "APPROX_PERCENTILE",
      "STRING_AGG",
    ],
    snippets: [
      {
        label: "SAMPLE BY",
        insertText: "SELECT ${1:ts}, avg(${2:value})\nFROM ${3:table_name}\nSAMPLE BY ${4:1h};",
      },
      {
        label: "LATEST ON",
        insertText: "SELECT *\nFROM ${1:table_name}\nLATEST ON ${2:ts} PARTITION BY ${3:key};",
      },
      {
        label: "ASOF JOIN",
        insertText: "SELECT ${1:*}\nFROM ${2:left_table} l\nASOF JOIN ${3:right_table} r ON l.${4:key} = r.${4:key};",
      },
    ],
  },
  // `LATEST ON` and `PARTITION BY` name columns. `SAMPLE BY` is not a table position. The time-series joins name a
  // table, the way `JOIN` does.
  completionClauses: {
    column: ["LATEST ON", "PARTITION BY", "SAMPLE BY"],
    table: ["ASOF JOIN", "LT JOIN", "SPLICE JOIN", "HORIZON JOIN", "WINDOW JOIN"],
  },
};

/** How QuestDB statement text is read: grammar, SQL text, redaction, update target and completion. */
export const QUESTDB_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: QUESTDB_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
