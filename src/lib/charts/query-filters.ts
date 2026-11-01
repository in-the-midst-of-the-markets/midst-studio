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

const CLAUSE_START = new Set(["where", "having"]);
const CLAUSE_END = new Set([
  "group",
  "order",
  "limit",
  "union",
  "except",
  "intersect",
  "window",
  "fetch",
  "offset",
  "qualify",
  "for",
]);

interface FilterLiteral {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly value: string;
}

function filterName(text: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(text)) return null;
  return text;
}

function readQuoted(sql: string, index: number, quote: "'" | '"' | "`"): { value: string; end: number } | null {
  let value = "";
  for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
    const current = sql[cursor] ?? "";
    if (current === quote) {
      if (sql[cursor + 1] === quote) {
        value += quote;
        cursor += 1;
        continue;
      }
      return { value, end: cursor + 1 };
    }
    value += current;
  }
  return null;
}

function readNumber(sql: string, index: number): { value: string; end: number } | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(sql.slice(index));
  if (match === null) return null;
  const end = index + match[0].length;
  const next = sql[end];
  if (next !== undefined && /[A-Za-z0-9_.]/.test(next)) return null;
  return { value: match[0], end };
}

function wordAt(sql: string, index: number): { word: string; end: number } | null {
  if (!/[A-Za-z_]/.test(sql[index] ?? "")) return null;
  if (index > 0 && /[A-Za-z0-9_]/.test(sql[index - 1] ?? "")) return null;
  let end = index + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  return { word: sql.slice(index, end), end };
}

function readOp(sql: string, index: number): string | null {
  const two = sql.slice(index, index + 2);
  if (two === "<>" || two === "!=" || two === ">=" || two === "<=") return two;
  const one = sql[index];
  if (one === "=" || one === ">" || one === "<") return one;
  return null;
}

/** Comparison literals in WHERE and HAVING. A join condition and the select list stay put. */
function literalsInFilterClauses(sql: string): FilterLiteral[] {
  const hits: FilterLiteral[] = [];
  const stack: number[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let column: string | null = null;
  let pendingOp = false;

  const closeOpened = (atDepth: number) => {
    while (stack.length > 0 && (stack[stack.length - 1] ?? -1) >= atDepth) stack.pop();
    column = null;
    pendingOp = false;
  };

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index] ?? "";
    const inClause = stack.length > 0;
    if (quote !== null) {
      if (current === quote) {
        if (sql[index + 1] === quote && quote !== "`") {
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
    if (inClause && pendingOp && column !== null && (current === "'" || current === '"')) {
      const literal = readQuoted(sql, index, current);
      if (literal === null) break;
      if (literal.value.length <= VALUE_CAP && !/[|}\r\n]/.test(literal.value)) {
        hits.push({ start: index, end: literal.end, name: column, value: literal.value });
      }
      column = null;
      pendingOp = false;
      index = literal.end - 1;
      continue;
    }
    if (inClause && !pendingOp && (current === "`" || current === '"')) {
      const ident = readQuoted(sql, index, current);
      if (ident === null) break;
      column = filterName(ident.value);
      index = ident.end - 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "(") {
      depth += 1;
      column = null;
      pendingOp = false;
      continue;
    }
    if (current === ")") {
      if (depth > 0) depth -= 1;
      closeOpened(depth + 1);
      continue;
    }
    const word = wordAt(sql, index);
    if (word !== null) {
      const lower = word.word.toLowerCase();
      if (CLAUSE_START.has(lower)) {
        closeOpened(depth);
        stack.push(depth);
        index = word.end - 1;
        continue;
      }
      if (CLAUSE_END.has(lower) && stack.length > 0 && stack[stack.length - 1] === depth) {
        closeOpened(depth);
        index = word.end - 1;
        continue;
      }
      if (inClause && !pendingOp) column = filterName(word.word);
      else {
        column = null;
        pendingOp = false;
      }
      index = word.end - 1;
      continue;
    }
    if (current === ".") {
      column = null;
      pendingOp = false;
      continue;
    }
    const op = readOp(sql, index);
    if (op !== null) {
      pendingOp = inClause && column !== null;
      if (!pendingOp) column = null;
      index += op.length - 1;
      continue;
    }
    if (inClause && pendingOp && column !== null) {
      const number = readNumber(sql, index);
      if (number !== null) {
        hits.push({ start: index, end: number.end, name: column, value: number.value });
        column = null;
        pendingOp = false;
        index = number.end - 1;
        continue;
      }
    }
    if (!/\s/.test(current)) {
      column = null;
      pendingOp = false;
    }
  }
  return hits;
}

/**
 * Turns a comparison the model wrote in WHERE or HAVING into a chart filter.
 * `region = 'east'` becomes `region = {{region:east}}`. Text that already has a
 * placeholder, and a statement with nothing to edit, is returned unchanged.
 */
export function promoteQueryFilters(sql: string): string {
  const hits = literalsInFilterClauses(sql);
  if (hits.length === 0) return sql;
  const taken = new Set(tokensIn(sql).map((token) => token.name));
  const named = hits.map((hit) => {
    let name = hit.name;
    let suffix = 2;
    while (taken.has(name)) {
      const tail = `_${suffix}`;
      name = `${hit.name.slice(0, 40 - tail.length)}${tail}`;
      suffix += 1;
    }
    taken.add(name);
    return { start: hit.start, end: hit.end, name, value: hit.value };
  });
  let next = sql;
  for (const hit of [...named].reverse()) {
    next = `${next.slice(0, hit.start)}{{${hit.name}:${hit.value}}}${next.slice(hit.end)}`;
  }
  return next;
}

interface WhereSpot {
  readonly kind: "and" | "where";
  readonly index: number;
}

/** Where a new comparison is inserted: the end of WHERE, or just before the next clause. */
function whereSpot(sql: string): WhereSpot {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let sawWhere = false;
  let clauseEnd: number | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index] ?? "";
    if (quote !== null) {
      if (current === quote) {
        if (sql[index + 1] === quote && quote !== "`") {
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
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (current === ";" && depth === 0) {
      clauseEnd = clauseEnd ?? index;
      break;
    }
    const word = wordAt(sql, index);
    if (word === null) continue;
    const lower = word.word.toLowerCase();
    if (depth === 0 && lower === "where" && !sawWhere) sawWhere = true;
    else if (depth === 0 && (CLAUSE_END.has(lower) || lower === "having")) {
      clauseEnd = index;
      break;
    }
    index = word.end - 1;
  }
  if (sawWhere) return { kind: "and", index: clauseEnd ?? sql.length };
  return { kind: "where", index: clauseEnd ?? sql.length };
}

function filterToken(name: string, value: string, options: readonly string[]): string {
  const clean = value
    .replace(/[|}\r\n]/g, "")
    .trim()
    .slice(0, VALUE_CAP);
  const listed: string[] = [];
  for (const option of options) {
    const text = option
      .replace(/[|}\r\n]/g, "")
      .trim()
      .slice(0, OPTION_CAP);
    if (text === "" || listed.includes(text)) continue;
    listed.push(text);
    if (listed.length === OPTIONS_CAP) break;
  }
  const choices = listed.length > 0 ? `|${listed.join(",")}` : "";
  const body = clean === "" && choices === "" ? name : `${name}:${clean}${choices}`;
  return `${name} = {{${body}}}`;
}

/** Adds one comparison the chart can edit. A name that is already a filter is left as it is. */
export function addQueryFilter(sql: string, name: string, value: string, options: readonly string[] = []): string {
  if (filterName(name) === null || tokensIn(sql).some((token) => token.name === name)) return sql;
  const predicate = filterToken(name, value, options);
  const spot = whereSpot(sql);
  const left = sql.slice(0, spot.index).trimEnd();
  const rest = sql.slice(spot.index).trimStart();
  const joiner = spot.kind === "and" ? " AND " : " WHERE ";
  if (rest === "") return `${left}${joiner}${predicate}`;
  const gap = rest.startsWith(";") ? "" : " ";
  return `${left}${joiner}${predicate}${gap}${rest}`;
}

function opBefore(sql: string, cursor: number): number | null {
  const two = sql.slice(cursor - 2, cursor);
  if (two === "<>" || two === "!=" || two === ">=" || two === "<=") return cursor - 2;
  const one = sql[cursor - 1];
  if (one === "=" || one === ">" || one === "<") return cursor - 1;
  return null;
}

function wordBefore(sql: string, cursor: number): { word: string; start: number } | null {
  let end = cursor;
  while (end > 0 && /\s/.test(sql[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(sql[start - 1] ?? "")) start -= 1;
  if (start === end) return null;
  return { word: sql.slice(start, end), start };
}

function stripPredicate(sql: string, token: FilterToken, name: string): string | null {
  let cursor = token.start;
  while (cursor > 0 && /\s/.test(sql[cursor - 1] ?? "")) cursor -= 1;
  const opAt = opBefore(sql, cursor);
  if (opAt === null) return null;
  cursor = opAt;
  while (cursor > 0 && /\s/.test(sql[cursor - 1] ?? "")) cursor -= 1;
  if (sql.slice(cursor - name.length, cursor) !== name) return null;
  const beforeName = cursor - name.length - 1;
  if (beforeName >= 0 && /[A-Za-z0-9_]/.test(sql[beforeName] ?? "")) return null;
  cursor -= name.length;
  const previous = wordBefore(sql, cursor);
  if (previous?.word.toLowerCase() === "and") {
    const left = sql.slice(0, previous.start).trimEnd();
    const right = sql.slice(token.end).trimStart();
    return right === "" ? left : `${left} ${right}`;
  }
  if (previous?.word.toLowerCase() !== "where") return null;
  let after = token.end;
  while (after < sql.length && /\s/.test(sql[after] ?? "")) after += 1;
  const next = wordAt(sql, after);
  if (next?.word.toLowerCase() === "and") {
    let rest = next.end;
    while (rest < sql.length && /\s/.test(sql[rest] ?? "")) rest += 1;
    return `${sql.slice(0, previous.start)}WHERE ${sql.slice(rest)}`;
  }
  const left = sql.slice(0, previous.start).trimEnd();
  const right = sql.slice(token.end).trimStart();
  return right === "" ? left : `${left} ${right}`;
}

/** Removes one filter and the comparison around it. A placeholder that is not a comparison stays. */
export function removeQueryFilter(sql: string, name: string): string {
  let next = sql;
  for (;;) {
    const token = tokensIn(next).find((item) => item.name === name);
    if (token === undefined) return next;
    const removed = stripPredicate(next, token, name);
    if (removed === null) return sql;
    next = removed;
  }
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
