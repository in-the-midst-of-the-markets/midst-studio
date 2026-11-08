/**
 * The SQL subset a read-only QuickBooks Online connection runs.
 *
 * QuickBooks Online has a query language, not a SQL server. One SELECT or COUNT(*)
 * becomes one query. A write fails here, before a request. Rows are not copied
 * into another database.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "quickbooks" as const;

const READ_ONLY = "QuickBooks Online is read-only. This connection runs SELECT or COUNT(*).";
const ONE_STATEMENT = "QuickBooks Online runs one statement at a time.";
const ONE_ENTITY = "QuickBooks Online queries one entity at a time.";
const AND_ONLY = "QuickBooks Online combines filters with AND.";
const PAGE_CAP = 1000;
const DEFAULT_LIMIT = 100;

export interface QuickBooksFilter {
  readonly column: string;
  readonly op: "=" | "<" | ">" | "<=" | ">=" | "LIKE" | "IN";
  readonly literal: string;
}

export interface QuickBooksOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface QuickBooksSelect {
  readonly kind: "select";
  readonly entity: string;
  readonly columns: readonly string[] | null;
  readonly filters: readonly QuickBooksFilter[];
  readonly orderBy: QuickBooksOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface QuickBooksCount {
  readonly kind: "count";
  readonly entity: string;
  readonly filters: readonly QuickBooksFilter[];
}

export type QuickBooksStatement = QuickBooksSelect | QuickBooksCount;

interface EntitySpec {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: "varchar" | "double" | "boolean" }[];
}

const VARCHAR = "varchar" as const;
const DOUBLE = "double" as const;
const BOOLEAN = "boolean" as const;

function cols(
  names: readonly string[],
  types: Readonly<Record<string, "double" | "boolean">> = {},
): EntitySpec["columns"] {
  return names.map((name) => ({ name, type: types[name] ?? VARCHAR }));
}

/** The entities the object tree lists, in the spelling the query API wants. */
export const QUICKBOOKS_ENTITIES: readonly EntitySpec[] = Object.freeze([
  {
    name: "Account",
    columns: cols(["Id", "Name", "AccountType", "AccountSubType", "Active", "CurrentBalance"], {
      Active: BOOLEAN,
      CurrentBalance: DOUBLE,
    }),
  },
  {
    name: "Bill",
    columns: cols(["Id", "TxnDate", "DueDate", "VendorRef", "TotalAmt", "Balance"], {
      TotalAmt: DOUBLE,
      Balance: DOUBLE,
    }),
  },
  { name: "CompanyInfo", columns: cols(["Id", "CompanyName", "Country"]) },
  {
    name: "Customer",
    columns: cols(["Id", "DisplayName", "CompanyName", "Active", "Balance", "PrimaryEmailAddr"], {
      Active: BOOLEAN,
      Balance: DOUBLE,
    }),
  },
  { name: "Employee", columns: cols(["Id", "DisplayName", "Active"], { Active: BOOLEAN }) },
  { name: "Estimate", columns: cols(["Id", "DocNumber", "TxnDate", "TotalAmt", "CustomerRef"], { TotalAmt: DOUBLE }) },
  {
    name: "Invoice",
    columns: cols(["Id", "DocNumber", "TxnDate", "DueDate", "TotalAmt", "Balance", "CustomerRef"], {
      TotalAmt: DOUBLE,
      Balance: DOUBLE,
    }),
  },
  {
    name: "Item",
    columns: cols(["Id", "Name", "Type", "Active", "UnitPrice"], { Active: BOOLEAN, UnitPrice: DOUBLE }),
  },
  { name: "Payment", columns: cols(["Id", "TxnDate", "TotalAmt", "CustomerRef"], { TotalAmt: DOUBLE }) },
  { name: "Purchase", columns: cols(["Id", "TxnDate", "TotalAmt", "AccountRef"], { TotalAmt: DOUBLE }) },
  {
    name: "SalesReceipt",
    columns: cols(["Id", "DocNumber", "TxnDate", "TotalAmt", "CustomerRef"], { TotalAmt: DOUBLE }),
  },
  {
    name: "Vendor",
    columns: cols(["Id", "DisplayName", "CompanyName", "Active", "Balance"], { Active: BOOLEAN, Balance: DOUBLE }),
  },
]);

const ENTITY_BY_NAME = new Map(QUICKBOOKS_ENTITIES.map((entity) => [entity.name.toLowerCase(), entity]));

/** The catalog entity, or null when the name is not one this connection lists. */
export function quickbooksEntity(name: string): EntitySpec | null {
  return ENTITY_BY_NAME.get(name.toLowerCase()) ?? null;
}

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
      if (end < 0) fail("QuickBooks Online could not read that statement.", sql);
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
      if (!closed) fail("QuickBooks Online could not read that statement.", sql);
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
      if (!closed) fail("QuickBooks Online could not read that statement.", sql);
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

function quoteString(value: string, sql: string): string {
  if (/[\r\n\u0000]/.test(value)) fail("Write the value on one line.", sql);
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
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

  parse(): QuickBooksStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private entity(): string {
    if (this.word("FROM") === null) fail("Write FROM and an entity, such as Customer.", this.sql);
    const table = this.name();
    if (this.word("JOIN") !== null) fail(ONE_ENTITY, this.sql);
    const found = quickbooksEntity(table);
    if (found === null) fail("QuickBooks Online has no table with that name.", this.sql);
    return found.name;
  }

  private literal(): string {
    const token = this.peek();
    if (token.t === "string") {
      this.take();
      return quoteString(token.v, this.sql);
    }
    if (token.t === "number") {
      this.take();
      return String(token.v);
    }
    if (token.t === "word" && (token.v.toUpperCase() === "TRUE" || token.v.toUpperCase() === "FALSE")) {
      this.take();
      return token.v.toLowerCase();
    }
    fail("Write the value in quotes, as a number, or as true or false.", this.sql);
  }

  private filter(): QuickBooksFilter {
    const column = this.name();
    if (this.word("IN") !== null) {
      if (this.peek().t !== "lparen") fail("Write IN (value, value).", this.sql);
      this.take();
      const values: string[] = [];
      for (;;) {
        values.push(this.literal());
        if (this.peek().t !== "comma") break;
        this.take();
      }
      if (this.peek().t !== "rparen" || values.length === 0) fail("Write IN (value, value).", this.sql);
      this.take();
      return { column, op: "IN", literal: `(${values.join(", ")})` };
    }
    if (this.word("LIKE") !== null) {
      const token = this.peek();
      if (token.t !== "string") fail("Write LIKE with a quoted value.", this.sql);
      return { column, op: "LIKE", literal: this.literal() };
    }
    const op = this.word();
    if (op === "=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      return { column, op, literal: this.literal() };
    }
    if (op !== null && op.toUpperCase() === "OR") fail(AND_ONLY, this.sql);
    fail("QuickBooks Online filters with =, <, >, <=, >=, LIKE, or IN.", this.sql);
  }

  private where(): QuickBooksFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters: QuickBooksFilter[] = [];
    for (;;) {
      filters.push(this.filter());
      if (this.word("OR") !== null) fail(AND_ONLY, this.sql);
      if (this.word("AND") === null) break;
    }
    return filters;
  }

  private orderBy(): QuickBooksOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and a field.", this.sql);
    const column = this.name();
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    if (this.peek().t === "comma") fail("QuickBooks Online orders by one field.", this.sql);
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

  private select(): QuickBooksSelect {
    const columns = this.columns();
    const entity = this.entity();
    const filters = this.where();
    const orderBy = this.orderBy();
    const window = this.limit();
    this.finish();
    return { kind: "select", entity, columns, filters, orderBy, ...window };
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
    if (names.length === 0) fail("Name a field, or write SELECT *.", this.sql);
    return names;
  }

  private count(): QuickBooksCount {
    if (this.peek().t !== "lparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "rparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.word("AS") !== null) this.name();
    const entity = this.entity();
    const filters = this.where();
    if (this.word("ORDER") !== null) fail("COUNT(*) does not take ORDER BY.", this.sql);
    this.finish();
    return { kind: "count", entity, filters };
  }
}

/** One statement. The provider sends it as one query after this returns. */
export function translateQuickBooksSql(sql: string): QuickBooksStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

function renderFilter(filter: QuickBooksFilter): string {
  return `${filter.column} ${filter.op} ${filter.literal}`;
}

/** The query text QuickBooks Online runs. LIMIT and OFFSET are already its page words. */
export function quickbooksQueryText(statement: QuickBooksStatement): string {
  const where = statement.filters.length === 0 ? "" : ` WHERE ${statement.filters.map(renderFilter).join(" AND ")}`;
  if (statement.kind === "count") return `SELECT COUNT(*) FROM ${statement.entity}${where}`;
  const columns = statement.columns === null ? "*" : statement.columns.join(", ");
  const order =
    statement.orderBy === null ? "" : ` ORDERBY ${statement.orderBy.column} ${statement.orderBy.desc ? "DESC" : "ASC"}`;
  return `SELECT ${columns} FROM ${statement.entity}${where}${order} STARTPOSITION ${statement.offset + 1} MAXRESULTS ${statement.limit}`;
}
