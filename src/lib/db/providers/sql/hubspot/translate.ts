/**
 * The SQL subset a HubSpot connection runs.
 *
 * HubSpot has no SQL engine. The editor still speaks SQL, and this module turns one statement
 * into the CRM search or write the provider sends. Anything outside that subset fails here,
 * before a request, with a sentence that says what to write instead.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "hubspot" as const;

export type HubSpotOperator =
  | "EQ"
  | "NEQ"
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  | "CONTAINS_TOKEN"
  | "HAS_PROPERTY"
  | "NOT_HAS_PROPERTY";

export interface HubSpotFilter {
  readonly property: string;
  readonly operator: HubSpotOperator;
  readonly value?: string;
}

export interface HubSpotFilterGroup {
  readonly filters: readonly HubSpotFilter[];
}

export interface HubSpotOrder {
  readonly property: string;
  readonly direction: "ASCENDING" | "DESCENDING";
}

export type HubSpotValue = string | number | boolean | null;

export interface HubSpotSelect {
  readonly kind: "select";
  readonly table: string;
  readonly columns: readonly string[] | null;
  readonly filterGroups: readonly HubSpotFilterGroup[];
  readonly sorts: readonly HubSpotOrder[];
  readonly limit: number | null;
  readonly offset: number;
}

export interface HubSpotInsert {
  readonly kind: "insert";
  readonly table: string;
  readonly rows: readonly (readonly (readonly [string, HubSpotValue])[])[];
}

export interface HubSpotUpdate {
  readonly kind: "update";
  readonly table: string;
  readonly recordId: string;
  readonly fields: readonly (readonly [string, HubSpotValue])[];
}

export interface HubSpotDelete {
  readonly kind: "delete";
  readonly table: string;
  readonly recordId: string;
}

export interface HubSpotCount {
  readonly kind: "count";
  readonly table: string;
  readonly filterGroups: readonly HubSpotFilterGroup[];
}

export type HubSpotStatement = HubSpotSelect | HubSpotInsert | HubSpotUpdate | HubSpotDelete | HubSpotCount;

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);
const MAX_GROUPS = 5;
const MAX_FILTERS = 6;

function fail(message: string): never {
  throw new QueryError(message, PROVIDER);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const c = sql[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail("A block comment is not closed.");
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) fail("A string is not closed.");
      tokens.push({ t: "string", v: value });
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      let closed = false;
      while (i < length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) fail("A name is not closed.");
      tokens.push({ t: "ident", v: value });
      continue;
    }
    if (c === "-" && /[0-9]/.test(sql[i + 1] ?? "")) {
      let raw = "-";
      i += 1;
      while (i < length && /[0-9.]/.test(sql[i])) {
        raw += sql[i];
        i += 1;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) fail("A number is not readable.");
      tokens.push({ t: "number", v: value });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let raw = "";
      while (i < length && /[0-9.]/.test(sql[i])) {
        raw += sql[i];
        i += 1;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) fail("A number is not readable.");
      tokens.push({ t: "number", v: value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let value = "";
      while (i < length && /[A-Za-z0-9_]/.test(sql[i])) {
        value += sql[i];
        i += 1;
      }
      tokens.push({ t: "word", v: value });
      continue;
    }
    if (
      (c === "<" && sql[i + 1] === ">") ||
      (c === "!" && sql[i + 1] === "=") ||
      (c === "<" && sql[i + 1] === "=") ||
      (c === ">" && sql[i + 1] === "=")
    ) {
      tokens.push({ t: "op", v: sql.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ("=<>(),*.;".includes(c)) {
      tokens.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    fail(`HubSpot SQL cannot read "${c}".`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

/** The property a filter or sort names. The editor's `id` column is HubSpot's `hs_object_id`. */
export function hubSpotProperty(column: string): string {
  return column.toLowerCase() === "id" ? "hs_object_id" : column;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): HubSpotStatement {
    const word = this.peekWord()?.toUpperCase();
    let statement: HubSpotStatement;
    if (word === "SELECT") statement = this.select();
    else if (word === "INSERT") statement = this.insert();
    else if (word === "UPDATE") statement = this.update();
    else if (word === "DELETE") statement = this.delete();
    else fail("Start with SELECT, INSERT, UPDATE, or DELETE.");
    this.eatOp(";");
    if (this.peek().t !== "eof") fail("HubSpot runs one statement at a time.");
    return statement;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private peekWord(): string | undefined {
    const token = this.peek();
    return token.t === "word" ? token.v : undefined;
  }

  private eatWord(expected?: string): string {
    const token = this.peek();
    if (token.t !== "word" || (expected !== undefined && token.v.toUpperCase() !== expected)) {
      fail(expected === undefined ? "A name is required." : `Expected ${expected}.`);
    }
    this.index += 1;
    return token.v;
  }

  private eatOp(op: string): boolean {
    const token = this.peek();
    if (token.t === "op" && token.v === op) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private select(): HubSpotSelect | HubSpotCount {
    this.eatWord("SELECT");
    if (this.peekWord()?.toUpperCase() === "COUNT") return this.count();
    const columns = this.columns();
    this.eatWord("FROM");
    const table = this.tableName();
    const filterGroups = this.where();
    const sorts = this.orderBy();
    const { limit, offset } = this.limit();
    return { kind: "select", table, columns, filterGroups, sorts, limit, offset };
  }

  private count(): HubSpotCount {
    this.eatWord("COUNT");
    if (!this.eatOp("(") || !this.eatOp("*") || !this.eatOp(")")) fail("The only aggregate is COUNT(*).");
    if (this.peekWord()?.toUpperCase() === "AS") {
      this.eatWord("AS");
      this.name();
    }
    this.eatWord("FROM");
    const table = this.tableName();
    return { kind: "count", table, filterGroups: this.where() };
  }

  private columns(): readonly string[] | null {
    if (this.eatOp("*")) return null;
    const names: string[] = [];
    for (;;) {
      if (this.peekWord() !== undefined && AGGREGATES.has(this.peekWord()?.toUpperCase() ?? "")) {
        fail("The only aggregate is COUNT(*).");
      }
      names.push(this.name());
      if (this.peekWord()?.toUpperCase() === "AS") fail("HubSpot SQL does not rename columns.");
      if (!this.eatOp(",")) break;
      if (this.eatOp("*")) fail("List the columns, or select * on its own.");
    }
    return names;
  }

  private tableName(): string {
    const first = this.name();
    if (!this.eatOp(".")) return first;
    const second = this.name();
    if (this.eatOp(".")) fail("A table name is the object, or schema.object.");
    return second;
  }

  private name(): string {
    const token = this.peek();
    if (token.t === "ident" || token.t === "word") {
      this.index += 1;
      if (token.v.toUpperCase() === "JOIN") fail("HubSpot reads one object. Join the result in a saved join.");
      return token.v;
    }
    fail("A name is required.");
  }

  private where(): readonly HubSpotFilterGroup[] {
    if (this.peekWord()?.toUpperCase() !== "WHERE") return [];
    this.eatWord("WHERE");
    return this.orExpr();
  }

  private orExpr(): HubSpotFilterGroup[] {
    const groups = [this.andExpr()];
    while (this.peekWord()?.toUpperCase() === "OR") {
      this.eatWord("OR");
      groups.push(this.andExpr());
      if (groups.length > MAX_GROUPS) fail("HubSpot search accepts at most 5 OR groups.");
    }
    return groups;
  }

  private andExpr(): HubSpotFilterGroup {
    if (this.eatOp("(")) {
      const inner = this.orExpr();
      if (!this.eatOp(")")) fail("A parenthesis is not closed.");
      if (inner.length !== 1) fail("Put OR between groups, not inside parentheses.");
      return inner[0];
    }
    const filters = [this.comparison()];
    while (this.peekWord()?.toUpperCase() === "AND") {
      this.eatWord("AND");
      filters.push(this.comparison());
      if (filters.length > MAX_FILTERS) fail("HubSpot search accepts at most 6 filters combined with AND.");
    }
    return { filters };
  }

  private comparison(): HubSpotFilter {
    if (this.peekWord()?.toUpperCase() === "NOT") fail("Write the comparison directly. HubSpot search has no NOT.");
    const property = hubSpotProperty(this.name());
    const word = this.peekWord()?.toUpperCase();
    if (word === "IS") {
      this.eatWord("IS");
      const negated = this.peekWord()?.toUpperCase() === "NOT";
      if (negated) this.eatWord("NOT");
      this.eatWord("NULL");
      return { property, operator: negated ? "HAS_PROPERTY" : "NOT_HAS_PROPERTY" };
    }
    if (word === "NOT") fail("Write the comparison directly. HubSpot search has no NOT.");
    if (word === "LIKE") {
      this.eatWord("LIKE");
      return { property, operator: "CONTAINS_TOKEN", value: this.likeValue() };
    }
    const op = this.peek();
    if (op.t !== "op") fail("A comparison needs =, !=, <, <=, >, >=, LIKE, or IS NULL.");
    this.index += 1;
    const operator = operatorOf(op.v);
    const value = this.value();
    if (value === null) {
      return { property, operator: operator === "NEQ" ? "HAS_PROPERTY" : "NOT_HAS_PROPERTY" };
    }
    return { property, operator, value: stringifyValue(value) };
  }

  private likeValue(): string {
    const token = this.peek();
    if (token.t !== "string") fail("LIKE needs a quoted pattern.");
    this.index += 1;
    const pattern = token.v;
    if (!pattern.includes("%")) return pattern;
    const inner = pattern.split("%").filter((part) => part !== "");
    if (inner.length !== 1) fail("LIKE supports a prefix (abc%), a suffix (%abc), or a contains (%abc%).");
    return inner[0];
  }

  private orderBy(): HubSpotOrder[] {
    if (this.peekWord()?.toUpperCase() !== "ORDER") return [];
    this.eatWord("ORDER");
    this.eatWord("BY");
    const sorts: HubSpotOrder[] = [];
    for (;;) {
      const property = hubSpotProperty(this.name());
      let direction: HubSpotOrder["direction"] = "ASCENDING";
      const word = this.peekWord()?.toUpperCase();
      if (word === "DESC") {
        this.eatWord("DESC");
        direction = "DESCENDING";
      } else if (word === "ASC") this.eatWord("ASC");
      sorts.push({ property, direction });
      if (!this.eatOp(",")) break;
    }
    return sorts;
  }

  private limit(): { limit: number | null; offset: number } {
    let limit: number | null = null;
    let offset = 0;
    if (this.peekWord()?.toUpperCase() === "LIMIT") {
      this.eatWord("LIMIT");
      const first = this.wholeNumber();
      if (this.eatOp(",")) {
        offset = first;
        limit = this.wholeNumber();
      } else limit = first;
    }
    if (this.peekWord()?.toUpperCase() === "OFFSET") {
      this.eatWord("OFFSET");
      offset = this.wholeNumber();
    }
    return { limit, offset };
  }

  private wholeNumber(): number {
    const token = this.peek();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0)
      fail("LIMIT and OFFSET need a whole number.");
    this.index += 1;
    return token.v;
  }

  private insert(): HubSpotInsert {
    this.eatWord("INSERT");
    this.eatWord("INTO");
    const table = this.tableName();
    if (!this.eatOp("(")) fail("An insert needs the column list in parentheses.");
    const columns = this.nameList();
    if (!this.eatOp(")")) fail("The column list is not closed.");
    this.eatWord("VALUES");
    const rows: (readonly (readonly [string, HubSpotValue])[])[] = [];
    for (;;) {
      if (!this.eatOp("(")) fail("VALUES needs a row in parentheses.");
      const values: HubSpotValue[] = [];
      for (;;) {
        values.push(this.value());
        if (!this.eatOp(",")) break;
      }
      if (!this.eatOp(")")) fail("A VALUES row is not closed.");
      if (values.length !== columns.length) {
        fail(`The row has ${values.length} values and the column list has ${columns.length}.`);
      }
      rows.push(columns.map((column, index) => [column, values[index]] as const));
      if (!this.eatOp(",")) break;
    }
    if (rows.length > 10) fail("HubSpot inserts at most 10 rows at a time from the editor.");
    if (rows.some((row) => row.some(([column]) => column.toLowerCase() === "id"))) {
      fail("A record id is assigned by HubSpot. Leave id out of the insert.");
    }
    return { kind: "insert", table, rows };
  }

  private nameList(): string[] {
    const names = [this.name()];
    while (this.eatOp(",")) names.push(this.name());
    return names;
  }

  private update(): HubSpotUpdate {
    this.eatWord("UPDATE");
    const table = this.tableName();
    this.eatWord("SET");
    const fields: (readonly [string, HubSpotValue])[] = [];
    const seen = new Set<string>();
    for (;;) {
      const field = this.name();
      const key = field.toLowerCase();
      if (seen.has(key)) fail(`Name ${field} once.`);
      seen.add(key);
      if (key === "id") fail("A record id cannot be changed.");
      if (!this.eatOp("=")) fail("SET needs a name, then =, then a value.");
      fields.push([field, this.value()]);
      if (!this.eatOp(",")) break;
    }
    return { kind: "update", table, recordId: this.recordWhere("An update needs WHERE id = '123'."), fields };
  }

  private delete(): HubSpotDelete {
    this.eatWord("DELETE");
    this.eatWord("FROM");
    const table = this.tableName();
    return { kind: "delete", table, recordId: this.recordWhere("A delete needs WHERE id = '123'.") };
  }

  private recordWhere(message: string): string {
    if (this.peekWord()?.toUpperCase() !== "WHERE") fail(message);
    this.eatWord("WHERE");
    const field = this.name();
    if (field.toLowerCase() !== "id") fail(message);
    if (!this.eatOp("=")) fail(message);
    const token = this.peek();
    if (token.t !== "string" || token.v.trim() === "") fail(message);
    this.index += 1;
    return token.v;
  }

  private value(): HubSpotValue {
    const token = this.peek();
    if (token.t === "string" || token.t === "number") {
      this.index += 1;
      return token.v;
    }
    const word = this.peekWord()?.toUpperCase();
    if (word === "TRUE" || word === "FALSE" || word === "NULL") {
      this.index += 1;
      if (word === "NULL") return null;
      return word === "TRUE";
    }
    fail("A value must be a string, a number, TRUE, FALSE, or NULL.");
  }
}

function operatorOf(op: string): HubSpotOperator {
  switch (op) {
    case "=":
      return "EQ";
    case "!=":
    case "<>":
      return "NEQ";
    case "<":
      return "LT";
    case "<=":
      return "LTE";
    case ">":
      return "GT";
    case ">=":
      return "GTE";
    default:
      fail("A comparison needs =, !=, <, <=, >, >=, LIKE, or IS NULL.");
  }
}

function stringifyValue(value: Exclude<HubSpotValue, null>): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** One HubSpot statement, or a QueryError that names what to write instead. */
export function translateHubSpotSql(sql: string): HubSpotStatement {
  return new Parser(tokenize(sql)).parse();
}
