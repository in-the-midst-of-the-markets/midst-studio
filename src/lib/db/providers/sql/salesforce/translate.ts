/**
 * The SQL subset a Salesforce connection runs.
 *
 * Salesforce's query language is SOQL, not the SQL the editor speaks. This module turns one
 * SELECT or COUNT(*) into the SOQL the provider sends. Anything outside that subset fails here,
 * before a request, with a sentence that says what to write instead.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "salesforce" as const;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const MAX_LIMIT = 2000;

export interface SalesforceOrder {
  readonly field: string;
  readonly direction: "ASC" | "DESC";
}

export interface SalesforceSelect {
  readonly kind: "select";
  readonly object: string;
  readonly columns: readonly string[] | null;
  readonly where: string | null;
  readonly order: readonly SalesforceOrder[];
  readonly limit: number | null;
  readonly offset: number;
}

export interface SalesforceCount {
  readonly kind: "count";
  readonly object: string;
  readonly where: string | null;
}

export type SalesforceStatement = SalesforceSelect | SalesforceCount;

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

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
        if (sql[i] === "\n" || sql[i] === "\r") fail("A string cannot span a line.");
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
    if ((c >= "0" && c <= "9") || (c === "." && sql[i + 1] >= "0" && sql[i + 1] <= "9")) {
      let end = i + 1;
      while (end < length && ((sql[end] >= "0" && sql[end] <= "9") || sql[end] === ".")) end += 1;
      const raw = sql.slice(i, end);
      if (!/^\d+(\.\d+)?$/.test(raw) && !/^\.\d+$/.test(raw)) fail("This number is not one Salesforce can compare.");
      tokens.push({ t: "number", v: Number(raw) });
      i = end;
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      let end = i + 1;
      while (end < length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
      tokens.push({ t: "word", v: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (c === "<" || c === ">" || c === "!" || c === "=") {
      const two = sql.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "!=" || two === "<>") {
        tokens.push({ t: "op", v: two === "<>" ? "!=" : two });
        i += 2;
        continue;
      }
      if (c === "=" || c === "<" || c === ">") {
        tokens.push({ t: "op", v: c });
        i += 1;
        continue;
      }
    }
    if (c === "," || c === "(" || c === ")" || c === "*") {
      tokens.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    fail("This statement uses a character the Salesforce subset does not read.");
  }
  tokens.push({ t: "eof" });
  return tokens;
}

class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.at] ?? { t: "eof" };
  }

  private seesOp(value: string): boolean {
    const token = this.peek();
    return token.t === "op" && token.v === value;
  }

  private take(): Token {
    const token = this.peek();
    this.at += 1;
    return token;
  }

  private word(expected?: string): string | undefined {
    const token = this.peek();
    if (token.t !== "word") return undefined;
    if (expected !== undefined && token.v.toUpperCase() !== expected) return undefined;
    this.at += 1;
    return token.v;
  }

  private expectWord(expected: string, message: string): void {
    if (this.word(expected) === undefined) fail(message);
  }

  private name(): string {
    const token = this.take();
    const value = token.t === "word" || token.t === "ident" ? token.v : undefined;
    if (value === undefined || !NAME.test(value)) {
      fail("Write one object or field name. Relationship fields are not queried here.");
    }
    return value;
  }

  private literal(): string {
    const token = this.take();
    if (token.t === "string") return `'${token.v.replaceAll("'", "''")}'`;
    if (token.t === "number") return String(token.v);
    if (token.t === "word") {
      const folded = token.v.toUpperCase();
      if (folded === "TRUE") return "true";
      if (folded === "FALSE") return "false";
      if (folded === "NULL") return "null";
    }
    fail("Compare a field with a string, a number, TRUE, FALSE, or NULL.");
  }

  private predicate(): string {
    const field = this.name();
    if (this.word("IS") !== undefined) {
      const negated = this.word("NOT") !== undefined;
      this.expectWord("NULL", 'Write IS NULL or IS NOT NULL.');
      return `${field} ${negated ? "!=" : "="} null`;
    }
    if (this.word("LIKE") !== undefined) {
      const token = this.peek();
      if (token.t !== "string") fail("LIKE compares a field with a string. Use % as the wildcard.");
      return `${field} LIKE ${this.literal()}`;
    }
    const op = this.peek();
    if (op.t !== "op" || !["=", "!=", "<", "<=", ">", ">="].includes(op.v)) {
      fail("Compare a field with =, !=, <, <=, >, >=, LIKE, IS NULL, or IS NOT NULL.");
    }
    this.take();
    return `${field} ${op.v} ${this.literal()}`;
  }

  private where(): string | null {
    if (this.word("WHERE") === undefined) return null;
    const first = this.predicate();
    const joinerToken = this.peek();
    const joiner = joinerToken.t === "word" ? joinerToken.v.toUpperCase() : undefined;
    if (joiner !== "AND" && joiner !== "OR") return first;
    const parts = [first];
    while (this.word(joiner) !== undefined) parts.push(this.predicate());
    if (this.word(joiner === "AND" ? "OR" : "AND") !== undefined) {
      fail("Use either AND or OR in one WHERE, not both.");
    }
    return parts.join(` ${joiner} `);
  }

  statement(): SalesforceStatement {
    this.expectWord("SELECT", "Salesforce runs one SELECT or COUNT(*).");
    const count = this.word("COUNT") !== undefined;
    let columns: readonly string[] | null = null;
    if (count) {
      const open = this.peek();
      if (open.t !== "op" || open.v !== "(") fail("Write COUNT(*).");
      this.take();
      const star = this.peek();
      if (star.t !== "op" || star.v !== "*") fail("Write COUNT(*).");
      this.take();
      const close = this.peek();
      if (close.t !== "op" || close.v !== ")") fail("Write COUNT(*).");
      this.take();
      if (this.word("AS") !== undefined) this.name();
    } else if (this.seesOp("*")) {
      this.take();
      columns = null;
    } else {
      const names: string[] = [];
      do {
        names.push(this.name());
        if (this.word("AS") !== undefined) fail("Do not rename columns.");
      } while (this.seesOp(",") && (this.take(), true));
      columns = names;
    }
    this.expectWord("FROM", "Name the object after FROM.");
    const object = this.name();
    const where = this.where();
    if (count) {
      if (this.word("ORDER") !== undefined || this.word("LIMIT") !== undefined || this.word("OFFSET") !== undefined) {
        fail("COUNT(*) does not take ORDER BY, LIMIT, or OFFSET.");
      }
      if (this.peek().t !== "eof") fail("Salesforce runs one SELECT or COUNT(*).");
      return { kind: "count", object, where };
    }
    const order: SalesforceOrder[] = [];
    if (this.word("ORDER") !== undefined) {
      this.expectWord("BY", "Write ORDER BY and a field name.");
      do {
        const field = this.name();
        const direction = this.word("DESC") !== undefined ? "DESC" : this.word("ASC") !== undefined ? "ASC" : "ASC";
        order.push({ field, direction });
      } while (this.seesOp(",") && (this.take(), true));
    }
    let limit: number | null = null;
    if (this.word("LIMIT") !== undefined) {
      const token = this.take();
      if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 1 || token.v > MAX_LIMIT) {
        fail("LIMIT must be a whole number from 1 to 2000.");
      }
      limit = token.v;
    }
    let offset = 0;
    if (this.word("OFFSET") !== undefined) {
      const token = this.take();
      if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0 || token.v > MAX_LIMIT) {
        fail("OFFSET must be a whole number from 0 to 2000.");
      }
      offset = token.v;
    }
    if (this.peek().t !== "eof") fail("Salesforce runs one SELECT or COUNT(*).");
    return { kind: "select", object, columns, where, order, limit, offset };
  }
}

/** One statement, or a refusal that names what to write instead. */
export function translateSalesforceSql(sql: string): SalesforceStatement {
  const upper = sql.toUpperCase();
  if (/\bJOIN\b/.test(upper)) fail("Query one object. Salesforce relationship queries are not run here.");
  if (/\b(INSERT|UPDATE|DELETE|GROUP|WITH|DISTINCT|UNION)\b/.test(upper)) {
    fail("This connection reads. Write one SELECT or COUNT(*).");
  }
  return new Parser(tokenize(sql)).statement();
}

/** The SOQL a statement sends. SELECT * has already been replaced with field names. */
export function salesforceSoql(statement: SalesforceStatement, columns: readonly string[]): string {
  if (statement.kind === "count") {
    return `SELECT COUNT() FROM ${statement.object}${statement.where === null ? "" : ` WHERE ${statement.where}`}`;
  }
  const order =
    statement.order.length === 0
      ? ""
      : ` ORDER BY ${statement.order.map((item) => `${item.field} ${item.direction}`).join(", ")}`;
  const limit = statement.limit === null ? "" : ` LIMIT ${statement.limit}`;
  const offset = statement.offset === 0 ? "" : ` OFFSET ${statement.offset}`;
  const where = statement.where === null ? "" : ` WHERE ${statement.where}`;
  return `SELECT ${columns.join(", ")} FROM ${statement.object}${where}${order}${limit}${offset}`;
}
