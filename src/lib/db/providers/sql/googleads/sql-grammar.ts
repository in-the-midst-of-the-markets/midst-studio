import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the Google Ads editor reads. Google Ads itself has no SQL parser; the provider
 * translates a read-only subset into Google Ads Query Language. Completion offers only the
 * words that subset runs.
 */
const GOOGLEADS_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "code",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: [
      "SELECT",
      "FROM",
      "WHERE",
      "AND",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "LIKE",
      "IS NULL",
      "IS NOT NULL",
    ],
    functions: [],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText:
          "SELECT campaign.name, metrics.clicks\nFROM campaign\nWHERE campaign.status = 'ENABLED'\nORDER BY metrics.clicks DESC\nLIMIT ${1:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatGoogleAdsIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How Google Ads statement text is read: grammar, SQL text, redaction, update target and completion. */
export const GOOGLEADS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: GOOGLEADS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatGoogleAdsIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
