/**
 * The DuckDB statement the cross-join editor writes.
 *
 * Each table is a saved-query ID. Columns are quoted because the private DuckDB table
 * keeps the spelling the saved query returned, and an unquoted name would be folded.
 */

export type CrossJoinKind = "INNER" | "LEFT" | "RIGHT" | "FULL";

export interface JoinTable {
  readonly tableId: string;
  readonly columns: readonly string[];
  readonly star: boolean;
}

export interface CrossJoinDraft {
  /** Null when the two sides are the same saved query. A join needs two tables. */
  readonly sql: string | null;
  readonly note: string;
}

const JOIN_SQL: Record<CrossJoinKind, string> = {
  INNER: "INNER JOIN",
  LEFT: "LEFT JOIN",
  RIGHT: "RIGHT JOIN",
  FULL: "FULL JOIN",
};

function quoteColumn(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface SharedColumn {
  readonly left: string;
  readonly right: string;
}

/** Columns the two lists share, compared without case, each side keeping its own spelling. */
function sharedColumns(left: readonly string[], right: readonly string[]): SharedColumn[] {
  const rightByFold = new Map<string, string>();
  for (const name of right) {
    const key = name.toLowerCase();
    if (!rightByFold.has(key)) rightByFold.set(key, name);
  }
  const pairs: SharedColumn[] = [];
  const seen = new Set<string>();
  for (const name of left) {
    const key = name.toLowerCase();
    const match = rightByFold.get(key);
    if (match === undefined || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ left: name, right: match });
  }
  return pairs;
}

function starNote(table: JoinTable): string | null {
  if (!table.star) return null;
  return `${table.tableId} uses SELECT *, so its columns stay hidden. Name them in that saved query to match a key.`;
}

/** The statement and the one sentence that says how the ON clause was chosen. */
export function crossJoinDraft(left: JoinTable, right: JoinTable, kind: CrossJoinKind): CrossJoinDraft {
  if (left.tableId.toLowerCase() === right.tableId.toLowerCase()) {
    return { sql: null, note: "Pick two different saved queries." };
  }
  const pairs = sharedColumns(left.columns, right.columns);
  const comparisons = pairs.map(
    (pair) => `${left.tableId}.${quoteColumn(pair.left)} = ${right.tableId}.${quoteColumn(pair.right)}`,
  );
  const on = pairs.length === 0 ? "ON " : `ON ${comparisons.join("\n  AND ")}`;
  const sql = `SELECT *\nFROM ${left.tableId}\n${JOIN_SQL[kind]} ${right.tableId}\n${on}`;
  const hidden = starNote(left) ?? starNote(right);
  if (hidden !== null) return { sql, note: hidden };
  if (pairs.length === 0) {
    return { sql, note: "These queries do not share a column name. Finish the ON clause in the editor." };
  }
  const names = pairs.map((pair) => pair.left).join(" and ");
  return { sql, note: `Joins on ${names}.` };
}
