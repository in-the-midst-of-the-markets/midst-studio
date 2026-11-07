/**
 * The SQL subset a read-only Stripe connection runs.
 *
 * Stripe has no SQL engine. The editor still speaks SQL, and this module turns one SELECT
 * into the list, search, or retrieve the provider sends. A write fails here, before a request.
 */
import { QueryError } from "@/lib/db/errors";
import type { StripeFilter } from "./objects";

const PROVIDER = "stripe" as const;

export type { StripeFilter };

export interface StripeSelect {
  readonly kind: "select";
  readonly table: string;
  readonly columns: readonly string[] | null;
  readonly filters: readonly StripeFilter[];
  readonly limit: number | null;
  readonly offset: number;
}

export interface StripeCount {
  readonly kind: "count";
  readonly table: string;
  readonly filters: readonly StripeFilter[];
}

export type StripeStatement = StripeSelect | StripeCount;

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "eof" };

const READ_ONLY = "Stripe is read-only. This connection runs SELECT.";

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
    if ((c === "-" && /[0-9]/.test(sql[i + 1] ?? "")) || /[0-9]/.test(c)) {
      let raw = "";
      if (c === "-") {
        raw = "-";
        i += 1;
      }
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
    fail(`Stripe SQL cannot read "${c}".`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): StripeStatement {
    const word = this.peekWord()?.toUpperCase();
    if (word === "INSERT" || word === "UPDATE" || word === "DELETE") fail(READ_ONLY);
    if (word !== "SELECT") fail("Start with SELECT.");
    const statement = this.select();
    this.eatOp(";");
    if (this.peek().t !== "eof") fail("Stripe runs one statement at a time.");
    return statement;
  }

  private select(): StripeStatement {
    this.eatWord("SELECT");
    if (this.peekWord()?.toUpperCase() === "COUNT") return this.count();
    if (this.peekWord()?.toUpperCase() === "DISTINCT") fail("Stripe reads columns or *. DISTINCT is not available.");
    const columns = this.columns();
    this.eatWord("FROM");
    const table = this.name();
    const filters = this.filters();
    this.order();
    const bound = this.bound();
    this.refuseClause();
    return { kind: "select", table, columns, filters, limit: bound.limit, offset: bound.offset };
  }

  private count(): StripeCount {
    this.eatWord("COUNT");
    if (!this.eatOp("(") || !this.eatOp("*") || !this.eatOp(")")) fail("Write COUNT(*).");
    if (this.peekWord()?.toUpperCase() === "AS") {
      this.eatWord("AS");
      this.name();
    }
    this.eatWord("FROM");
    const table = this.name();
    const filters = this.filters();
    if (this.peekWord()?.toUpperCase() === "ORDER") fail("COUNT(*) takes no ORDER BY.");
    // The shared limiter appends LIMIT to a SELECT, and COUNT(*) is one. The count is Stripe's total.
    this.bound();
    this.refuseClause();
    return { kind: "count", table, filters };
  }

  private columns(): readonly string[] | null {
    if (this.eatOp("*")) return null;
    const names: string[] = [];
    names.push(this.name());
    while (this.eatOp(",")) names.push(this.name());
    return names;
  }

  private filters(): StripeFilter[] {
    if (this.peekWord()?.toUpperCase() !== "WHERE") return [];
    this.eatWord("WHERE");
    const filters: StripeFilter[] = [this.comparison()];
    while (this.peekWord()?.toUpperCase() === "AND") {
      this.eatWord("AND");
      filters.push(this.comparison());
    }
    if (this.peekWord()?.toUpperCase() === "OR") fail("Combine Stripe filters with AND.");
    return filters;
  }

  private comparison(): StripeFilter {
    const column = this.name();
    if (this.peekWord()?.toUpperCase() === "IS") {
      fail("Stripe has no IS NULL filter. Compare the field with =.");
    }
    if (
      this.peekWord()?.toUpperCase() === "NOT" ||
      this.peekWord()?.toUpperCase() === "LIKE" ||
      this.peekWord()?.toUpperCase() === "IN"
    ) {
      fail("Compare a Stripe field with =, or with <, <=, >, >= on a number.");
    }
    const op = this.operator();
    const value = this.value();
    return { column, op, value };
  }

  private operator(): StripeFilter["op"] {
    const token = this.peek();
    if (token.t !== "op") fail("Compare a Stripe field with =, or with <, <=, >, >= on a number.");
    const map: Record<string, StripeFilter["op"] | undefined> = {
      "=": "EQ",
      "!=": "NEQ",
      "<>": "NEQ",
      "<": "LT",
      "<=": "LTE",
      ">": "GT",
      ">=": "GTE",
    };
    const op = map[token.v];
    if (op === undefined) fail("Compare a Stripe field with =, or with <, <=, >, >= on a number.");
    this.index += 1;
    return op;
  }

  private value(): string | number | boolean {
    const token = this.peek();
    if (token.t === "string") {
      this.index += 1;
      return token.v;
    }
    if (token.t === "number") {
      this.index += 1;
      return token.v;
    }
    const word = this.peekWord()?.toUpperCase();
    if (word === "TRUE" || word === "FALSE") {
      this.index += 1;
      return word === "TRUE";
    }
    if (word === "NULL") fail("Stripe has no IS NULL filter. Compare the field with =.");
    fail("A filter value must be text, a number, TRUE, or FALSE.");
  }

  private order(): void {
    if (this.peekWord()?.toUpperCase() !== "ORDER") return;
    this.eatWord("ORDER");
    this.eatWord("BY");
    const column = this.name();
    if (column.toLowerCase() !== "created") {
      fail("Stripe returns newest objects first. ORDER BY created DESC is the order the API sends.");
    }
    const direction = this.peekWord()?.toUpperCase();
    if (direction === "ASC")
      fail("Stripe returns newest objects first. ORDER BY created DESC is the order the API sends.");
    if (direction === "DESC") this.eatWord("DESC");
  }

  private bound(): { limit: number | null; offset: number } {
    let limit: number | null = null;
    let offset = 0;
    if (this.peekWord()?.toUpperCase() === "LIMIT") {
      this.eatWord("LIMIT");
      const first = this.wholeNumber();
      if (this.eatOp(",")) {
        offset = first;
        limit = this.wholeNumber();
      } else {
        limit = first;
      }
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
      fail("LIMIT and OFFSET must be whole numbers.");
    this.index += 1;
    return token.v;
  }

  private refuseClause(): void {
    const word = this.peekWord()?.toUpperCase();
    if (
      word === "JOIN" ||
      word === "INNER" ||
      word === "LEFT" ||
      word === "RIGHT" ||
      word === "FULL" ||
      word === "CROSS"
    ) {
      fail("Stripe reads one object. JOIN is not available.");
    }
    if (word === "GROUP") fail("Stripe has no GROUP BY. Filter with WHERE.");
    if (word === "UNION" || word === "WITH" || word === "HAVING") fail("Stripe runs one SELECT.");
  }

  private name(): string {
    const first = this.bareName();
    if (!this.eatOp(".")) return first;
    const second = this.bareName();
    if (this.eatOp(".")) fail("A Stripe name has at most a container and an object.");
    return second;
  }

  private bareName(): string {
    const token = this.peek();
    if (token.t === "word" || token.t === "ident") {
      this.index += 1;
      return token.v;
    }
    fail("A name is required.");
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private peekWord(): string | undefined {
    const token = this.peek();
    return token.t === "word" ? token.v : undefined;
  }

  private eatWord(expected: string): void {
    const token = this.peek();
    if (token.t !== "word" || token.v.toUpperCase() !== expected) fail(`Expected ${expected}.`);
    this.index += 1;
  }

  private eatOp(op: string): boolean {
    const token = this.peek();
    if (token.t !== "op" || token.v !== op) return false;
    this.index += 1;
    return true;
  }
}

/** One Stripe statement, or a QueryError that names what the subset cannot run. */
export function translateStripeSql(sql: string): StripeStatement {
  return new Parser(tokenize(sql)).parse();
}
