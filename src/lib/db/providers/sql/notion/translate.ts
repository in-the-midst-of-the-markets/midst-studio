/**
 * The SQL subset a Notion connection runs.
 *
 * Notion has no SQL engine. The editor still speaks SQL, and this module turns one
 * SELECT into the data-source query the provider sends: a filter, a sort and a page.
 * A write, a join and a second statement fail here, before a request.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "notion" as const;

export const NOTION_ROW_CAP = 1000;

export interface NotionOrder {
  readonly field: string;
  readonly direction: "ascending" | "descending";
}

export type NotionValue = string | number | boolean | null;

export type NotionCompare = "=" | "!=" | ">" | ">=" | "<" | "<=";

export interface NotionComparison {
  readonly kind: "cmp";
  readonly column: string;
  readonly op: NotionCompare;
  readonly value: NotionValue;
}

export interface NotionNullCheck {
  readonly kind: "null";
  readonly column: string;
  readonly negated: boolean;
}

export interface NotionLike {
  readonly kind: "like";
  readonly column: string;
  readonly pattern: string;
}

export interface NotionAnd {
  readonly kind: "and";
  readonly parts: readonly NotionCondition[];
}

export interface NotionOr {
  readonly kind: "or";
  readonly parts: readonly NotionCondition[];
}

export interface NotionNot {
  readonly kind: "not";
  readonly inner: NotionCondition;
}

export type NotionCondition = NotionComparison | NotionNullCheck | NotionLike | NotionAnd | NotionOr | NotionNot;

export interface NotionSelect {
  readonly kind: "select";
  readonly table: string;
  readonly columns: readonly string[] | null;
  readonly where: NotionCondition | null;
  readonly sorts: readonly NotionOrder[];
  readonly limit: number | null;
  readonly offset: number;
}

export interface NotionCount {
  readonly kind: "count";
  readonly table: string;
  readonly where: NotionCondition | null;
}

export type NotionStatement = NotionSelect | NotionCount;

export interface NotionProperty {
  readonly name: string;
  readonly type: string;
}

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);
const JOIN_MESSAGE = "Notion reads one database. Join the result in another connection.";
const AGGREGATE_MESSAGE = "Notion SQL counts with COUNT(*). It does not run SUM, AVG, MIN or MAX.";
const LIKE_MESSAGE = "LIKE supports a prefix (abc%), a suffix (%abc), or a contains (%abc%).";
const READ_ONLY = "Notion SQL is read-only. Write a SELECT.";
const TEXT_TYPES = new Set(["title", "rich_text", "url", "email", "phone_number"]);
const PEOPLE_TYPES = new Set(["people", "created_by", "last_edited_by"]);
const DATE_TYPES = new Set(["date"]);
const TIMESTAMP_TYPES = new Set(["created_time", "last_edited_time"]);
const NUMBER_OPS: Record<NotionCompare, string> = {
  "=": "equals",
  "!=": "does_not_equal",
  ">": "greater_than",
  ">=": "greater_than_or_equal_to",
  "<": "less_than",
  "<=": "less_than_or_equal_to",
};
const DATE_OPS: Partial<Record<NotionCompare, string>> = {
  "=": "equals",
  ">": "after",
  ">=": "on_or_after",
  "<": "before",
  "<=": "on_or_before",
};
const TEXT_OPS: Partial<Record<NotionCompare, string>> = {
  "=": "equals",
  "!=": "does_not_equal",
};

function fail(message: string): never {
  throw new QueryError(message, PROVIDER);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = sql.length;
  while (index < length) {
    const current = sql[index];
    if (current === " " || current === "\n" || current === "\t" || current === "\r") {
      index += 1;
      continue;
    }
    if (current === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) fail("A block comment is not closed.");
      index = end + 2;
      continue;
    }
    if (current === "'") {
      const quoted = readQuoted(sql, index, "'", "A string is not closed.");
      tokens.push({ t: "string", v: quoted.value });
      index = quoted.end;
      continue;
    }
    if (current === '"') {
      const quoted = readQuoted(sql, index, '"', "A name is not closed.");
      tokens.push({ t: "ident", v: quoted.value });
      index = quoted.end;
      continue;
    }
    if (current === "-" && sql[index + 1] !== undefined && sql[index + 1] >= "0" && sql[index + 1] <= "9") {
      const start = index;
      index += 1;
      while (index < length && ((sql[index] >= "0" && sql[index] <= "9") || sql[index] === ".")) index += 1;
      tokens.push({ t: "number", v: numberToken(sql.slice(start, index)) });
      continue;
    }
    if (current >= "0" && current <= "9") {
      const start = index;
      while (index < length && ((sql[index] >= "0" && sql[index] <= "9") || sql[index] === ".")) index += 1;
      tokens.push({ t: "number", v: numberToken(sql.slice(start, index)) });
      continue;
    }
    if ((current >= "A" && current <= "Z") || (current >= "a" && current <= "z") || current === "_") {
      const start = index;
      index += 1;
      while (index < length) {
        const next = sql[index];
        if (
          (next >= "A" && next <= "Z") ||
          (next >= "a" && next <= "z") ||
          (next >= "0" && next <= "9") ||
          next === "_"
        ) {
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ t: "word", v: sql.slice(start, index) });
      continue;
    }
    if (current === "!" && sql[index + 1] === "=") {
      tokens.push({ t: "op", v: "!=" });
      index += 2;
      continue;
    }
    if (current === "<" && sql[index + 1] === ">") {
      tokens.push({ t: "op", v: "<>" });
      index += 2;
      continue;
    }
    if (current === "<" && sql[index + 1] === "=") {
      tokens.push({ t: "op", v: "<=" });
      index += 2;
      continue;
    }
    if (current === ">" && sql[index + 1] === "=") {
      tokens.push({ t: "op", v: ">=" });
      index += 2;
      continue;
    }
    if (
      current === "=" ||
      current === "<" ||
      current === ">" ||
      current === "," ||
      current === "(" ||
      current === ")" ||
      current === "." ||
      current === "*" ||
      current === ";"
    ) {
      tokens.push({ t: "op", v: current });
      index += 1;
      continue;
    }
    fail(`'${current}' is not part of the Notion SQL subset.`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

function readQuoted(
  sql: string,
  start: number,
  quote: string,
  open: string,
): { readonly value: string; readonly end: number } {
  let value = "";
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      value += quote;
      index += 2;
      continue;
    }
    if (sql[index] === quote) return { value, end: index + 1 };
    value += sql[index];
    index += 1;
  }
  fail(open);
}

function numberToken(raw: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) fail(`'${raw}' is not a number Notion SQL accepts.`);
  return Number(raw);
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): NotionStatement {
    const statement = this.statement();
    this.eatOp(";");
    if (!this.done()) fail("Notion runs one statement at a time.");
    return statement;
  }

  private statement(): NotionStatement {
    const word = this.peekWord();
    if (word === "SELECT") return this.select();
    if (word === "INSERT" || word === "UPDATE" || word === "DELETE") fail(READ_ONLY);
    if (word === "WITH") fail("Notion SQL does not run WITH.");
    if (word === "JOIN") fail(JOIN_MESSAGE);
    fail(READ_ONLY);
  }

  private select(): NotionSelect | NotionCount {
    this.eatWord("SELECT");
    if (this.peekWord() === "COUNT") return this.count();
    if (this.peekWord() === "DISTINCT") fail("Notion SQL does not run DISTINCT.");
    const columns = this.columns();
    this.eatWord("FROM");
    const table = this.tableName();
    this.rejectJoin();
    const where = this.where();
    const sorts = this.sorts();
    const { limit, offset } = this.page();
    return { kind: "select", table, columns, where, sorts, limit, offset };
  }

  private count(): NotionCount {
    this.eatWord("COUNT");
    if (!this.eatOp("(") || !this.eatOp("*") || !this.eatOp(")")) {
      fail("Notion counts every row of one database. Write COUNT(*).");
    }
    if (this.peekWord() === "AS") {
      this.eatWord("AS");
      this.name();
    }
    this.eatWord("FROM");
    const table = this.tableName();
    this.rejectJoin();
    return { kind: "count", table, where: this.where() };
  }

  private columns(): readonly string[] | null {
    if (this.eatOp("*")) return null;
    const names: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      if (this.peekWord() !== undefined && AGGREGATES.has(this.peekWord() as string)) fail(AGGREGATE_MESSAGE);
      const name = this.name();
      const key = name.toLowerCase();
      if (seen.has(key)) fail(`Name ${name} once.`);
      seen.add(key);
      names.push(name);
      if (this.peekWord() === "AS") fail("Notion SQL does not rename columns.");
      if (!this.eatOp(",")) break;
      if (this.eatOp("*")) fail("List the columns, or select * on its own.");
    }
    return names;
  }

  private where(): NotionCondition | null {
    if (this.peekWord() !== "WHERE") return null;
    this.eatWord("WHERE");
    return this.orExpr();
  }

  private sorts(): NotionOrder[] {
    if (this.peekWord() !== "ORDER") return [];
    this.eatWord("ORDER");
    this.eatWord("BY");
    const sorts: NotionOrder[] = [];
    for (;;) {
      const field = this.name();
      let direction: NotionOrder["direction"] = "ascending";
      const dir = this.peekWord();
      if (dir === "ASC" || dir === "DESC") {
        direction = dir === "DESC" ? "descending" : "ascending";
        this.eatWord(dir);
      }
      sorts.push({ field, direction });
      if (!this.eatOp(",")) break;
    }
    return sorts;
  }

  private page(): { limit: number | null; offset: number } {
    let limit: number | null = null;
    let offset = 0;
    if (this.peekWord() === "LIMIT") {
      this.eatWord("LIMIT");
      limit = this.wholeNumber("LIMIT");
      if (this.eatOp(",")) offset = this.wholeNumber("OFFSET");
    }
    if (this.peekWord() === "OFFSET") {
      this.eatWord("OFFSET");
      offset = this.wholeNumber("OFFSET");
    }
    return { limit, offset };
  }

  private orExpr(): NotionCondition {
    const parts = [this.andExpr()];
    while (this.peekWord() === "OR") {
      this.eatWord("OR");
      parts.push(this.andExpr());
    }
    return parts.length === 1 ? parts[0] : { kind: "or", parts };
  }

  private andExpr(): NotionCondition {
    const parts = [this.notExpr()];
    while (this.peekWord() === "AND") {
      this.eatWord("AND");
      parts.push(this.notExpr());
    }
    return parts.length === 1 ? parts[0] : { kind: "and", parts };
  }

  private notExpr(): NotionCondition {
    if (this.peekWord() === "NOT") {
      this.eatWord("NOT");
      return { kind: "not", inner: this.notExpr() };
    }
    if (this.eatOp("(")) {
      const inner = this.orExpr();
      if (!this.eatOp(")")) fail("A parenthesis is not closed.");
      return inner;
    }
    return this.comparison();
  }

  private comparison(): NotionCondition {
    const column = this.name();
    if (this.peekWord() === "IS") {
      this.eatWord("IS");
      const negated = this.peekWord() === "NOT";
      if (negated) this.eatWord("NOT");
      this.eatWord("NULL");
      return { kind: "null", column, negated };
    }
    if (this.peekWord() === "LIKE") {
      this.eatWord("LIKE");
      const token = this.tokens[this.index];
      if (token.t !== "string") fail(LIKE_MESSAGE);
      this.index += 1;
      return { kind: "like", column, pattern: token.v };
    }
    if (this.peekWord() === "IN" || this.peekWord() === "BETWEEN") {
      fail("Notion SQL does not run IN or BETWEEN. Compare the property, or use OR.");
    }
    const op = this.peek();
    if (op.t !== "op" || !["=", "!=", "<>", ">", ">=", "<", "<="].includes(op.v)) {
      fail("A comparison needs =, !=, <>, >, >=, <, <=, LIKE, or IS NULL.");
    }
    this.index += 1;
    return { kind: "cmp", column, op: op.v === "<>" ? "!=" : (op.v as NotionCompare), value: this.value() };
  }

  private tableName(): string {
    const parts = [this.name()];
    while (this.eatOp(".")) parts.push(this.name());
    if (parts.length > 2) fail("Name the database, or workspace.database. Notion has no deeper path.");
    return parts[parts.length - 1];
  }

  private name(): string {
    const token = this.tokens[this.index];
    if (token.t === "ident") {
      this.index += 1;
      if (token.v === "") fail("A name is empty.");
      return token.v;
    }
    if (token.t === "word") {
      const upper = token.v.toUpperCase();
      if (AGGREGATES.has(upper) && upper !== "COUNT") fail(AGGREGATE_MESSAGE);
      if (upper === "JOIN") fail(JOIN_MESSAGE);
      this.index += 1;
      return token.v;
    }
    fail("A column or database name is missing.");
  }

  private value(): NotionValue {
    const token = this.tokens[this.index];
    if (token.t === "string") {
      this.index += 1;
      return token.v;
    }
    if (token.t === "number") {
      this.index += 1;
      return token.v;
    }
    if (token.t === "word") {
      const upper = token.v.toUpperCase();
      if (upper === "TRUE") {
        this.index += 1;
        return true;
      }
      if (upper === "FALSE") {
        this.index += 1;
        return false;
      }
      if (upper === "NULL") {
        this.index += 1;
        return null;
      }
    }
    fail("A value must be a string, a number, TRUE, FALSE, or NULL.");
  }

  private wholeNumber(label: string): number {
    const token = this.tokens[this.index];
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0) {
      fail(`${label} needs a whole number that is zero or more.`);
    }
    this.index += 1;
    return token.v;
  }

  private rejectJoin(): void {
    const word = this.peekWord();
    if (
      word === "JOIN" ||
      word === "INNER" ||
      word === "LEFT" ||
      word === "RIGHT" ||
      word === "FULL" ||
      word === "CROSS"
    ) {
      fail(JOIN_MESSAGE);
    }
    const next = this.peek();
    if (next.t === "op" && next.v === ",") fail(JOIN_MESSAGE);
  }

  private eatWord(expected: string): void {
    const word = this.peekWord();
    if (word !== expected) fail(`Expected ${expected}.`);
    this.index += 1;
  }

  private eatOp(expected: string): boolean {
    const token = this.tokens[this.index];
    if (token.t === "op" && token.v === expected) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private peekWord(): string | undefined {
    const token = this.tokens[this.index];
    return token.t === "word" ? token.v.toUpperCase() : undefined;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private done(): boolean {
    return this.tokens[this.index].t === "eof";
  }
}

/** One Notion statement, or a QueryError that names what the subset cannot run. */
export function translateNotionSql(sql: string): NotionStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY);
  return new Parser(tokenize(trimmed)).parse();
}

function propertyOf(properties: readonly NotionProperty[], name: string): NotionProperty {
  if (name.toLowerCase() === "_id") {
    fail("Notion does not filter or sort on the page id. Name a property of the database.");
  }
  const exact = properties.find((property) => property.name === name);
  if (exact !== undefined) return exact;
  const folded = properties.filter((property) => property.name.toLowerCase() === name.toLowerCase());
  if (folded.length === 1) return folded[0];
  fail(`Notion has no property named ${name}.`);
}

function asString(value: NotionValue, name: string): string {
  if (typeof value !== "string") fail(`${name} is compared with a string.`);
  return value;
}

function asNumber(value: NotionValue, name: string): number {
  if (typeof value !== "number") fail(`${name} is compared with a number.`);
  return value;
}

function asBoolean(value: NotionValue, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} is compared with TRUE or FALSE.`);
  return value;
}

function uniqueNumber(value: NotionValue): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const match = /(\d+)$/.exec(value.trim());
    if (match !== null) return Number(match[1]);
  }
  fail("A unique id is compared with its number, such as 12 or 'TASK-12'.");
}

function textOperator(pattern: string): { readonly op: string; readonly value?: string } {
  if (pattern === "%" || pattern === "%%") fail(LIKE_MESSAGE);
  const contains = pattern.startsWith("%") && pattern.endsWith("%") && pattern.length >= 2;
  if (contains) {
    const inner = pattern.slice(1, -1);
    if (inner.includes("%") || inner.length === 0) fail(LIKE_MESSAGE);
    return { op: "contains", value: inner };
  }
  if (pattern.endsWith("%")) {
    const inner = pattern.slice(0, -1);
    if (inner.includes("%") || inner.length === 0) fail(LIKE_MESSAGE);
    return { op: "starts_with", value: inner };
  }
  if (pattern.startsWith("%")) {
    const inner = pattern.slice(1);
    if (inner.includes("%") || inner.length === 0) fail(LIKE_MESSAGE);
    return { op: "ends_with", value: inner };
  }
  if (pattern.includes("%")) fail(LIKE_MESSAGE);
  return { op: "equals", value: pattern };
}

function emptyFilter(type: string, empty: boolean): Record<string, unknown> {
  return { [type]: { [empty ? "is_empty" : "is_not_empty"]: true } };
}

function typed(property: NotionProperty, body: Record<string, unknown>): Record<string, unknown> {
  return { property: property.name, [property.type]: body };
}

function oneCondition(condition: NotionCondition, properties: readonly NotionProperty[]): Record<string, unknown> {
  const positive = positiveCondition(condition);
  if (positive.kind === "null") {
    const property = propertyOf(properties, positive.column);
    if (property.type === "checkbox") fail("A checkbox is true or false. Compare it with =.");
    if (property.type === "unique_id")
      fail("A unique id is compared with its number. Notion does not test it for empty.");
    if (property.type === "formula" || property.type === "rollup") {
      fail("Notion cannot filter a formula or a rollup from this subset. Filter the property it reads.");
    }
    if (TIMESTAMP_TYPES.has(property.type)) {
      fail(`Filter ${property.name} with a date comparison. Notion does not test that timestamp for empty.`);
    }
    if (property.type === "verification") fail("A verification is verified, expired, or none. Compare it with =.");
    if (property.type === "files") return { property: property.name, ...emptyFilter("files", !positive.negated) };
    return { property: property.name, ...emptyFilter(property.type, !positive.negated) };
  }
  if (positive.kind === "like") {
    const property = propertyOf(properties, positive.column);
    if (!TEXT_TYPES.has(property.type) && property.type !== "multi_select") {
      fail(`LIKE filters text. Compare ${property.name} with =.`);
    }
    const like = textOperator(positive.pattern);
    if (property.type === "multi_select") {
      if (like.op !== "contains" && like.op !== "equals")
        fail("A multi-select LIKE is a contains, such as '%TypeScript%'.");
      return typed(property, { contains: like.value });
    }
    return typed(property, { [like.op]: like.value });
  }
  if (positive.kind === "cmp") return comparisonFilter(positive, properties);
  return compound(positive, properties);
}

function comparisonFilter(condition: NotionComparison, properties: readonly NotionProperty[]): Record<string, unknown> {
  const property = propertyOf(properties, condition.column);
  if (condition.value === null) {
    return oneCondition({ kind: "null", column: condition.column, negated: condition.op === "!=" }, properties);
  }
  if (TEXT_TYPES.has(property.type)) {
    const op = TEXT_OPS[condition.op];
    if (op === undefined) fail(`Compare ${property.name} with = or !=.`);
    return typed(property, { [op]: asString(condition.value, property.name) });
  }
  if (property.type === "number")
    return typed(property, { [NUMBER_OPS[condition.op]]: asNumber(condition.value, property.name) });
  if (property.type === "unique_id")
    return typed(property, { [NUMBER_OPS[condition.op]]: uniqueNumber(condition.value) });
  if (property.type === "checkbox") {
    if (condition.op !== "=" && condition.op !== "!=") fail(`Compare ${property.name} with = or !=.`);
    return typed(property, {
      [condition.op === "=" ? "equals" : "does_not_equal"]: asBoolean(condition.value, property.name),
    });
  }
  if (property.type === "select" || property.type === "status") {
    if (condition.op !== "=" && condition.op !== "!=") fail(`Compare ${property.name} with = or !=.`);
    return typed(property, {
      [condition.op === "=" ? "equals" : "does_not_equal"]: asString(condition.value, property.name),
    });
  }
  if (property.type === "multi_select") {
    if (condition.op !== "=" && condition.op !== "!=") fail(`Compare ${property.name} with = or !=.`);
    return typed(property, {
      [condition.op === "=" ? "contains" : "does_not_contain"]: asString(condition.value, property.name),
    });
  }
  if (DATE_TYPES.has(property.type)) {
    const op = DATE_OPS[condition.op];
    if (op === undefined)
      fail(`Compare ${property.name} with =, >, >=, <, or <=. Notion has no "not equal" for a date.`);
    return typed(property, { [op]: asString(condition.value, property.name) });
  }
  if (TIMESTAMP_TYPES.has(property.type)) {
    const op = DATE_OPS[condition.op];
    if (op === undefined) fail(`Compare ${property.name} with =, >, >=, <, or <=.`);
    return { timestamp: property.type, [property.type]: { [op]: asString(condition.value, property.name) } };
  }
  if (PEOPLE_TYPES.has(property.type)) {
    if (condition.op !== "=" && condition.op !== "!=") fail(`Compare ${property.name} with a person id.`);
    return typed(
      { ...property, type: "people" },
      { [condition.op === "=" ? "contains" : "does_not_contain"]: asString(condition.value, property.name) },
    );
  }
  if (property.type === "relation") {
    if (condition.op !== "=" && condition.op !== "!=") fail(`Compare ${property.name} with a page id.`);
    return typed(property, {
      [condition.op === "=" ? "contains" : "does_not_contain"]: asString(condition.value, property.name),
    });
  }
  if (property.type === "verification") {
    if (condition.op !== "=" && condition.op !== "!=")
      fail("A verification is verified, expired, or none. Compare it with =.");
    const status = asString(condition.value, property.name);
    if (status !== "verified" && status !== "expired" && status !== "none") {
      fail("A verification is verified, expired, or none.");
    }
    return condition.op === "="
      ? { property: property.name, verification: { status } }
      : { property: property.name, verification: { does_not_equal: status } };
  }
  if (property.type === "formula" || property.type === "rollup" || property.type === "files") {
    fail(
      `Notion cannot filter ${property.name} from this subset. Filter a title, text, number, select, date, or checkbox.`,
    );
  }
  fail(`Notion cannot filter a ${property.type} property from this subset.`);
}

function compound(condition: NotionAnd | NotionOr, properties: readonly NotionProperty[]): Record<string, unknown> {
  return { [condition.kind]: condition.parts.map((part) => oneCondition(part, properties)) };
}

function negate(condition: NotionCondition): NotionCondition {
  if (condition.kind === "not") return condition.inner;
  if (condition.kind === "and") return { kind: "or", parts: condition.parts.map(negate) };
  if (condition.kind === "or") return { kind: "and", parts: condition.parts.map(negate) };
  if (condition.kind === "null") return { kind: "null", column: condition.column, negated: !condition.negated };
  if (condition.kind === "like") fail("Notion cannot negate LIKE. Compare the property with = or !=.");
  const flipped: Record<NotionCompare, NotionCompare> = {
    "=": "!=",
    "!=": "=",
    ">": "<=",
    ">=": "<",
    "<": ">=",
    "<=": ">",
  };
  return { kind: "cmp", column: condition.column, op: flipped[condition.op], value: condition.value };
}

function positiveCondition(condition: NotionCondition): Exclude<NotionCondition, NotionNot> {
  if (condition.kind !== "not") return condition;
  const inner = negate(condition.inner);
  if (inner.kind === "not") return positiveCondition(inner.inner);
  return inner;
}

function filterDepth(condition: NotionCondition): number {
  if (condition.kind === "and" || condition.kind === "or") {
    return 1 + condition.parts.reduce((deepest, part) => Math.max(deepest, filterDepth(part)), 0);
  }
  if (condition.kind === "not") return filterDepth(condition.inner);
  return 0;
}

/**
 * The filter body Notion's data-source query accepts, or a QueryError that names
 * a comparison this subset cannot send. `null` is a statement with no WHERE.
 */
export function notionFilter(
  where: NotionCondition | null,
  properties: readonly NotionProperty[],
): Record<string, unknown> | null {
  if (where === null) return null;
  if (filterDepth(where) > 2) fail("Notion filters nest two levels deep. Split the statement.");
  return oneCondition(where, properties);
}

/** The sorts body, in the statement's order. */
export function notionSorts(
  sorts: readonly NotionOrder[],
  properties: readonly NotionProperty[],
): readonly Record<string, unknown>[] {
  return sorts.map((sort) => {
    const property = propertyOf(properties, sort.field);
    if (TIMESTAMP_TYPES.has(property.type)) return { timestamp: property.type, direction: sort.direction };
    return { property: property.name, direction: sort.direction };
  });
}
