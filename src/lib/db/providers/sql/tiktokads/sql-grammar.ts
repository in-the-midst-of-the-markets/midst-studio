import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SQL the TikTok Ads editor reads. TikTok Ads itself has no SQL parser; the provider
 * translates a read-only subset into one Marketing API v1.3 list. Completion offers only the words
 * that subset runs.
 */
const TIKTOK_ADS_GRAMMAR: SqlGrammar = {
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
          "SELECT campaign.name, campaign.operation_status\nFROM campaign\nWHERE campaign.operation_status = 'ENABLE'\nORDER BY campaign.name\nLIMIT ${1:100}",
      },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY"],
    table: ["FROM"],
  },
};

function formatTikTokAdsIdentifier(segment: string): string {
  return `"${segment.replaceAll('"', '""')}"`;
}

/** How TikTok Ads statement text is read: grammar, SQL text, redaction, update target and completion. */
export const TIKTOKADS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: TIKTOK_ADS_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatTikTokAdsIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
    nameIsDottedWord: true,
  },
};
