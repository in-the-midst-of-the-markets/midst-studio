/**
 * Whether `sql` names the `saved` schema outside of comments and quotes.
 *
 * This only decides which route runs the statement. The server parses it again as DuckDB
 * and is the authority on which saved queries it reads. A word inside a string or a
 * comment is not a table, so `SELECT 'saved.orders'` stays on the connection's own route.
 */

function isIdentStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function skipLine(sql: string, index: number): number {
  const end = sql.indexOf("\n", index);
  return end < 0 ? sql.length : end + 1;
}

function skipBlock(sql: string, index: number): number {
  const end = sql.indexOf("*/", index + 2);
  return end < 0 ? sql.length : end + 2;
}

function skipQuoted(sql: string, index: number, quote: string): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return sql.length;
}

/** True when the statement mentions `saved.` as a schema qualifier. */
export function mentionsSavedSchema(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "-" && sql[index + 1] === "-") {
      index = skipLine(sql, index);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = skipBlock(sql, index);
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (isIdentStart(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && isIdentPart(sql[index] ?? "")) index += 1;
      if (sql.slice(start, index).toLowerCase() === "saved") {
        let after = index;
        while (after < sql.length && /\s/.test(sql[after] ?? "")) after += 1;
        if (sql[after] === ".") return true;
      }
      continue;
    }
    index += 1;
  }
  return false;
}
