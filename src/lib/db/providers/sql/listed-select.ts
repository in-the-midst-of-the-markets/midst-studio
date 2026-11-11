/**
 * One SELECT against one named resource, filtered in Studio.
 *
 * Several HTTP products speak this same subset: one list, then WHERE, ORDER BY,
 * LIMIT and OFFSET on that answer. The product supplies its resources, its row
 * cap and the name that appears in a refusal. The reader does not branch on
 * which product it is.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";

const DEFAULT_LIMIT = 100;

export interface ListedColumn {
  readonly name: string;
  readonly type: "text" | "number";
  readonly json: string;
}

export interface ListedResource {
  readonly name: string;
  readonly primary: string;
  readonly path: string;
  readonly columns: readonly ListedColumn[];
}

export type ListedCompare = "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=";

export interface ListedFilter {
  readonly field: string;
  readonly operator: ListedCompare | "LIKE" | "IS NULL" | "IS NOT NULL";
  readonly value: string;
}

export interface ListedOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface ListedSelect {
  readonly kind: "select";
  readonly resource: ListedResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly ListedFilter[];
  readonly orderBy: ListedOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

/** The words and the catalog that make this reader one product's. */
export interface ListedProduct {
  readonly provider: DatabaseType;
  readonly rowCap: number;
  readonly resources: readonly ListedResource[];
  /** The product name, as a refusal should say it. */
  readonly product: string;
  /** A resource name the FROM refusal can suggest. */
  readonly example: string;
  /** A column the COUNT refusal can suggest. */
  readonly exampleColumn: string;
  /**
   * A FROM name that is not in `resources` is still a table, and a field that is
   * not on that table is still a text field. The caller checks both against the
   * live catalog after the statement is read.
   */
  readonly acceptAnyName?: boolean;
}

type Token =
  | { readonly t: "word"; readonly v: string }
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: string }
  | { readonly t: "eof" };

function fail(product: ListedProduct, message: string, sql: string): never {
  throw new QueryError(message, product.provider, sql);
}

function tokenize(product: ListedProduct, sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const c = sql[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      const close = sql.indexOf("*/", i);
      if (close < 0) fail(product, "Close the block comment.", sql);
      i = close + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      while (i < length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        value += sql[i];
        i += 1;
      }
      if (sql[i] !== "'") fail(product, "Close the quoted text.", sql);
      tokens.push({ t: "string", v: value });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      while (i < length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') break;
        value += sql[i];
        i += 1;
      }
      if (sql[i] !== '"') fail(product, "Close the quoted name.", sql);
      tokens.push({ t: "ident", v: value });
      i += 1;
      continue;
    }
    if (c === "<" && sql[i + 1] === ">") {
      tokens.push({ t: "word", v: "<>" });
      i += 2;
      continue;
    }
    if (c === "=" || c === ">" || c === "<" || c === "!") {
      const next = sql[i + 1];
      if ((c === "<" || c === ">" || c === "!") && next === "=") {
        tokens.push({ t: "word", v: `${c}=` });
        i += 2;
        continue;
      }
      if (c === "!") fail(product, readOnly(product), sql);
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === "*" || c === "(" || c === ")" || c === ",") {
      tokens.push({ t: "word", v: c });
      i += 1;
      continue;
    }
    if (c === ";") {
      const rest = sql.slice(i + 1).trim();
      if (rest !== "") fail(product, oneStatement(product), sql);
      break;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const number = readNumber(sql, i);
      if (number === null) fail(product, readOnly(product), sql);
      tokens.push({ t: "number", v: number.value });
      i = number.end;
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
    fail(product, readOnly(product), sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

function readNumber(sql: string, start: number): { value: string; end: number } | null {
  let i = start;
  let raw = "";
  if (sql[i] === "-") {
    if ((sql[i + 1] ?? "") < "0" || (sql[i + 1] ?? "") > "9") return null;
    raw = "-";
    i += 1;
  }
  const digits = i;
  while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
    raw += sql[i];
    i += 1;
  }
  if (i === digits) return null;
  if (sql[i] === "." && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
    raw += ".";
    i += 1;
    while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
      raw += sql[i];
      i += 1;
    }
  }
  return { value: raw, end: i };
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function safeName(product: ListedProduct, name: string, sql: string): string {
  if (name.length > 80 || !SAFE_NAME.test(name)) {
    fail(product, "Write a field name without spaces or punctuation.", sql);
  }
  return name;
}

function readOnly(product: ListedProduct): string {
  return `${product.product} is read-only. Studio runs SELECT and refuses a write.`;
}

function oneStatement(product: ListedProduct): string {
  return `${product.product} runs one statement. Remove the second statement.`;
}

export function listedResource(product: ListedProduct, name: string): ListedResource | undefined {
  const key = name.toLowerCase();
  return product.resources.find((item) => item.name === key);
}

function listedColumn(table: ListedResource, name: string): ListedColumn | undefined {
  const key = name.toLowerCase();
  return table.columns.find((item) => item.name === key);
}

class Parser {
  private index = 0;

  constructor(
    private readonly product: ListedProduct,
    private readonly tokens: readonly Token[],
    private readonly sql: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { t: "eof" };
  }

  private word(expected?: string): string | null {
    const token = this.peek();
    if (token.t !== "word") return null;
    if (expected !== undefined && token.v.toUpperCase() !== expected) return null;
    this.index += 1;
    return token.v;
  }

  private name(): string {
    const token = this.peek();
    this.index += 1;
    if (token.t === "word" || token.t === "ident") return safeName(this.product, token.v, this.sql);
    fail(this.product, "Write a field name.", this.sql);
  }

  parse(): ListedSelect {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(this.product, readOnly(this.product), this.sql);
    if (this.word("DISTINCT") !== null) {
      fail(this.product, `${this.product.product} reads one SELECT without DISTINCT.`, this.sql);
    }
    if (this.word("COUNT") !== null) {
      fail(
        this.product,
        `${this.product.product} has no COUNT(*). Select a column, such as ${this.product.exampleColumn}.`,
        this.sql,
      );
    }
    return this.select();
  }

  private table(): ListedResource {
    if (this.word("FROM") === null) {
      fail(this.product, `Write FROM and one resource, such as ${this.product.example}.`, this.sql);
    }
    const written = this.name();
    const found = listedResource(this.product, written);
    if (found !== undefined) return found;
    if (this.product.acceptAnyName === true) {
      const name = written.toLowerCase();
      return { name, primary: name, path: "", columns: [] };
    }
    fail(this.product, `${this.product.product} has no resource with that name.`, this.sql);
  }

  private field(table: ListedResource): ListedColumn {
    const written = this.name();
    const found = listedColumn(table, written);
    if (found !== undefined) return found;
    if (this.product.acceptAnyName === true) return openColumn(written);
    fail(this.product, missingField(this.product, written, table.name), this.sql);
  }

  private select(): ListedSelect {
    const star = this.word("*") !== null;
    const names: string[] = [];
    if (!star) {
      names.push(this.name());
      while (this.word(",") !== null) names.push(this.name());
    }
    const table = this.table();
    const columns = star ? null : names.map((written) => this.known(table, written));
    const filters = this.filters(table);
    const orderBy = this.order(table);
    const page = this.page();
    this.end();
    return { kind: "select", resource: table, columns, filters, orderBy, ...page };
  }

  private known(table: ListedResource, written: string): string {
    const found = listedColumn(table, written);
    if (found !== undefined) return found.name;
    if (this.product.acceptAnyName === true) return openColumn(written).name;
    fail(this.product, missingField(this.product, written, table.name), this.sql);
  }

  private filters(table: ListedResource): ListedFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters = [this.predicate(table)];
    while (this.word("AND") !== null) filters.push(this.predicate(table));
    if (this.word("OR") !== null) {
      fail(this.product, `Combine filters with AND. ${this.product.product} does not read OR here.`, this.sql);
    }
    return filters;
  }

  private predicate(table: ListedResource): ListedFilter {
    const field = this.field(table);
    if (this.word("IS") !== null) {
      const not = this.word("NOT") !== null;
      if (this.word("NULL") === null) fail(this.product, "Write IS NULL or IS NOT NULL.", this.sql);
      return { field: field.name, operator: not ? "IS NOT NULL" : "IS NULL", value: "" };
    }
    const operator = this.word();
    if (
      operator !== "=" &&
      operator !== "!=" &&
      operator !== "<>" &&
      operator !== "<" &&
      operator !== ">" &&
      operator !== "<=" &&
      operator !== ">=" &&
      (operator === null || operator.toUpperCase() !== "LIKE")
    ) {
      fail(this.product, "Compare with =, !=, <, >, <=, >=, or LIKE.", this.sql);
    }
    const written = operator?.toUpperCase() === "LIKE" ? "LIKE" : (operator as ListedCompare);
    return { field: field.name, operator: written, value: this.literal(field, written) };
  }

  private literal(field: ListedColumn, operator: ListedCompare | "LIKE"): string {
    if (operator === "LIKE") {
      if (field.type !== "text") fail(this.product, "LIKE applies to a text field.", this.sql);
      const token = this.peek();
      this.index += 1;
      if (token.t !== "string") fail(this.product, "Write the LIKE pattern in quotes.", this.sql);
      return token.v;
    }
    const token = this.peek();
    this.index += 1;
    if (field.type === "text") {
      if (token.t !== "string") fail(this.product, "Write that value in quotes.", this.sql);
      return token.v;
    }
    if (token.t !== "number" || !/^-?\d+(\.\d+)?$/.test(token.v)) fail(this.product, "Write a number.", this.sql);
    return token.v;
  }

  private order(table: ListedResource): ListedOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail(this.product, "Write ORDER BY and one field.", this.sql);
    const ordered = this.field(table).name;
    const desc = this.word("DESC") !== null;
    if (!desc) this.word("ASC");
    if (this.word(",") !== null) fail(this.product, `${this.product.product} orders by one field.`, this.sql);
    return { column: ordered, desc };
  }

  private page(): { limit: number; offset: number; capped: boolean } {
    let limit = DEFAULT_LIMIT;
    let capped = false;
    if (this.word("LIMIT") !== null) {
      const written = this.whole("Write LIMIT as a positive whole number.");
      if (written < 1) fail(this.product, "Write LIMIT as a positive whole number.", this.sql);
      if (written > this.product.rowCap) {
        limit = this.product.rowCap;
        capped = true;
      } else limit = written;
    }
    let offset = 0;
    if (this.word("OFFSET") !== null) offset = this.whole("Write OFFSET as a whole number.");
    if (offset > 0 && offset + limit > this.product.rowCap) capped = true;
    return { limit, offset, capped };
  }

  private whole(message: string): number {
    const token = this.peek();
    this.index += 1;
    if (token.t !== "number" || !/^\d+$/.test(token.v)) fail(this.product, message, this.sql);
    const value = Number(token.v);
    if (!Number.isSafeInteger(value)) fail(this.product, message, this.sql);
    return value;
  }

  private end(): void {
    if (this.peek().t !== "eof") fail(this.product, readOnly(this.product), this.sql);
  }
}

function openColumn(written: string): ListedColumn {
  const name = written.toLowerCase();
  return { name, type: "text", json: name };
}

function missingField(product: ListedProduct, field: string, table: string): string {
  return `${product.product} has no field named ${field} on ${table}.`;
}

/** One statement, or a refusal that names what to write instead. */
export function translateListedSql(sql: string, product: ListedProduct): ListedSelect {
  const text = sql.trim();
  if (text === "") fail(product, "Write a SELECT.", sql);
  return new Parser(product, tokenize(product, text), text).parse();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function textOf(value: unknown): string | null {
  if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean"))
    return null;
  return String(value);
}

function like(text: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("%", ".*")
    .replaceAll("_", ".");
  return new RegExp(`^${source}$`).test(text);
}

function matches(column: ListedColumn, value: unknown, filter: ListedFilter): boolean {
  if (filter.operator === "IS NULL") return value === null;
  if (filter.operator === "IS NOT NULL") return value !== null;
  if (filter.operator === "LIKE") {
    const text = textOf(value);
    return text !== null && like(text, filter.value);
  }
  if (column.type === "number") {
    const left = asNumber(value);
    const right = Number(filter.value);
    if (left === null || !Number.isFinite(right)) return false;
    if (filter.operator === "=") return left === right;
    if (filter.operator === "!=" || filter.operator === "<>") return left !== right;
    if (filter.operator === "<") return left < right;
    if (filter.operator === ">") return left > right;
    if (filter.operator === "<=") return left <= right;
    return left >= right;
  }
  const text = textOf(value);
  if (text === null) return false;
  if (filter.operator === "=") return text === filter.value;
  if (filter.operator === "!=" || filter.operator === "<>") return text !== filter.value;
  if (filter.operator === "<") return text < filter.value;
  if (filter.operator === ">") return text > filter.value;
  if (filter.operator === "<=") return text <= filter.value;
  return text >= filter.value;
}

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowOf(product: ListedProduct, entry: unknown, table: ListedResource, sql: string): Record<string, unknown> {
  if (!isRecord(entry)) fail(product, `${product.product}'s answer was not a list.`, sql);
  const row: Record<string, unknown> = {};
  for (const item of table.columns) row[item.name] = cell(entry[item.json]);
  return row;
}

function sortValue(column: ListedColumn, value: unknown): number | string | null {
  if (value === null) return null;
  if (column.type === "number") {
    const parsed = asNumber(value);
    return parsed === null ? textOf(value) : parsed;
  }
  return textOf(value);
}

/** The page of rows one list becomes. */
export function listedRows(
  product: ListedProduct,
  statement: ListedSelect,
  entries: readonly unknown[],
  sql: string,
): Record<string, unknown>[] {
  const rows = entries.map((entry) => rowOf(product, entry, statement.resource, sql));
  const kept = rows.filter((row) =>
    statement.filters.every((filter) => {
      const item = listedColumn(statement.resource, filter.field);
      return item !== undefined && matches(item, row[filter.field], filter);
    }),
  );
  const order = statement.orderBy;
  if (order !== null) {
    const item = listedColumn(statement.resource, order.column);
    if (item !== undefined) {
      kept.sort((left, right) => {
        const a = sortValue(item, left[order.column]);
        const b = sortValue(item, right[order.column]);
        if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
        if (typeof a === "number" && typeof b === "number") return order.desc ? b - a : a - b;
        const text = String(a).localeCompare(String(b));
        return order.desc ? -text : text;
      });
    }
  }
  return kept.slice(statement.offset, statement.offset + statement.limit);
}
