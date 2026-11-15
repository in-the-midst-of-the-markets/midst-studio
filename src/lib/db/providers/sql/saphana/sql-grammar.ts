import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * SAP HANA SQL as the public SQL reference describes it: comments are `--` and
 * non-nesting block comments, names are double-quoted, and `//` is not a comment.
 * `#` is left as code because the reference's comment forms do not include it.
 */
const SAPHANA_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
  // sql-formatter's Snowflake language keeps a double-quoted name quoted, which is how HANA quotes a name.
  formatterLanguage: "snowflake",
  // Clauses and functions a HANA query reaches for first, from the public SQL reference.
  completionWords: {
    keywords: ["TOP", "UPSERT", "MERGE INTO", "WITH HINT", "SERIES"],
    functions: [
      "ADD_DAYS",
      "ADD_MONTHS",
      "DAYS_BETWEEN",
      "CURRENT_DATE",
      "CURRENT_TIMESTAMP",
      "CURRENT_UTCTIMESTAMP",
      "IFNULL",
      "TO_DATE",
      "TO_TIMESTAMP",
      "TO_DECIMAL",
      "STRING_AGG",
      "LOCATE",
    ],
    snippets: [
      {
        label: "FROM DUMMY",
        insertText: "SELECT ${1:1} FROM DUMMY;",
      },
      {
        label: "LIMIT",
        insertText: "SELECT ${1:*}\nFROM ${2:table_name}\nLIMIT ${3:100};",
      },
    ],
  },
  completionClauses: {
    column: [],
    table: ["MERGE INTO"],
  },
};

/** How SAP HANA statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SAPHANA_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SAPHANA_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
