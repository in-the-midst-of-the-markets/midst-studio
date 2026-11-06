import { selectListColumns } from "@/lib/editor/sql-scope";
import { readSqlSpan, type SqlSpanKind } from "@/lib/sql/spans";

/**
 * What a saved query's select list tells the DuckDB editor.
 *
 * The join never runs the saved query to learn its columns. The names are the ones the
 * select list itself yields. A `*` hides the rest, so a join cannot match a key through it.
 */
export interface SavedQueryShape {
  readonly columns: readonly string[];
  readonly star: boolean;
}

const HIDDEN: ReadonlySet<SqlSpanKind> = new Set(["line-comment", "block-comment", "string", "dollar-string"]);

/** Comments and strings become spaces, so a comma inside either cannot split the select list. */
function blankSql(sql: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index);
    const end = span?.end ?? index + 1;
    out.push(span !== null && HIDDEN.has(span.kind) ? " ".repeat(end - index) : sql.slice(index, end));
    index = end;
  }
  return out.join("");
}

/** The output names of one saved query, folded duplicates dropped, and whether it uses `*`. */
export function savedQueryShape(sql: string): SavedQueryShape {
  const listed = selectListColumns(blankSql(sql));
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const name of listed.columns) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push(name);
  }
  return { columns, star: listed.star };
}
