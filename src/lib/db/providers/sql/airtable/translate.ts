/**
 * The SQL subset an Airtable connection runs.
 *
 * Airtable has no SQL engine. The editor still speaks SQL, and this module turns one statement
 * into the Web API call the provider sends: a filtered, sorted, paged record read, or one
 * insert, update, or delete addressed by record id. Anything outside that subset fails here,
 * before a request, with a sentence that says what to write instead.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "airtable" as const;

export interface AirtableOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export type AirtableValue = string | number | boolean | null;

export interface AirtableSelect {
  readonly kind: "select";
  readonly table: string;
  readonly columns: readonly string[] | null;
  readonly formula: string | null;
  readonly sorts: readonly AirtableOrder[];
  readonly limit: number | null;
  readonly offset: number;
}

export interface AirtableInsert {
  readonly kind: "insert";
  readonly table: string;
  readonly rows: readonly (readonly (readonly [string, AirtableValue])[])[];
}

export interface AirtableUpdate {
  readonly kind: "update";
  readonly table: string;
  readonly recordId: string;
  readonly fields: readonly (readonly [string, AirtableValue])[];
}

export interface AirtableDelete {
  readonly kind: "delete";
  readonly table: string;
  readonly recordId: string;
}

export interface AirtableCount {
  readonly kind: "count";
  readonly table: string;
  readonly formula: string | null;
}

export type AirtableStatement = AirtableSelect | AirtableInsert | AirtableUpdate | AirtableDelete | AirtableCount;

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);
const JOIN_MESSAGE = "Airtable reads one table. Join the result in another connection.";
const AGGREGATE_MESSAGE =
  "Airtable SQL does not run aggregates. Filter the rows here, then count them in another connection.";
const LIKE_MESSAGE = "LIKE supports a prefix (abc%), a suffix (%abc), or a contains (%abc%).";
const UPDATE_WHERE = "An update needs WHERE _id = 'rec…'.";
const DELETE_WHERE = "A delete needs WHERE _id = 'rec…'.";

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
    if (c === "-" && sql[i + 1] !== undefined && sql[i + 1] >= "0" && sql[i + 1] <= "9") {
      const start = i;
      i += 1;
      while (i < length && ((sql[i] >= "0" && sql[i] <= "9") || sql[i] === ".")) i += 1;
      const raw = sql.slice(start, i);
      if (!/^-?\d+(\.\d+)?$/.test(raw)) fail(`'${raw}' is not a number Airtable SQL accepts.`);
      tokens.push({ t: "number", v: Number(raw) });
      continue;
    }
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < length && ((sql[i] >= "0" && sql[i] <= "9") || sql[i] === ".")) i += 1;
      const raw = sql.slice(start, i);
      if (!/^\d+(\.\d+)?$/.test(raw)) fail(`'${raw}' is not a number Airtable SQL accepts.`);
      tokens.push({ t: "number", v: Number(raw) });
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      const start = i;
      i += 1;
      while (i < length) {
        const n = sql[i];
        if ((n >= "A" && n <= "Z") || (n >= "a" && n <= "z") || (n >= "0" && n <= "9") || n === "_") {
          i += 1;
          continue;
        }
        break;
      }
      tokens.push({ t: "word", v: sql.slice(start, i) });
      continue;
    }
    if (c === "!" && sql[i + 1] === "=") {
      tokens.push({ t: "op", v: "!=" });
      i += 2;
      continue;
    }
    if (c === "<" && sql[i + 1] === ">") {
      tokens.push({ t: "op", v: "<>" });
      i += 2;
      continue;
    }
    if (c === "<" && sql[i + 1] === "=") {
      tokens.push({ t: "op", v: "<=" });
      i += 2;
      continue;
    }
    if (c === ">" && sql[i + 1] === "=") {
      tokens.push({ t: "op", v: ">=" });
      i += 2;
      continue;
    }
    if (
      c === "=" ||
      c === "<" ||
      c === ">" ||
      c === "," ||
      c === "(" ||
      c === ")" ||
      c === "." ||
      c === "*" ||
      c === ";"
    ) {
      tokens.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    fail(`'${c}' is not part of the Airtable SQL subset.`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): AirtableStatement {
    const statement = this.statement();
    this.skipSemicolon();
    if (!this.done()) fail("Airtable runs one statement at a time.");
    return statement;
  }

  private statement(): AirtableStatement {
    const word = this.peekWord();
    if (word === "SELECT") return this.select();
    if (word === "INSERT") return this.insert();
    if (word === "UPDATE") return this.update();
    if (word === "DELETE") return this.delete();
    if (word === "WITH") fail("Airtable SQL does not run WITH.");
    if (word === "JOIN") fail(JOIN_MESSAGE);
    fail("Write a SELECT, INSERT, UPDATE, or DELETE.");
  }

  private select(): AirtableSelect | AirtableCount {
    this.eatWord("SELECT");
    if (this.peekWord() === "COUNT") return this.count();
    if (this.peekWord() === "DISTINCT") fail("Airtable SQL does not run DISTINCT.");
    const columns = this.columns();
    this.eatWord("FROM");
    const table = this.tableName();
    this.rejectJoin();
    let formula: string | null = null;
    if (this.peekWord() === "WHERE") {
      this.eatWord("WHERE");
      formula = this.orExpr();
    }
    const sorts: AirtableOrder[] = [];
    if (this.peekWord() === "ORDER") {
      this.eatWord("ORDER");
      this.eatWord("BY");
      for (;;) {
        const field = this.name();
        let direction: "asc" | "desc" = "asc";
        const dir = this.peekWord();
        if (dir === "ASC" || dir === "DESC") {
          direction = dir === "DESC" ? "desc" : "asc";
          this.eatWord(dir);
        }
        sorts.push({ field, direction });
        if (!this.eatOp(",")) break;
      }
    }
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
    return { kind: "select", table, columns, formula, sorts, limit, offset };
  }

  private count(): AirtableCount {
    this.eatWord("COUNT");
    if (!this.eatOp("(") || !this.eatOp("*") || !this.eatOp(")")) {
      fail("Airtable counts every row of one table. Write COUNT(*).");
    }
    if (this.peekWord() === "AS") {
      this.eatWord("AS");
      this.name();
    }
    this.eatWord("FROM");
    const table = this.tableName();
    this.rejectJoin();
    let formula: string | null = null;
    if (this.peekWord() === "WHERE") {
      this.eatWord("WHERE");
      formula = this.orExpr();
    }
    return { kind: "count", table, formula };
  }

  private columns(): readonly string[] | null {
    if (this.eatOp("*")) return null;
    const names: string[] = [];
    for (;;) {
      if (this.peekWord() !== undefined && AGGREGATES.has(this.peekWord() as string)) fail(AGGREGATE_MESSAGE);
      names.push(this.name());
      if (this.peekWord() === "AS") fail("Airtable SQL does not rename columns.");
      if (!this.eatOp(",")) break;
      if (this.eatOp("*")) fail("List the columns, or select * on its own.");
    }
    return names;
  }

  private insert(): AirtableInsert {
    this.eatWord("INSERT");
    this.eatWord("INTO");
    const table = this.tableName();
    if (!this.eatOp("(")) fail("An insert needs the column list in parentheses.");
    const columns = this.nameList();
    if (!this.eatOp(")")) fail("The column list is not closed.");
    this.eatWord("VALUES");
    const rows: (readonly (readonly [string, AirtableValue])[])[] = [];
    for (;;) {
      if (!this.eatOp("(")) fail("VALUES needs a row in parentheses.");
      const values: AirtableValue[] = [];
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
    if (rows.length > 10) fail("Airtable inserts at most 10 rows at a time.");
    return { kind: "insert", table, rows };
  }

  private update(): AirtableUpdate {
    this.eatWord("UPDATE");
    const table = this.tableName();
    this.eatWord("SET");
    const fields: (readonly [string, AirtableValue])[] = [];
    const seen = new Set<string>();
    for (;;) {
      const field = this.name();
      const key = field.toLowerCase();
      if (seen.has(key)) fail(`Name ${field} once.`);
      seen.add(key);
      if (key === "_id") fail("A record id cannot be changed.");
      if (!this.eatOp("=")) fail("SET needs a name, then =, then a value.");
      fields.push([field, this.value()]);
      if (!this.eatOp(",")) break;
    }
    const recordId = this.recordWhere(UPDATE_WHERE);
    return { kind: "update", table, recordId, fields };
  }

  private delete(): AirtableDelete {
    this.eatWord("DELETE");
    this.eatWord("FROM");
    const table = this.tableName();
    const recordId = this.recordWhere(DELETE_WHERE);
    return { kind: "delete", table, recordId };
  }

  private recordWhere(message: string): string {
    if (this.peekWord() !== "WHERE") fail(message);
    this.eatWord("WHERE");
    const field = this.name();
    if (field.toLowerCase() !== "_id") fail(message);
    if (!this.eatOp("=")) fail(message);
    const token = this.tokens[this.index];
    if (token.t !== "string" || token.v.trim() === "") fail(message);
    this.index += 1;
    return token.v;
  }

  private orExpr(): string {
    const left = this.andExpr();
    const parts = [left];
    while (this.peekWord() === "OR") {
      this.eatWord("OR");
      parts.push(this.andExpr());
    }
    if (parts.length === 1) return left;
    return `OR(${parts.join(",")})`;
  }

  private andExpr(): string {
    const parts = [this.notExpr()];
    while (this.peekWord() === "AND") {
      this.eatWord("AND");
      parts.push(this.notExpr());
    }
    if (parts.length === 1) return parts[0];
    return `AND(${parts.join(",")})`;
  }

  private notExpr(): string {
    if (this.peekWord() === "NOT") {
      this.eatWord("NOT");
      return `NOT(${this.notExpr()})`;
    }
    if (this.eatOp("(")) {
      const inner = this.orExpr();
      if (!this.eatOp(")")) fail("A parenthesis is not closed.");
      return inner;
    }
    return this.comparison();
  }

  private comparison(): string {
    const field = this.fieldRef();
    if (this.peekWord() === "IS") {
      this.eatWord("IS");
      const negated = this.peekWord() === "NOT";
      if (negated) this.eatWord("NOT");
      this.eatWord("NULL");
      return negated ? `NOT(${field}=BLANK())` : `${field}=BLANK()`;
    }
    if (this.peekWord() === "LIKE") {
      this.eatWord("LIKE");
      const token = this.tokens[this.index];
      if (token.t !== "string") fail(LIKE_MESSAGE);
      this.index += 1;
      return likeFormula(field, token.v);
    }
    if (this.peekWord() === "IN" || this.peekWord() === "BETWEEN") {
      fail("Airtable SQL does not run IN or BETWEEN. Compare the field, or use OR.");
    }
    const op = this.peek();
    if (op.t !== "op" || !["=", "!=", "<>", ">", ">=", "<", "<="].includes(op.v)) {
      fail("A comparison needs =, !=, <>, >, >=, <, <=, LIKE, or IS NULL.");
    }
    this.index += 1;
    const operator = op.v === "<>" ? "!=" : op.v;
    const value = this.value();
    if (value === null) return operator === "!=" ? `NOT(${field}=BLANK())` : `${field}=BLANK()`;
    return `${field}${operator}${formulaValue(value)}`;
  }

  private tableName(): string {
    const parts = [this.name()];
    while (this.eatOp(".")) parts.push(this.name());
    if (parts.length > 2) fail("Name the table, or schema.table. Airtable has no deeper path.");
    return parts[parts.length - 1];
  }

  private nameList(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      const name = this.name();
      const key = name.toLowerCase();
      if (seen.has(key)) fail(`Name ${name} once.`);
      seen.add(key);
      names.push(name);
      if (!this.eatOp(",")) break;
    }
    return names;
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
      if (AGGREGATES.has(upper)) fail(AGGREGATE_MESSAGE);
      if (upper === "JOIN") fail(JOIN_MESSAGE);
      this.index += 1;
      return token.v;
    }
    fail("A column or table name is missing.");
  }

  private fieldRef(): string {
    return formulaField(this.name());
  }

  private value(): AirtableValue {
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

  private skipSemicolon(): void {
    if (this.eatOp(";")) return;
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

function formulaField(name: string): string {
  return "{" + name.replaceAll("}", "\\}") + "}";
}

function formulaString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function formulaValue(value: Exclude<AirtableValue, null>): string {
  if (typeof value === "string") return formulaString(value);
  if (typeof value === "number") return String(value);
  return value ? "TRUE()" : "FALSE()";
}

function likeFormula(field: string, pattern: string): string {
  if (pattern === "%" || pattern === "%%") return "TRUE()";
  const contains = pattern.startsWith("%") && pattern.endsWith("%") && pattern.length >= 2;
  if (contains) {
    const inner = pattern.slice(1, -1);
    if (inner.includes("%")) fail(LIKE_MESSAGE);
    return `FIND(${formulaString(inner)}, ${field}&'')`;
  }
  if (pattern.endsWith("%")) {
    const inner = pattern.slice(0, -1);
    if (inner.includes("%") || inner.length === 0) fail(LIKE_MESSAGE);
    return `LEFT(${field}&'', ${inner.length})=${formulaString(inner)}`;
  }
  if (pattern.startsWith("%")) {
    const inner = pattern.slice(1);
    if (inner.includes("%") || inner.length === 0) fail(LIKE_MESSAGE);
    return `RIGHT(${field}&'', ${inner.length})=${formulaString(inner)}`;
  }
  if (pattern.includes("%")) fail(LIKE_MESSAGE);
  return `${field}=${formulaString(pattern)}`;
}

/** One Airtable statement, or a QueryError that names what the subset cannot run. */
export function translateAirtableSql(sql: string): AirtableStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail("Write a SELECT, INSERT, UPDATE, or DELETE.");
  return new Parser(tokenize(trimmed)).parse();
}
