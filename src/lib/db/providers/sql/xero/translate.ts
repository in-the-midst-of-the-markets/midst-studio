/**
 * The SQL subset a read-only Xero connection runs.
 *
 * Xero has a list API, not a SQL server. One SELECT or COUNT(*) becomes one
 * list request. A write fails here, before a request. Rows are not copied
 * into another database.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "xero" as const;

const READ_ONLY = "Xero is read-only. This connection runs SELECT or COUNT(*).";
const ONE_STATEMENT = "Xero runs one statement at a time.";
const ONE_ENTITY = "Xero queries one list at a time.";
const AND_ONLY = "Xero combines filters with AND.";
const LIKE_MESSAGE = "LIKE supports a prefix (abc%), a suffix (%abc), or a contains (%abc%).";
const FIELD_MESSAGE = "Xero has no field with that name.";
const DATE_MESSAGE = "Write a date as YYYY-MM-DD.";
const GUID_MESSAGE = "Write a Xero id as a UUID.";
const NUMBER_MESSAGE = "Write a number for that field.";
const BOOLEAN_MESSAGE = "Write true or false for that field.";
const TEXT_MESSAGE = "Write the value in quotes for that field.";
const LIKE_TEXT = "LIKE applies to text.";
export const XERO_ROW_CAP = 1000;
export const XERO_PAGE_SIZE = 100;
const DEFAULT_LIMIT = 100;

type XeroType = "varchar" | "double" | "boolean" | "date" | "guid";

export interface XeroColumn {
  readonly name: string;
  readonly type: XeroType;
}

export interface XeroEntity {
  readonly name: string;
  readonly path: string;
  readonly responseKey: string;
  readonly paging: "page" | "all";
  readonly primary: string;
  readonly columns: readonly XeroColumn[];
}

export interface XeroFilter {
  readonly text: string;
}

export interface XeroOrder {
  readonly column: string;
  readonly desc: boolean;
}

export interface XeroSelect {
  readonly kind: "select";
  readonly entity: string;
  readonly columns: readonly string[] | null;
  readonly filters: readonly XeroFilter[];
  readonly orderBy: XeroOrder | null;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface XeroCount {
  readonly kind: "count";
  readonly entity: string;
  readonly filters: readonly XeroFilter[];
}

export type XeroStatement = XeroSelect | XeroCount;

interface Literal {
  readonly kind: "string" | "number" | "boolean";
  readonly value: string;
}

const V = "varchar" as const;
const N = "double" as const;
const B = "boolean" as const;
const D = "date" as const;
const G = "guid" as const;

function columns(fields: readonly (readonly [string, XeroType])[]): readonly XeroColumn[] {
  return fields.map(([name, type]) => ({ name, type }));
}

function list(
  name: string,
  paging: "page" | "all",
  fields: readonly (readonly [string, XeroType])[],
  responseKey = name,
): XeroEntity {
  const defined = columns(fields);
  const head = defined[0] as XeroColumn;
  const primary = defined.find((column) => column.type === "guid")?.name ?? head.name;
  return { name, path: name, responseKey, paging, primary, columns: defined };
}

/** The lists the object tree shows, in the spelling the Accounting API wants. */
export const XERO_ENTITIES: readonly XeroEntity[] = Object.freeze([
  list("Invoices", "page", [
    ["InvoiceID", G],
    ["InvoiceNumber", V],
    ["Reference", V],
    ["Type", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["DueDate", D],
    ["SubTotal", N],
    ["TotalTax", N],
    ["Total", N],
    ["AmountDue", N],
    ["AmountPaid", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("Contacts", "page", [
    ["ContactID", G],
    ["Name", V],
    ["EmailAddress", V],
    ["FirstName", V],
    ["LastName", V],
    ["ContactStatus", V],
    ["IsCustomer", B],
    ["IsSupplier", B],
    ["UpdatedDateUTC", D],
  ]),
  list("CreditNotes", "page", [
    ["CreditNoteID", G],
    ["CreditNoteNumber", V],
    ["Type", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["SubTotal", N],
    ["TotalTax", N],
    ["Total", N],
    ["RemainingCredit", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("Payments", "page", [
    ["PaymentID", G],
    ["Date", D],
    ["Amount", N],
    ["Reference", V],
    ["PaymentType", V],
    ["Status", V],
    ["UpdatedDateUTC", D],
  ]),
  list("BankTransactions", "page", [
    ["BankTransactionID", G],
    ["Type", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["Reference", V],
    ["SubTotal", N],
    ["TotalTax", N],
    ["Total", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("PurchaseOrders", "page", [
    ["PurchaseOrderID", G],
    ["PurchaseOrderNumber", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["DeliveryDate", D],
    ["Reference", V],
    ["Total", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("Quotes", "page", [
    ["QuoteID", G],
    ["QuoteNumber", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["ExpiryDate", D],
    ["Title", V],
    ["Total", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("ManualJournals", "page", [
    ["ManualJournalID", G],
    ["Narration", V],
    ["Date", D],
    ["Status", V],
    ["LineAmountTypes", V],
    ["UpdatedDateUTC", D],
  ]),
  list("Prepayments", "page", [
    ["PrepaymentID", G],
    ["Type", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["Total", N],
    ["RemainingCredit", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("Overpayments", "page", [
    ["OverpaymentID", G],
    ["Type", V],
    ["Status", V],
    ["Contact.Name", V],
    ["Date", D],
    ["Total", N],
    ["RemainingCredit", N],
    ["CurrencyCode", V],
    ["UpdatedDateUTC", D],
  ]),
  list("RepeatingInvoices", "page", [
    ["RepeatingInvoiceID", G],
    ["Type", V],
    ["Status", V],
    ["Reference", V],
    ["Contact.Name", V],
  ]),
  list("Accounts", "all", [
    ["AccountID", G],
    ["Code", V],
    ["Name", V],
    ["Type", V],
    ["Status", V],
    ["TaxType", V],
    ["Class", V],
    ["Description", V],
    ["CurrencyCode", V],
  ]),
  list("Items", "all", [
    ["ItemID", G],
    ["Code", V],
    ["Name", V],
    ["Description", V],
    ["IsSold", B],
    ["IsPurchased", B],
    ["QuantityOnHand", N],
    ["UpdatedDateUTC", D],
  ]),
  list("TaxRates", "all", [
    ["Name", V],
    ["TaxType", V],
    ["Status", V],
    ["ReportTaxType", V],
    ["DisplayTaxRate", N],
    ["EffectiveRate", N],
  ]),
  list("TrackingCategories", "all", [
    ["TrackingCategoryID", G],
    ["Name", V],
    ["Status", V],
  ]),
  list("Users", "all", [
    ["UserID", G],
    ["EmailAddress", V],
    ["FirstName", V],
    ["LastName", V],
    ["OrganisationRole", V],
    ["IsSubscriber", B],
    ["UpdatedDateUTC", D],
  ]),
  list("Currencies", "all", [
    ["Code", V],
    ["Description", V],
  ]),
  list("BrandingThemes", "all", [
    ["BrandingThemeID", G],
    ["Name", V],
  ]),
  list("ContactGroups", "all", [
    ["ContactGroupID", G],
    ["Name", V],
    ["Status", V],
  ]),
  list("BankTransfers", "all", [
    ["BankTransferID", G],
    ["Date", D],
    ["Amount", N],
    ["FromBankAccount.Name", V],
    ["ToBankAccount.Name", V],
  ]),
  list(
    "Organisation",
    "all",
    [
      ["OrganisationID", G],
      ["Name", V],
      ["LegalName", V],
      ["BaseCurrency", V],
      ["CountryCode", V],
      ["OrganisationStatus", V],
      ["ShortCode", V],
    ],
    "Organisations",
  ),
]);

const ENTITY_BY_NAME = new Map(XERO_ENTITIES.map((entity) => [entity.name.toLowerCase(), entity]));

/** The catalog list, or null when the name is not one this connection shows. */
export function xeroEntity(name: string): XeroEntity | null {
  return ENTITY_BY_NAME.get(name.toLowerCase()) ?? null;
}

function columnOf(entity: XeroEntity, name: string): XeroColumn | null {
  const found = entity.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  return found ?? null;
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
    if (c === "-" && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
      i += 1;
      const number = readNumber(sql, i);
      tokens.push({ t: "number", v: -number.value });
      i = number.end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail("Xero could not read that statement.", sql);
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
      if (!closed) fail("Xero could not read that statement.", sql);
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
      if (!closed) fail("Xero could not read that statement.", sql);
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
      const number = readNumber(sql, i);
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
    fail(READ_ONLY, sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

function readNumber(sql: string, start: number): { value: number; end: number } {
  let i = start;
  let raw = "";
  while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
    raw += sql[i];
    i += 1;
  }
  if (sql[i] === "." && (sql[i + 1] ?? "") >= "0" && (sql[i + 1] ?? "") <= "9") {
    raw += ".";
    i += 1;
    while (i < sql.length && (sql[i] ?? "") >= "0" && (sql[i] ?? "") <= "9") {
      raw += sql[i];
      i += 1;
    }
  }
  return { value: Number(raw), end: i };
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeName(name: string, sql: string): string {
  if (name.length > 80 || !SAFE_NAME.test(name)) fail("Write a field name without spaces or punctuation.", sql);
  return name;
}

function quoteXero(value: string, sql: string): string {
  if (/["\\\r\n\u0000]/.test(value)) fail("Write the value on one line, without a quote or a backslash.", sql);
  return `"${value}"`;
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

  parse(): XeroStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("DISTINCT") !== null) fail("Xero reads one SELECT without DISTINCT.", this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private entity(): XeroEntity {
    if (this.word("FROM") === null) fail("Write FROM and a list, such as Invoices.", this.sql);
    const table = this.name();
    if (this.word("JOIN") !== null) fail(ONE_ENTITY, this.sql);
    const found = xeroEntity(table);
    if (found === null) fail("Xero has no table with that name.", this.sql);
    return found;
  }

  private known(entity: XeroEntity, name: string): XeroColumn {
    const column = columnOf(entity, name);
    if (column === null) fail(FIELD_MESSAGE, this.sql);
    return column;
  }

  private literal(): Literal {
    const token = this.peek();
    if (token.t === "string") {
      this.take();
      return { kind: "string", value: token.v };
    }
    if (token.t === "number") {
      this.take();
      return { kind: "number", value: String(token.v) };
    }
    if (token.t === "word" && (token.v.toUpperCase() === "TRUE" || token.v.toUpperCase() === "FALSE")) {
      this.take();
      return { kind: "boolean", value: token.v.toLowerCase() };
    }
    fail("Write the value in quotes, as a number, or as true or false.", this.sql);
  }

  private comparison(column: XeroColumn, op: "=" | "!=" | "<" | ">" | "<=" | ">="): XeroFilter {
    const literal = this.literal();
    const xeroOp = op === "=" ? "==" : op;
    return { text: `${column.name}${xeroOp}${this.value(column, literal)}` };
  }

  private value(column: XeroColumn, literal: Literal): string {
    if (column.type === "double") {
      if (literal.kind !== "number") fail(NUMBER_MESSAGE, this.sql);
      return literal.value;
    }
    if (column.type === "boolean") {
      if (literal.kind !== "boolean") fail(BOOLEAN_MESSAGE, this.sql);
      return literal.value;
    }
    if (column.type === "date") {
      if (literal.kind !== "string") fail(DATE_MESSAGE, this.sql);
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(literal.value);
      if (match === null) fail(DATE_MESSAGE, this.sql);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) fail(DATE_MESSAGE, this.sql);
      return `DateTime(${Number(match[1])},${month},${day})`;
    }
    if (column.type === "guid") {
      if (literal.kind !== "string" || !UUID.test(literal.value)) fail(GUID_MESSAGE, this.sql);
      return `guid("${literal.value.toLowerCase()}")`;
    }
    if (literal.kind !== "string") fail(TEXT_MESSAGE, this.sql);
    return quoteXero(literal.value, this.sql);
  }

  private like(column: XeroColumn): XeroFilter {
    if (column.type !== "varchar") fail(LIKE_TEXT, this.sql);
    const token = this.peek();
    if (token.t !== "string") fail("Write LIKE with a quoted value.", this.sql);
    const literal = this.literal();
    const raw = literal.value;
    const starts = raw.startsWith("%");
    const ends = raw.endsWith("%");
    const inner = raw.slice(starts ? 1 : 0, ends ? raw.length - 1 : raw.length);
    if (inner.includes("%")) fail(LIKE_MESSAGE, this.sql);
    if ((starts || ends) && inner === "") fail("Write a value inside the percent signs.", this.sql);
    const quoted = quoteXero(inner, this.sql);
    if (starts && ends) return { text: `${column.name}.Contains(${quoted})` };
    if (ends) return { text: `${column.name}.StartsWith(${quoted})` };
    if (starts) return { text: `${column.name}.EndsWith(${quoted})` };
    return { text: `${column.name}==${quoted}` };
  }

  private filter(entity: XeroEntity): XeroFilter {
    const column = this.known(entity, this.name());
    if (this.word("IN") !== null) fail("Xero has no IN filter. Compare the field, or use LIKE.", this.sql);
    if (this.word("LIKE") !== null) return this.like(column);
    const op = this.word();
    if (op === "=" || op === "!=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      return this.comparison(column, op === "<>" ? "!=" : op);
    }
    if (op !== null && op.toUpperCase() === "OR") fail(AND_ONLY, this.sql);
    fail("Xero filters with =, !=, <, >, <=, >=, or LIKE.", this.sql);
  }

  private where(entity: XeroEntity): XeroFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters: XeroFilter[] = [];
    for (;;) {
      filters.push(this.filter(entity));
      if (this.word("OR") !== null) fail(AND_ONLY, this.sql);
      if (this.word("AND") === null) break;
    }
    return filters;
  }

  private orderBy(entity: XeroEntity): XeroOrder | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and a field.", this.sql);
    const column = this.known(entity, this.name());
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    if (this.peek().t === "comma") fail("Xero orders by one field.", this.sql);
    return { column: column.name, desc };
  }

  private takeLimit(): { limit: number; capped: boolean } {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 1) {
      fail("Write LIMIT as a whole number greater than zero.", this.sql);
    }
    return { limit: token.v > XERO_ROW_CAP ? XERO_ROW_CAP : token.v, capped: token.v > XERO_ROW_CAP };
  }

  private takeOffset(): number {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0) {
      fail("Write OFFSET as a whole number.", this.sql);
    }
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

  private select(): XeroSelect {
    const requested = this.columns();
    const entity = this.entity();
    const columns = requested === null ? null : requested.map((name) => this.known(entity, name).name);
    const filters = this.where(entity);
    const orderBy = this.orderBy(entity);
    const window = this.limit();
    this.finish();
    return { kind: "select", entity: entity.name, columns, filters, orderBy, ...window };
  }

  private columns(): readonly string[] | null {
    if (this.peek().t === "star") {
      this.take();
      if (this.peek().t === "comma") fail("Write * on its own.", this.sql);
      return null;
    }
    const names: string[] = [];
    for (;;) {
      if (this.peek().t === "star") fail("Write * on its own.", this.sql);
      names.push(this.name());
      if (this.peek().t !== "comma") break;
      this.take();
    }
    return names;
  }

  private count(): XeroCount {
    if (this.peek().t !== "lparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "rparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.word("AS") !== null) this.name();
    const entity = this.entity();
    const filters = this.where(entity);
    if (this.word("ORDER") !== null) fail("COUNT(*) does not take ORDER BY.", this.sql);
    if (this.word("LIMIT") !== null || this.word("OFFSET") !== null) {
      fail("COUNT(*) does not take LIMIT or OFFSET.", this.sql);
    }
    this.finish();
    return { kind: "count", entity: entity.name, filters };
  }
}

/** One statement. The provider sends it as one list request after this returns. */
export function translateXeroSql(sql: string): XeroStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

/** The catalog list, the where text, and the order text for one statement. */
export function xeroQuery(statement: XeroStatement): {
  entity: XeroEntity;
  where: string | null;
  order: string | null;
} {
  const entity = xeroEntity(statement.entity);
  if (entity === null) fail("Xero has no table with that name.", statement.entity);
  const where = statement.filters.length === 0 ? null : statement.filters.map((filter) => filter.text).join("&&");
  const order =
    statement.kind === "select" && statement.orderBy !== null
      ? `${statement.orderBy.column} ${statement.orderBy.desc ? "DESC" : "ASC"}`
      : null;
  return { entity, where, order };
}
