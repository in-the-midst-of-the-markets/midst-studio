/**
 * Pieces of a cross-join statement, so the editor can color the SQL keywords.
 *
 * The statement is the one `crossJoinDraft` writes. A line that is not one of
 * those keywords stays plain text.
 */

export interface JoinSqlPiece {
  readonly indent: string;
  readonly keyword: string;
  readonly rest: string;
}

const KEYWORDS = ["INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "SELECT", "FROM", "ON", "AND"] as const;

/** One piece per line. A keyword keeps its spelling, and the rest of the line follows it. */
export function joinSqlPieces(sql: string): JoinSqlPiece[] {
  return sql.split("\n").map((line) => {
    const indentLength = line.length - line.trimStart().length;
    const indent = line.slice(0, indentLength);
    const body = line.slice(indentLength);
    for (const keyword of KEYWORDS) {
      if (!body.startsWith(keyword)) continue;
      return { indent, keyword, rest: body.slice(keyword.length) };
    }
    return { indent, keyword: "", rest: body };
  });
}
