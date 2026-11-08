/**
 * The SQL subset a read-only Odoo connection runs.
 *
 * Odoo Online is a JSON-2 API, not a SQL server. One SELECT or COUNT(*) becomes
 * one search_read or search_count. A write fails here, before a request. Rows
 * are not copied into another database.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "odoo" as const;

const READ_ONLY = "Odoo is read-only. This connection runs SELECT or COUNT(*).";
const ONE_STATEMENT = "Odoo runs one statement at a time.";
const ONE_MODEL = "Odoo queries one model at a time.";
const AND_ONLY = "Odoo combines filters with AND.";
const PAGE_CAP = 200;
const DEFAULT_LIMIT = 100;

export type OdooValue = string | number | boolean | readonly (string | number | boolean)[];

export interface OdooFilter {
  readonly column: string;
  readonly op: "=" | "!=" | "<" | ">" | "<=" | ">=" | "like" | "ilike" | "in";
  readonly value: OdooValue;
}

export interface OdooOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface OdooSelect {
  readonly kind: "select";
  readonly model: string;
  readonly columns: readonly string[] | null;
  readonly filters: readonly OdooFilter[];
  readonly orderBy: OdooOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface OdooCount {
  readonly kind: "count";
  readonly model: string;
  readonly filters: readonly OdooFilter[];
  readonly alias: string;
}

export type OdooStatement = OdooSelect | OdooCount;

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "star" }
  | { readonly t: "comma" }
  | { readonly t: "lparen" }
  | { readonly t: "rparen" }
  | { readonly t: "eof" };

function fail(message: string, sql: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const c = sql[i] ?? "";
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
      if (end < 0) fail("Odoo could not read that statement.", sql);
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
      if (!closed) fail("Odoo could not read that statement.", sql);
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
      if (!closed) fail("Odoo could not read that statement.", sql);
      tokens.push({ t: "ident", v: value });
      continue;
    }
    if (c === "*") {
      tokens.push({ t: "star" });
      i += 1;
      continue;
    }
    if (c === ",") {
      tokens.push({ t: "comma" });
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
      i += 1;
      continue;
    }
    if (c === "=" || c === ">" || c === "<" || c === "!") {
      const next = sql[i + 1];
      if ((c === "<" || c === ">" || c === "!") && next === "=") {
        tokens.push({ t: "word", v: `${c}=` });
        i += 2;
        continue;
      }
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === ";") {
      const rest = sql.slice(i + 1).trim();
      if (rest !== "") fail(ONE_STATEMENT, sql);
      break;
    }
    if (c >= "0" && c <= "9") {
      let raw = "";
      while (i < length && sql[i]! >= "0" && sql[i]! <= "9") {
        raw += sql[i];
        i += 1;
      }
      if (sql[i] === "." && sql[i + 1]! >= "0" && sql[i + 1]! <= "9") {
        raw += ".";
        i += 1;
        while (i < length && sql[i]! >= "0" && sql[i]! <= "9") {
          raw += sql[i];
          i += 1;
        }
      }
      tokens.push({ t: "number", v: Number(raw) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let raw = "";
      while (i < length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
        raw += sql[i];
        i += 1;
      }
      while (sql[i] === "." && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
        raw += ".";
        i += 1;
        while (i < length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
          raw += sql[i];
          i += 1;
        }
      }
      tokens.push({ t: "word", v: raw });
      continue;
    }
    fail(READ_ONLY, sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

function safeName(name: string, sql: string): string {
  if (name.length > 80 || !SAFE_NAME.test(name)) fail("Write a field name without spaces or punctuation.", sql);
  return name;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly sql: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private word(expected?: string): string | null {
    const token = this.peek();
    if (token.t !== "word") return null;
    if (expected !== undefined && token.v.toUpperCase() !== expected) return null;
    this.index += 1;
    return token.v;
  }

  private name(): string {
    const token = this.take();
    if (token.t === "word" || token.t === "ident") return safeName(token.v, this.sql);
    fail("Write a field name.", this.sql);
  }

  parse(): OdooStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private model(): string {
    if (this.word("FROM") === null) fail("Write FROM and a model, such as res.partner.", this.sql);
    const table = this.name();
    if (this.word("JOIN") !== null) fail(ONE_MODEL, this.sql);
    return table;
  }

  private literal(): string | number | boolean {
    const token = this.peek();
    if (token.t === "string") {
      this.take();
      return token.v;
    }
    if (token.t === "number") {
      this.take();
      return token.v;
    }
    if (token.t === "word" && (token.v.toUpperCase() === "TRUE" || token.v.toUpperCase() === "FALSE")) {
      this.take();
      return token.v.toUpperCase() === "TRUE";
    }
    fail("Write the value in quotes, as a number, or as true or false.", this.sql);
  }

  private filter(): OdooFilter {
    const column = this.name();
    if (this.word("IN") !== null) {
      if (this.peek().t !== "lparen") fail("Write IN (value, value).", this.sql);
      this.take();
      const values: (string | number | boolean)[] = [];
      for (;;) {
        values.push(this.literal());
        if (this.peek().t !== "comma") break;
        this.take();
      }
      if (this.peek().t !== "rparen") fail("Write IN (value, value).", this.sql);
      this.take();
      return { column, op: "in", value: values };
    }
    if (this.word("LIKE") !== null || this.word("ILIKE") !== null) {
      const op = this.tokens[this.index - 1];
      const spelled = op?.t === "word" && op.v.toUpperCase() === "ILIKE" ? "ilike" : "like";
      const token = this.peek();
      if (token.t !== "string") fail("Write LIKE with a quoted value.", this.sql);
      const value = this.literal();
      return { column, op: spelled, value };
    }
    const op = this.word();
    if (op === "=" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      return { column, op, value: this.literal() };
    }
    if (op !== null && op.toUpperCase() === "OR") fail(AND_ONLY, this.sql);
    fail("Odoo filters with =, !=, <, >, <=, >=, LIKE, ILIKE, or IN.", this.sql);
  }

  private where(): OdooFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters: OdooFilter[] = [];
    for (;;) {
      filters.push(this.filter());
      if (this.word("OR") !== null) fail(AND_ONLY, this.sql);
      if (this.word("AND") === null) break;
    }
    return filters;
  }

  private orderBy(): OdooOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and a field.", this.sql);
    const column = this.name();
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    if (this.peek().t === "comma") fail("Odoo orders by one field.", this.sql);
    return { column, desc };
  }

  private takeLimit(): { limit: number; capped: boolean } {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 1) {
      fail("Write LIMIT as a whole number greater than zero.", this.sql);
    }
    return { limit: token.v > PAGE_CAP ? PAGE_CAP : token.v, capped: token.v > PAGE_CAP };
  }

  private takeOffset(): number {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v)) fail("Write OFFSET as a whole number.", this.sql);
    return token.v;
  }

  private limit(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let offset = 0;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      ({ limit, capped } = this.takeLimit());
      if (this.word("OFFSET") !== null) offset = this.takeOffset();
    } else if (this.word("OFFSET") !== null) {
      offset = this.takeOffset();
      if (this.word("LIMIT") !== null) ({ limit, capped } = this.takeLimit());
    }
    return { limit, offset, capped };
  }

  private finish(): void {
    if (this.peek().t !== "eof") fail(READ_ONLY, this.sql);
  }

  private select(): OdooSelect {
    const columns = this.columns();
    const model = this.model();
    const filters = this.where();
    const orderBy = this.orderBy();
    const window = this.limit();
    this.finish();
    return { kind: "select", model, columns, filters, orderBy, ...window };
  }

  private columns(): readonly string[] | null {
    if (this.peek().t === "star") {
      this.take();
      return null;
    }
    const names: string[] = [];
    for (;;) {
      names.push(this.name());
      if (this.peek().t !== "comma") break;
      this.take();
    }
    return names;
  }

  private count(): OdooCount {
    if (this.peek().t !== "lparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "rparen") fail("Write COUNT(*).", this.sql);
    this.take();
    const alias = this.word("AS") === null ? "count" : this.name();
    const model = this.model();
    const filters = this.where();
    if (this.word("ORDER") !== null) fail("COUNT(*) does not take ORDER BY.", this.sql);
    this.finish();
    return { kind: "count", model, filters, alias };
  }
}

/** One statement. The provider sends it as one JSON-2 call after this returns. */
export function translateOdooSql(sql: string): OdooStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

/** The JSON-2 body for one statement. The provider chooses search_read or search_count. */
export function odooCallBody(statement: OdooStatement): Record<string, unknown> {
  const domain = statement.filters.map((filter) => [filter.column, filter.op, filter.value]);
  if (statement.kind === "count") return { domain };
  const body: Record<string, unknown> = { domain, limit: statement.limit, offset: statement.offset };
  if (statement.columns !== null) body.fields = [...statement.columns];
  if (statement.orderBy !== null) {
    body.order = `${statement.orderBy.column} ${statement.orderBy.desc ? "desc" : "asc"}`;
  }
  return body;
}
