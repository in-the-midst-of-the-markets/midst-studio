import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * CockroachDB SQL as the cluster accepts it in the editor: comments are `--` and
 * block comments, names are double-quoted, and `//` is not a comment. Block comments
 * are read flat. `#` is left as code.
 */
const COCKROACH_GRAMMAR: SqlGrammar = {
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
    keywords: ["INVERTED", "STORING", "FAMILY", "INTERLEAVE"],
    functions: ["now", "current_timestamp", "experimental_strftime"],
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ${1:column_name}\nFROM ${2:schema}.${3:table_name}\nLIMIT ${4:100};",
      },
    ],
  },
  completionClauses: {
    column: ["INVERTED", "STORING"],
    table: [],
  },
};

/** How CockroachDB statement text is read: grammar, SQL text, redaction and completion. */
export const COCKROACH_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: COCKROACH_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
