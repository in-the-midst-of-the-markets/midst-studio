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
