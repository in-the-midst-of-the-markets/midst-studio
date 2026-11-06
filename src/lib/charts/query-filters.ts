import { embedTokens } from "@/lib/embeddings/placeholder";

/**
 * Filters a chart query carries, and the literals a run substitutes for them.
 *
 * A placeholder sits where a literal would: `{{region:east|east,west}}`. The chart
 * section edits the default. The statement that runs has a SQL literal in its place,
 * so a value cannot change the statement around it. The same name shares one control.
 * `{{text}}` in a vector value is not one of these: that text becomes a vector.
 */

/** The comparisons a metric filter offers. Anything else in the statement stays until the user picks one of these. */
export type FilterCompare = ">=" | "<=" | "=";

export interface QueryFilter {
  readonly name: string;
  readonly value: string;
  readonly options: readonly string[];
  /** The comparison written immediately before this placeholder. A metric filter can change it. */
  readonly compare: FilterCompare;
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

/** Placeholders in code. Ones inside a quote, a comment, or the vector value are text, not filters. */
function tokensIn(sql: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  const vectorEnd = new Map(embedTokens(sql).map((token) => [token.start, token.end]));
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
    const embedded = vectorEnd.get(index);
    if (embedded !== undefined) {
      index = embedded - 1;
      continue;
    }
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

/** A number a metric filter can store and send as an unquoted SQL literal. */
export function isNumericFilterValue(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function compareAt(sql: string, placeholderStart: number): { start: number; op: string } | null {
  let cursor = placeholderStart;
  while (cursor > 0 && /\s/.test(sql[cursor - 1] ?? "")) cursor -= 1;
  const two = sql.slice(cursor - 2, cursor);
  if (two === ">=" || two === "<=" || two === "!=" || two === "<>") return { start: cursor - 2, op: two };
  const one = sql[cursor - 1];
  if (one === "=" || one === ">" || one === "<") return { start: cursor - 1, op: one };
  return null;
}

function filterCompare(op: string | undefined): FilterCompare {
  if (op === ">=" || op === "<=" || op === "=") return op;
  return "=";
}

/** One control per name, in the order the placeholders appear. */
export function readQueryFilters(sql: string): QueryFilter[] {
  const filters: QueryFilter[] = [];
  const seen = new Set<string>();
  for (const token of tokensIn(sql)) {
    if (seen.has(token.name)) continue;
    seen.add(token.name);
    filters.push({
      name: token.name,
      value: token.value,
      options: token.options,
      compare: filterCompare(compareAt(sql, token.start)?.op),
    });
  }
  return filters;
}

/** The number a new metric filter starts from: the first numeric cell, or zero. */
export function metricFilterValue(rows: readonly Record<string, unknown>[], column: string): string {
  for (const row of rows) {
    const value = row[column];
    if (typeof value === "number" && Number.isFinite(value)) {
      const text = String(value);
      if (isNumericFilterValue(text)) return text;
    } else if (typeof value === "string" && isNumericFilterValue(value.trim())) {
      return value.trim();
    }
  }
  return "0";
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
  /** Where the compared column is written, so a select alias can be put back. */
  readonly columnStart: number;
  readonly op: string;
}

/** The column a filter compares, and the text written in front of the placeholder. */
export interface FilterColumn {
  readonly name: string;
  readonly expression: string;
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
  let columnStart = -1;
  let operator = "";
  let pendingOp = false;

  const clearColumn = () => {
    column = null;
    columnStart = -1;
    operator = "";
    pendingOp = false;
  };

  const closeOpened = (atDepth: number) => {
    while (stack.length > 0 && (stack[stack.length - 1] ?? -1) >= atDepth) stack.pop();
    clearColumn();
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
        hits.push({
          start: index,
          end: literal.end,
          name: column,
          value: literal.value,
          columnStart,
          op: operator,
        });
      }
      clearColumn();
      index = literal.end - 1;
      continue;
    }
    if (inClause && !pendingOp && (current === "`" || current === '"')) {
      const ident = readQuoted(sql, index, current);
      if (ident === null) break;
      column = filterName(ident.value);
      columnStart = index;
      index = ident.end - 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "(") {
      depth += 1;
      clearColumn();
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
      if (inClause && !pendingOp) {
        column = filterName(word.word);
        columnStart = index;
      } else clearColumn();
      index = word.end - 1;
      continue;
    }
    if (current === ".") {
      clearColumn();
      continue;
    }
    const op = readOp(sql, index);
    if (op !== null) {
      pendingOp = inClause && column !== null;
      operator = pendingOp ? op : "";
      if (!pendingOp) clearColumn();
      index += op.length - 1;
      continue;
    }
    if (inClause && pendingOp && column !== null) {
      const number = readNumber(sql, index);
      if (number !== null) {
        hits.push({
          start: index,
          end: number.end,
          name: column,
          value: number.value,
          columnStart,
          op: operator,
        });
        clearColumn();
        index = number.end - 1;
        continue;
      }
    }
    if (!/\s/.test(current)) clearColumn();
  }
  return hits;
}

interface AliasMap {
  readonly columns: ReadonlyMap<string, FilterColumn>;
  readonly expressions: ReadonlySet<string>;
  readonly plain: ReadonlySet<string>;
}

function keywordAt(sql: string, index: number, word: string): boolean {
  if (index > 0 && /[A-Za-z0-9_]/.test(sql[index - 1] ?? "")) return false;
  if (!sql.toLowerCase().startsWith(word, index)) return false;
  return !/[A-Za-z0-9_]/.test(sql[index + word.length] ?? " ");
}

function unquoteIdent(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("`") && text.endsWith("`") && text.length >= 2) ||
    (text.startsWith("[") && text.endsWith("]") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function simpleColumn(source: string): FilterColumn | null {
  const match = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(source.trim());
  const name = match?.[2];
  if (name === undefined || filterName(name) === null) return null;
  const qualifier = match?.[1];
  return { name, expression: qualifier === undefined ? name : `${qualifier}.${name}` };
}

/** Comments are not part of a column or its alias. An unclosed comment drops the rest of the text. */
function withoutComments(sql: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index] ?? "";
    if (quote !== null) {
      out += current;
      if (current === quote) {
        if (sql[index + 1] === quote && quote !== "`") {
          out += sql[index + 1] ?? "";
          index += 1;
        } else quote = null;
      }
      continue;
    }
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      out += " ";
      continue;
    }
    if (pair === "/*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 1;
      out += " ";
      continue;
    }
    if (current === "'" || current === '"' || current === "`") quote = current;
    out += current;
  }
  return out;
}

/** The outer select list, or null when a comment never closes. */
function readSelectList(sql: string): string | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let selectAt = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index] ?? "";
    if (quote !== null) {
      if (current === quote) {
        if (sql[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
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
      if (end < 0) return null;
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
    if (depth === 0 && selectAt < 0 && keywordAt(sql, index, "select")) {
      selectAt = index + "select".length;
      index = selectAt - 1;
      continue;
    }
    if (depth === 0 && selectAt >= 0 && keywordAt(sql, index, "from")) return sql.slice(selectAt, index);
  }
  return selectAt < 0 ? null : sql.slice(selectAt);
}

function splitSelectItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index] ?? "";
    if (quote !== null) {
      if (current === quote) {
        if (list[index + 1] === quote && quote !== "`") index += 1;
        else quote = null;
      }
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "(") depth += 1;
    else if (current === ")" && depth > 0) depth -= 1;
    else if (current === "," && depth === 0) {
      items.push(list.slice(start, index));
      start = index + 1;
    }
  }
  items.push(list.slice(start));
  return items;
}

const ALIAS_TAIL = String.raw`(\[[^\]]+\]|"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][A-Za-z0-9_]*)`;
const AS_ALIAS = new RegExp(String.raw`^(.*)\s+as\s+${ALIAS_TAIL}$`, "i");
const BARE_ALIAS = new RegExp(String.raw`^(.*\S)\s+${ALIAS_TAIL}$`, "i");

function aliasMap(sql: string): AliasMap {
  const columns = new Map<string, FilterColumn>();
  const expressions = new Set<string>();
  const plain = new Set<string>();
  const list = readSelectList(sql);
  if (list === null) return { columns, expressions, plain };
  const body = withoutComments(list)
    .replace(/^\s*(?:distinct|all)\s+/i, "")
    .replace(/^\s*top\s+\(?\d+\)?\s+/i, "");
  for (const item of splitSelectItems(body)) {
    const text = item.trim().replace(/\s+/g, " ");
    if (text === "" || text === "*") continue;
    const asMatch = AS_ALIAS.exec(text);
    const bare = asMatch === null ? BARE_ALIAS.exec(text) : null;
    const match = asMatch ?? bare;
    if (match === null) {
      const column = simpleColumn(text);
      if (column !== null) plain.add(column.name.toLowerCase());
      continue;
    }
    const alias = unquoteIdent(match[2] ?? "");
    if (filterName(alias) === null) continue;
    const key = alias.toLowerCase();
    const column = simpleColumn(match[1] ?? "");
    if (column === null) expressions.add(key);
    else if (column.name.toLowerCase() !== key) columns.set(key, column);
  }
  return { columns, expressions, plain };
}

function aliasBinding(map: AliasMap, column: string): FilterColumn | "expression" | null {
  const key = column.toLowerCase();
  if (map.plain.has(key)) return null;
  if (map.expressions.has(key)) return "expression";
  return map.columns.get(key) ?? null;
}

/**
 * The column a filter should compare.
 *
 * A select alias of a real column uses that original column. An alias of an
 * expression, such as `lower(region) AS area`, cannot be filtered by the new name.
 */
export function columnForFilter(sql: string, column: string): FilterColumn | null {
  if (filterName(column) === null) return null;
  const binding = aliasBinding(aliasMap(sql), column);
  if (binding === "expression") return null;
  if (binding === null) return { name: column, expression: column };
  return binding;
}

/**
 * Turns a comparison the model wrote in WHERE or HAVING into a chart filter.
 * `region = 'east'` becomes `region = {{region:east}}`. A comparison on a renamed
 * column uses the original column: `region AS area` with `area = 'east'` becomes
 * `region = {{region:east}}`. An alias of an expression is left as the model wrote it.
 * Text that already has a placeholder, and a statement with nothing to edit, is returned unchanged.
 */
export function promoteQueryFilters(sql: string): string {
  const hits = literalsInFilterClauses(sql);
  if (hits.length === 0) return sql;
  const aliases = aliasMap(sql);
  const taken = new Set(tokensIn(sql).map((token) => token.name));
  const named: Array<FilterLiteral & { expression: string | null }> = [];
  for (const hit of hits) {
    const binding = aliasBinding(aliases, hit.name);
    if (binding === "expression") continue;
    const base = binding === null ? hit.name : binding.name;
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      const tail = `_${suffix}`;
      name = `${base.slice(0, Math.max(0, 40 - tail.length))}${tail}`;
      suffix += 1;
    }
    taken.add(name);
    named.push({ ...hit, name, expression: binding === null ? null : binding.expression });
  }
  let next = sql;
  for (const hit of [...named].reverse()) {
    if (hit.expression !== null && hit.columnStart >= 0) {
      next = `${next.slice(0, hit.columnStart)}${hit.expression} ${hit.op} {{${hit.name}:${hit.value}}}${next.slice(hit.end)}`;
    } else {
      next = `${next.slice(0, hit.start)}{{${hit.name}:${hit.value}}}${next.slice(hit.end)}`;
    }
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

function filterToken(
  name: string,
  value: string,
  options: readonly string[],
  compare: FilterCompare,
  expression = name,
): string {
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
  return `${expression} ${compare} {{${body}}}`;
}

/** Adds one comparison the chart can edit. A name that is already a filter is left as it is. */
export function addQueryFilter(
  sql: string,
  name: string,
  value: string,
  options: readonly string[] = [],
  compare: FilterCompare = "=",
  expression = name,
): string {
  if (filterName(name) === null || tokensIn(sql).some((token) => token.name === name)) return sql;
  const predicate = filterToken(name, value, options, compare, expression);
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

/** The start of the column compared to this placeholder, including `orders.region`. */
function comparedColumnStart(sql: string, cursor: number, name: string): number | null {
  if (sql.slice(cursor - name.length, cursor) !== name) return null;
  let start = cursor - name.length;
  if (start > 0 && /[A-Za-z0-9_]/.test(sql[start - 1] ?? "")) return null;
  if (start > 0 && sql[start - 1] === ".") {
    let qualifier = start - 1;
    while (qualifier > 0 && /[A-Za-z0-9_]/.test(sql[qualifier - 1] ?? "")) qualifier -= 1;
    if (qualifier < start - 1) start = qualifier;
  }
  return start;
}

function stripPredicate(sql: string, token: FilterToken, name: string): string | null {
  let cursor = token.start;
  while (cursor > 0 && /\s/.test(sql[cursor - 1] ?? "")) cursor -= 1;
  const opAt = opBefore(sql, cursor);
  if (opAt === null) return null;
  cursor = opAt;
  while (cursor > 0 && /\s/.test(sql[cursor - 1] ?? "")) cursor -= 1;
  const columnAt = comparedColumnStart(sql, cursor, name);
  if (columnAt === null) return null;
  cursor = columnAt;
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

/** Removes every filter comparison. A placeholder that is not a comparison stays. */
export function clearQueryFilters(sql: string): string {
  let next = sql;
  for (const filter of readQueryFilters(sql)) {
    next = removeQueryFilter(next, filter.name);
  }
  return next;
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

/**
 * Writes a metric filter. The value stays an unquoted number, and choices are removed.
 * Pass a comparison to replace the operator in front of the placeholder.
 */
export function writeMetricFilter(sql: string, name: string, value: string, compare?: FilterCompare): string {
  const clean = value
    .replace(/[|}\r\n]/g, "")
    .trim()
    .slice(0, VALUE_CAP);
  if (!isNumericFilterValue(clean)) return sql;
  const tokens = tokensIn(sql);
  let next = sql;
  let wrote = false;
  for (const token of [...tokens].reverse()) {
    if (token.name !== name) continue;
    wrote = true;
    const body = `${token.name}:${clean}`;
    const found = compare === undefined ? null : compareAt(next, token.start);
    if (found === null) {
      next = `${next.slice(0, token.start)}{{${body}}}${next.slice(token.end)}`;
    } else {
      const gap = next.slice(found.start + found.op.length, token.start);
      next = `${next.slice(0, found.start)}${compare}${gap}{{${body}}}${next.slice(token.end)}`;
    }
  }
  return wrote ? next : sql;
}

/** Replaces the comparison in front of one metric filter, keeping its current number. */
export function writeMetricCompare(
  sql: string,
  filters: readonly QueryFilter[],
  name: string,
  compare: FilterCompare,
): string {
  const current = filters.find((item) => item.name === name);
  return writeMetricFilter(sql, name, current === undefined ? "" : current.value, compare);
}
