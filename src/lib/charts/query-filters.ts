/**
 * Filters a chart query carries, and the literals a run substitutes for them.
 *
 * A placeholder sits where a literal would: `{{region:east|east,west}}`. The chart
 * section edits the default. The statement that runs has a SQL literal in its place,
 * so a value cannot change the statement around it. The same name shares one control.
 */

export interface QueryFilter {
  readonly name: string;
  readonly value: string;
  readonly options: readonly string[];
}

const VALUE_CAP = 200;
const OPTION_CAP = 80;
const OPTIONS_CAP = 24;

interface FilterToken {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly value: string;
  readonly options: readonly string[];
}

function parseBody(body: string): Omit<FilterToken, "start" | "end"> | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*(?::([^|]*))?(?:\|(.*))?\s*$/.exec(body);
  const name = match?.[1];
  if (name === undefined) return null;
  const value = (match?.[2] ?? "").trim().slice(0, VALUE_CAP);
  const options: string[] = [];
  const listed = match?.[3];
  if (listed !== undefined) {
    for (const part of listed.split(",")) {
      const option = part.trim().slice(0, OPTION_CAP);
      if (option === "" || /[\r\n|}]/.test(option)) continue;
      options.push(option);
      if (options.length === OPTIONS_CAP) break;
    }
  }
  return { name, value, options };
}

/** Placeholders in code. Ones inside a quote or a comment are text, not filters. */
function tokensIn(sql: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    if (quote !== null) {
      if (current === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (current === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }
    if (current === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current !== "{" || sql[index + 1] !== "{") continue;
    const end = sql.indexOf("}}", index + 2);
    if (end < 0) break;
    const parsed = parseBody(sql.slice(index + 2, end));
    if (parsed !== null) tokens.push({ start: index, end: end + 2, ...parsed });
    index = end + 1;
  }
  return tokens;
}

function sqlLiteral(value: string, options: readonly string[]): string {
  if (options.length === 0 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  return `'${value.split("'").join("''")}'`;
}

/** One control per name, in the order the placeholders appear. */
export function readQueryFilters(sql: string): QueryFilter[] {
  const filters: QueryFilter[] = [];
  const seen = new Set<string>();
  for (const token of tokensIn(sql)) {
    if (seen.has(token.name)) continue;
    seen.add(token.name);
    filters.push({ name: token.name, value: token.value, options: token.options });
  }
  return filters;
}

/** The statement a run sends. Text with no placeholders is returned unchanged. */
export function applyQueryFilters(sql: string): string {
  const tokens = tokensIn(sql);
  if (tokens.length === 0) return sql;
  let next = "";
  let cursor = 0;
  for (const token of tokens) {
    next += sql.slice(cursor, token.start);
    next += sqlLiteral(token.value, token.options);
    cursor = token.end;
  }
  return next + sql.slice(cursor);
}

/** The statement with filter defaults removed, so two values of one filter compare equal. */
export function queryFilterShape(sql: string): string {
  const tokens = tokensIn(sql);
  if (tokens.length === 0) return sql.trim();
  let next = sql;
  for (const token of [...tokens].reverse()) {
    const body = token.options.length === 0 ? token.name : `${token.name}|${token.options.join(",")}`;
    next = `${next.slice(0, token.start)}{{${body}}}${next.slice(token.end)}`;
  }
  return next.trim();
}

/**
 * The statement aside from spacing, a trailing semicolon, and a trailing LIMIT.
 * Quoted text keeps its case: a rewritten query can still recolor the chart it came from.
 */
export function queryIdentity(sql: string): string {
  return queryFilterShape(sql)
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .replace(/\s+limit\s+\d+(?:\s+offset\s+\d+)?\s*$/i, "")
    .trim();
}

/** Writes one filter's value back into every placeholder of that name. */
export function writeQueryFilter(sql: string, name: string, value: string): string {
  const clean = value
    .replace(/[|}\r\n]/g, "")
    .trim()
    .slice(0, VALUE_CAP);
  const tokens = tokensIn(sql);
  let next = sql;
  let wrote = false;
  for (const token of [...tokens].reverse()) {
    if (token.name !== name) continue;
    wrote = true;
    const options = token.options.length > 0 ? `|${token.options.join(",")}` : "";
    const body = clean === "" && options === "" ? token.name : `${token.name}:${clean}${options}`;
    next = `${next.slice(0, token.start)}{{${body}}}${next.slice(token.end)}`;
  }
  return wrote ? next : sql;
}
