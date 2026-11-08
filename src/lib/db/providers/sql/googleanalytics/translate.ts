/**
 * The SQL subset a read-only Google Analytics connection runs.
 *
 * Analytics has no SQL engine. One SELECT becomes one `runReport`. A write fails
 * here, before a request. Which names are dimensions and which are metrics is
 * decided from the property's metadata, after this parse.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "googleanalytics" as const;

export interface GaFilter {
  readonly column: string;
  readonly value: string;
}

export interface GaOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface GaSelect {
  readonly columns: readonly string[] | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly filters: readonly GaFilter[];
  readonly orderBy: GaOrder | null;
  readonly limit: number | null;
  readonly offset: number;
}

const READ_ONLY = "Google Analytics is read-only. This connection runs SELECT.";
const ONE_STATEMENT = "Google Analytics runs one statement at a time.";
const DATE = "Write a date as YYYY-MM-DD, today, yesterday, or NdaysAgo.";
const DEFAULT_START = "7daysAgo";
const DEFAULT_END = "yesterday";

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "star" }
  | { readonly t: "comma" }
  | { readonly t: "eof" };

function fail(message: string, sql: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

/** A date the Data API accepts. */
export function gaDate(value: string): boolean {
  return value === "today" || value === "yesterday" || /^\d+daysAgo$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
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
      if (end < 0) fail("Google Analytics could not read that statement.", sql);
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
      if (!closed) fail("Google Analytics could not read that statement.", sql);
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
      if (!closed) fail("Google Analytics could not read that statement.", sql);
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
    if (c === "(" || c === ")") {
      i += 1;
      continue;
    }
    if (c === "=" || c === ">" || c === "<" || c === "!") {
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === ";") {
      if (sql.slice(i + 1).trim() !== "") fail(ONE_STATEMENT, sql);
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
      tokens.push({ t: "word", v: raw });
      continue;
    }
    fail(READ_ONLY, sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
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
    if (token.t === "word" || token.t === "ident") return token.v;
    fail("Write a column name.", this.sql);
  }

  parse(): GaSelect {
    if (this.word("SELECT") === null) fail(READ_ONLY, this.sql);
    if (this.word("COUNT") !== null)
      fail("Name a metric, such as activeUsers. Google Analytics has no COUNT(*).", this.sql);
    const columns = this.columns();
    if (this.word("FROM") === null) fail("Write FROM report.", this.sql);
    const table = this.name();
    if (table.toLowerCase() !== "report") fail("Google Analytics has one table, report.", this.sql);
    const filtered = this.where();
    const orderBy = this.orderBy();
    const window = this.limit();
    if (this.peek().t !== "eof") fail(READ_ONLY, this.sql);
    return { columns, ...filtered, orderBy, ...window };
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

  private where(): { startDate: string; endDate: string; filters: GaFilter[] } {
    let startDate = DEFAULT_START;
    let endDate = DEFAULT_END;
    const filters: GaFilter[] = [];
    if (this.word("WHERE") === null) return { startDate, endDate, filters };
    for (;;) {
      const column = this.name();
      if (this.word("=") === null) fail("Google Analytics filters with column = 'value'.", this.sql);
      const value = this.peek();
      if (value.t !== "string" && value.t !== "number")
        fail("Write the value in quotes or as a whole number.", this.sql);
      this.take();
      const text = value.t === "number" ? String(value.v) : value.v;
      const key = column.toLowerCase();
      if (key === "startdate" || key === "enddate") {
        if (!gaDate(text)) fail(DATE, this.sql);
        if (key === "startdate") startDate = text;
        else endDate = text;
      } else {
        filters.push({ column, value: text });
      }
      if (this.word("AND") === null) break;
    }
    return { startDate, endDate, filters };
  }

  private orderBy(): GaOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY column.", this.sql);
    const column = this.name();
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    return { column, desc };
  }

  private limit(): { limit: number | null; offset: number } {
    let limit: number | null = null;
    let offset = 0;
    if (this.word("LIMIT") !== null) {
      const token = this.take();
      if (token.t !== "number") fail("Write LIMIT as a whole number.", this.sql);
      limit = token.v;
    }
    if (this.word("OFFSET") !== null) {
      const token = this.take();
      if (token.t !== "number") fail("Write OFFSET as a whole number.", this.sql);
      offset = token.v;
    }
    return { limit, offset };
  }
}

/** One SELECT. Dates default to the last seven days ending yesterday. */
export function translateGaSql(sql: string): GaSelect {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}
