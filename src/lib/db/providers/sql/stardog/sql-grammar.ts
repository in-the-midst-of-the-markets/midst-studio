import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The SPARQL the Stardog editor reads. Completion offers only the words a read
 * runs (`lists: "only"`), and a class after `a`, so a suggestion is a query
 * this connection can run.
 */
const STARDOG_GRAMMAR: SqlGrammar = {
  ...DEFAULT_SQL_GRAMMAR,
  hash: "comment",
  bracket: "subscript",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  formatterLanguage: "mysql",
  completionWords: {
    keywords: [
      "SELECT",
      "DISTINCT",
      "WHERE",
      "OPTIONAL",
      "FILTER",
      "BIND",
      "VALUES",
      "ORDER BY",
      "ASC",
      "DESC",
      "LIMIT",
      "OFFSET",
      "GROUP BY",
      "HAVING",
      "UNION",
      "ASK",
      "PREFIX",
      "a",
      "AS",
    ],
    functions: ["BOUND", "STR", "IRI", "REGEX", "CONTAINS", "COUNT", "SUM", "MIN", "MAX", "AVG"],
    lists: "only",
    snippets: [
      {
        label: "SELECT",
        insertText: "SELECT ?s ?o\nWHERE {\n  ?s a <${1:http://example.org/Person}> ;\n     ?p ?o\n}\nLIMIT ${2:50}",
      },
      { label: "ASK", insertText: "ASK WHERE {\n  ?s a <${1:http://example.org/Person}>\n}" },
    ],
  },
  completionClauses: {
    column: ["SELECT", "WHERE", "ORDER BY", "FILTER", "GROUP BY"],
    table: ["FROM"],
    tableAfter: ["a"],
  },
};

function formatStardogIdentifier(segment: string): string {
  if (/^(?:https?:\/\/|urn:)/.test(segment)) return `<${segment}>`;
  return segment;
}

/** How Stardog statement text is read: grammar, SPARQL text, redaction and completion. */
export const STARDOG_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: STARDOG_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: {
    formatSegment: formatStardogIdentifier,
    readQuotedQualifier: (textToDot) =>
      textToDot.match(/<([^>]+)>\.$/)?.[1] ?? textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
