/**
 * The SQL subset a read-only Microsoft Clarity connection runs.
 *
 * Clarity has no SQL engine. One SELECT or COUNT(*) becomes one export. A write fails
 * here, before a request. At most three breakdown dimensions go on that request.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "clarity" as const;

export interface ClarityFilter {
  readonly column: string;
  readonly value: string;
}

export interface ClarityOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface ClaritySelect {
  readonly kind: "select";
  readonly columns: readonly string[] | null;
  readonly days: 1 | 2 | 3;
  readonly filters: readonly ClarityFilter[];
  readonly orderBy: ClarityOrder | null;
  readonly limit: number | null;
  readonly offset: number;
}

export interface ClarityCount {
  readonly kind: "count";
  readonly days: 1 | 2 | 3;
  readonly filters: readonly ClarityFilter[];
}

export type ClarityStatement = ClaritySelect | ClarityCount;

const READ_ONLY = "Clarity is read-only. This connection runs SELECT or COUNT(*).";
const ONE_STATEMENT = "Clarity runs one statement at a time.";
const DAYS = "Clarity reads the last 1, 2, or 3 days. Write WHERE days = 1, 2, or 3.";

/** Dimensions the export accepts, in the spelling the API wants. */
export const CLARITY_DIMENSIONS: readonly string[] = Object.freeze([
  "Browser",
  "Device",
  "Country/Region",
  "OS",
  "Source",
  "Medium",
  "Campaign",
  "Channel",
  "URL",
]);

const DIMENSION_BY_NAME = new Map(CLARITY_DIMENSIONS.map((name) => [name.toLowerCase(), name]));

/** The API spelling of a dimension, or null when the name is a metric field. */
export function clarityDimension(name: string): string | null {
  return DIMENSION_BY_NAME.get(name.toLowerCase()) ?? null;
}

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
      if (end < 0) fail("Clarity could not read that statement.", sql);
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
      if (!closed) fail("Clarity could not read that statement.", sql);
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
      if (!closed) fail("Clarity could not read that statement.", sql);
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

  parse(): ClarityStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private fromInsights(): void {
    if (this.word("FROM") === null) fail("Write FROM insights.", this.sql);
    const table = this.name();
    if (table.toLowerCase() !== "insights") fail("Clarity has one table, insights.", this.sql);
  }

  private where(): { days: 1 | 2 | 3; filters: ClarityFilter[] } {
    let days: 1 | 2 | 3 = 1;
    let sawDays = false;
    const filters: ClarityFilter[] = [];
    if (this.word("WHERE") === null) return { days, filters };
    for (;;) {
      const column = this.name();
      if (this.word("=") === null) fail("Clarity filters with column = 'value'.", this.sql);
      const value = this.peek();
      if (value.t !== "string" && value.t !== "number")
        fail("Write the value in quotes or as a whole number.", this.sql);
      this.take();
      const text = value.t === "number" ? String(value.v) : value.v;
      if (column.toLowerCase() === "days" || column.toLowerCase() === "numofdays") {
        if (sawDays) fail(DAYS, this.sql);
        if (text !== "1" && text !== "2" && text !== "3") fail(DAYS, this.sql);
        days = Number(text) as 1 | 2 | 3;
        sawDays = true;
      } else {
        filters.push({ column, value: text });
      }
      if (this.word("AND") === null) break;
    }
    return { days, filters };
  }

  private orderBy(): ClarityOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY column.", this.sql);
    const column = this.name();
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") {
      this.index -= 1;
    }
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

  private finish(): void {
    if (this.peek().t !== "eof") fail(READ_ONLY, this.sql);
  }

  private select(): ClaritySelect {
    const columns = this.columns();
    this.fromInsights();
    const filtered = this.where();
    const orderBy = this.orderBy();
    const window = this.limit();
    this.finish();
    return { kind: "select", columns, ...filtered, orderBy, ...window };
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
    if (names.length === 0) fail("Name a column, or write SELECT *.", this.sql);
    return names;
  }

  private count(): ClarityCount {
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.word("AS") !== null) this.name();
    this.fromInsights();
    const filtered = this.where();
    if (this.word("ORDER") !== null) fail("COUNT(*) does not take ORDER BY.", this.sql);
    this.limit();
    this.finish();
    return { kind: "count", days: filtered.days, filters: filtered.filters };
  }
}

/** One statement. The export is still one request after this returns. */
export function translateClaritySql(sql: string): ClarityStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

/** The dimensions a statement asks the export to break down, at most three. */
export function clarityBreakdown(statement: ClarityStatement, selected: readonly string[] | null): readonly string[] {
  const names = new Set<string>();
  const ordered: string[] = [];
  const consider = (name: string): void => {
    const dimension = clarityDimension(name);
    if (dimension === null || names.has(dimension)) return;
    names.add(dimension);
    ordered.push(dimension);
  };
  for (const name of selected ?? []) consider(name);
  for (const filter of statement.filters) consider(filter.column);
  if (ordered.length > 3) {
    throw new QueryError("Clarity breaks a query down by at most three dimensions.", PROVIDER);
  }
  return ordered;
}
