import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Databricks SQL as its public reference describes it. A live warehouse was not
 * measured. Comments are `--` and a block comment. `#` is left as code, because the
 * reference's comment forms do not include it. Names are backtick-quoted.
 * `//` is not a comment. A string is single-quoted, and a quote inside it is
 * written twice. A backslash is left as data: the reference's string form does
 * not say a backslash escapes, and a live warehouse was not measured.
 */
const DATABRICKS_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
  // sql-formatter's MySQL language quotes a name in backticks, which is the form the reference writes.
  formatterLanguage: "mysql",
  completionWords: {
    keywords: [
      "MERGE INTO",
      "QUALIFY",
      "OPTIMIZE",
      "VACUUM",
      "CLUSTER BY",
      "DISTRIBUTE BY",
      "TABLESAMPLE",
      "PIVOT",
      "UNPIVOT",
      "LATERAL VIEW",
    ],
    functions: [
      "CURRENT_CATALOG",
      "CURRENT_SCHEMA",
      "CURRENT_VERSION",
      "DATEADD",
      "DATEDIFF",
      "DATE_TRUNC",
      "EXPLODE",
      "FROM_JSON",
      "TO_JSON",
      "TRY_CAST",
      "APPROX_COUNT_DISTINCT",
      "FROM_UTC_TIMESTAMP",
    ],
    snippets: [
      {
        label: "LIMIT",
        insertText: "SELECT ${1:*}\nFROM ${2:table_name}\nLIMIT ${3:100};",
      },
      {
        label: "MERGE INTO",
        insertText:
          "MERGE INTO ${1:target} AS t\nUSING ${2:source} AS s\nON t.${3:id} = s.${3:id}\nWHEN MATCHED THEN UPDATE SET ${4:t.col = s.col}\nWHEN NOT MATCHED THEN INSERT (${5:col}) VALUES (${6:s.col});",
      },
    ],
  },
  completionClauses: {
    column: ["QUALIFY", "CLUSTER BY", "DISTRIBUTE BY"],
    table: ["MERGE INTO", "LATERAL VIEW"],
  },
};

/** How Databricks SQL statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DATABRICKS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DATABRICKS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: "`" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
