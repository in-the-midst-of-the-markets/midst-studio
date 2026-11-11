import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Amazon Redshift SQL as the cluster accepts it in the editor: comments are `--` and
 * block comments, names are double-quoted, and `//` is not a comment. Block comments
 * are read flat. `#` is left as code.
 */
const REDSHIFT_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
  // sql-formatter's languages here are mysql and snowflake. MySQL leaves a
  // double-quoted name quoted, and a statement it cannot read is left as written.
  formatterLanguage: "mysql",
  completionWords: {
    keywords: ["DISTKEY", "SORTKEY", "DISTSTYLE", "ENCODE", "IDENTITY", "APPROXIMATE", "UNLOAD", "COPY"],
    functions: ["GETDATE", "DATEADD", "DATEDIFF", "LISTAGG", "NVL", "CONVERT_TIMEZONE"],
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ${1:column_name}\nFROM ${2:schema}.${3:table_name}\nLIMIT ${4:100};",
      },
    ],
  },
  completionClauses: {
    column: ["DISTKEY", "SORTKEY"],
    table: [],
  },
};

/** How Amazon Redshift statement text is read: grammar, SQL text, redaction and completion. */
export const REDSHIFT_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: REDSHIFT_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
