/**
 * The SQL subset a Cin7 Core connection runs.
 *
 * Cin7 Core is an inventory API, not a SQL server. One SELECT or COUNT(*) becomes
 * one GET of a listed resource. Filters are equality only, and only the parameters
 * that resource documents. LIMIT and OFFSET are a page: OFFSET must be a multiple
 * of LIMIT, because the API has no row offset.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "cin7" as const;
const DEFAULT_LIMIT = 100;
const PAGE_CAP = 1000;

export interface Cin7Column {
  readonly name: string;
  readonly type: "varchar" | "double" | "boolean";
}

export interface Cin7Resource {
  readonly name: string;
  readonly path: string;
  readonly listKey: string;
  readonly columns: readonly Cin7Column[];
  /** SQL column → query parameter. A name absent here is not a filter. */
  readonly filters: Readonly<Record<string, string>>;
}

const text = (name: string): Cin7Column => ({ name, type: "varchar" });
const num = (name: string): Cin7Column => ({ name, type: "double" });
const flag = (name: string): Cin7Column => ({ name, type: "boolean" });

function resource(
  name: string,
  path: string,
  listKey: string,
  columns: readonly Cin7Column[],
  filters: Readonly<Record<string, string>>,
): Cin7Resource {
  return { name, path, listKey, columns, filters };
}

/** The lists this connection reads. Paths and list keys are the External API v2 names. */
export const CIN7_RESOURCES: readonly Cin7Resource[] = [
  resource("Product", "/product", "Products", [
    text("ID"), text("SKU"), text("Name"), text("Category"), text("Brand"), text("Type"),
    text("CostingMethod"), text("Status"), text("Barcode"), text("UOM"), num("AverageCost"), num("PriceTier1"),
  ], { ID: "ID", SKU: "Sku", Name: "Name" }),
  resource("Stock", "/ref/productavailability", "ProductAvailabilityList", [
    text("ID"), text("SKU"), text("Name"), text("Barcode"), text("Location"), text("Bin"), text("Batch"),
    text("ExpiryDate"), num("OnHand"), num("Allocated"), num("Available"), num("OnOrder"), num("StockOnHand"),
    num("InTransit"),
  ], { ID: "ID", SKU: "Sku", Name: "Name", Location: "Location", Batch: "Batch", Category: "Category" }),
  resource("Sale", "/saleList", "SaleList", [
    text("SaleID"), text("OrderNumber"), text("Status"), text("OrderDate"), text("Customer"), text("CustomerID"),
    text("InvoiceNumber"), num("InvoiceAmount"), num("PaidAmount"), text("OrderStatus"),
    text("CombinedInvoiceStatus"), text("CombinedPaymentStatus"), text("Type"), text("ExternalID"),
  ], {
    Search: "Search",
    Status: "Status",
    OrderStatus: "OrderStatus",
    QuoteStatus: "QuoteStatus",
    CombinedPickStatus: "CombinedPickStatus",
    CombinedPackStatus: "CombinedPackStatus",
    CombinedShippingStatus: "CombinedShippingStatus",
    CombinedInvoiceStatus: "CombinedInvoiceStatus",
    CreditNoteStatus: "CreditNoteStatus",
    ExternalID: "ExternalID",
  }),
  resource("Purchase", "/purchaseList", "PurchaseList", [
    text("ID"), text("OrderNumber"), text("Status"), text("OrderDate"), text("Supplier"), text("SupplierID"),
    text("InvoiceNumber"), num("InvoiceAmount"), num("PaidAmount"), text("OrderStatus"),
    text("CombinedReceivingStatus"), text("Type"),
  ], {
    Search: "Search",
    Status: "Status",
    OrderStatus: "OrderStatus",
    InvoiceStatus: "InvoiceStatus",
    CreditNoteStatus: "CreditNoteStatus",
    UnstockStatus: "UnstockStatus",
  }),
  resource("Customer", "/customer", "CustomerList", [
    text("ID"), text("Name"), text("Currency"), text("PaymentTerm"), text("Status"), num("Discount"), text("TaxRule"),
  ], { ID: "ID", Name: "Name" }),
  resource("Supplier", "/supplier", "SupplierList", [
    text("ID"), text("Name"), text("Currency"), text("PaymentTerm"), text("Status"), text("TaxRule"),
  ], { ID: "ID", Name: "Name" }),
  resource("Location", "/ref/location", "LocationList", [
    text("ID"), text("Name"), flag("IsDefault"), flag("IsDeprecated"),
  ], { ID: "ID", Name: "Name" }),
  resource("Category", "/ref/category", "CategoryList", [text("ID"), text("Name")], { Name: "Name" }),
  resource("Brand", "/ref/brand", "BrandList", [text("ID"), text("Name")], { Name: "Name" }),
  resource("Account", "/ref/account", "AccountsList", [
    text("Code"), text("Name"), text("Type"), text("Status"), text("Class"),
  ], { Code: "Code", Name: "Name", Type: "Type", Status: "Status" }),
  resource("PaymentTerm", "/ref/paymentterm", "PaymentTermList", [
    text("ID"), text("Name"), num("Duration"), text("Method"), flag("IsActive"), flag("IsDefault"),
  ], { ID: "ID", Name: "Name", Method: "Method", IsActive: "IsActive", IsDefault: "IsDefault" }),
  resource("TaxRule", "/ref/tax", "TaxRuleList", [
    text("ID"), text("Name"), text("Account"), flag("IsActive"),
  ], { ID: "ID", Name: "Name", Account: "Account", IsActive: "IsActive" }),
  resource("Unit", "/ref/unit", "UnitList", [text("ID"), text("Name")], { Name: "Name" }),
];

const BY_NAME = new Map(CIN7_RESOURCES.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog table with this name, or null when the connection does not list it. */
export function cin7Resource(name: string): Cin7Resource | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface Cin7Filter {
  readonly param: string;
  readonly value: string;
}

export interface Cin7ListStatement {
  readonly kind: "list";
  readonly resource: Cin7Resource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly Cin7Filter[];
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface Cin7CountStatement {
  readonly kind: "count";
  readonly resource: Cin7Resource;
  readonly alias: string;
  readonly filters: readonly Cin7Filter[];
}

export type Cin7Statement = Cin7ListStatement | Cin7CountStatement;

interface Word { readonly k: "word"; readonly v: string }
interface Str { readonly k: "string"; readonly v: string }
interface Num { readonly k: "number"; readonly v: string }
interface Ident { readonly k: "ident"; readonly v: string }
interface Mark { readonly k: "star" | "comma" | "eq" | "semi" | "lp" | "rp" | "cmp" | "dot" }
type Token = Word | Str | Num | Ident | Mark;

const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "MERGE", "REPLACE", "GRANT", "REVOKE"]);

function fail(sql: string, message: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

function tokens(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) fail(sql, "Cin7 Core comment was not closed.");
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < sql.length) {
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
      if (!closed) fail(sql, "Cin7 Core string was not closed.");
      out.push({ k: "string", v: value });
      continue;
    }
    if (c === '"') {
      let value = "";
      i += 1;
      let closed = false;
      while (i < sql.length) {
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
      if (!closed) fail(sql, "Cin7 Core name was not closed.");
      out.push({ k: "ident", v: value });
      continue;
    }
    if (c === "?" || c === "$") fail(sql, "Write the value in the statement. Cin7 Core does not bind parameters.");
    if (c === "*") { out.push({ k: "star" }); i += 1; continue; }
    if (c === ",") { out.push({ k: "comma" }); i += 1; continue; }
    if (c === "=") { out.push({ k: "eq" }); i += 1; continue; }
    if (c === "<" || c === ">" || c === "!") {
      while (i < sql.length && "<>!=".includes(sql[i] ?? "")) i += 1;
      out.push({ k: "cmp" });
      continue;
    }
    if (c === ";") { out.push({ k: "semi" }); i += 1; continue; }
    if (c === ".") { out.push({ k: "dot" }); i += 1; continue; }
    if (c === "(") { out.push({ k: "lp" }); i += 1; continue; }
    if (c === ")") { out.push({ k: "rp" }); i += 1; continue; }
    if (/[0-9]/.test(c)) {
      let value = "";
      while (i < sql.length && /[0-9.]/.test(sql[i] ?? "")) {
        value += sql[i];
        i += 1;
      }
      if (value.endsWith(".") || value.split(".").length > 2) fail(sql, "Cin7 Core could not read that number.");
      out.push({ k: "number", v: value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let value = "";
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
        value += sql[i];
        i += 1;
      }
      out.push({ k: "word", v: value });
      continue;
    }
    fail(sql, "Cin7 Core could not read that statement.");
  }
  return out;
}

function word(token: Token | undefined): string | null {
  if (token === undefined) return null;
  if (token.k === "word") return token.v;
  if (token.k === "ident") return token.v;
  return null;
}

function same(token: Token | undefined, expected: string): boolean {
  return token?.k === "word" && token.v.toUpperCase() === expected;
}

/** One read-only statement, or a refusal that names what the subset cannot do. */
export function translateCin7Sql(sql: string): Cin7Statement {
  const scanned = tokens(sql);
  if (scanned.length === 0) fail(sql, "Cin7 Core needs a SELECT.");
  const first = word(scanned[0]);
  if (first !== null && WRITES.has(first.toUpperCase())) {
    fail(sql, "Cin7 Core is read-only. A write is refused before a request.");
  }
  if (!same(scanned[0], "SELECT")) fail(sql, "Cin7 Core runs one SELECT or COUNT(*).");

  let at = 1;
  const count = same(scanned[at], "COUNT");
  let columns: string[] | null = null;
  let alias = "totalCount";
  if (count) {
    at += 1;
    if (scanned[at]?.k !== "lp" || scanned[at + 1]?.k !== "star" || scanned[at + 2]?.k !== "rp") {
      fail(sql, "Cin7 Core counts with COUNT(*).");
    }
    at += 3;
      if (same(scanned[at], "AS")) {
      const name = word(scanned[at + 1]);
      if (name === null || name === "" || same(scanned[at + 1], "FROM") || same(scanned[at + 1], "WHERE")) {
        fail(sql, "Cin7 Core needs a name after AS.");
      }
      alias = name;
      at += 2;
    }
  } else if (scanned[at]?.k === "star") {
    columns = null;
    at += 1;
  } else {
    const names: string[] = [];
    while (at < scanned.length && !same(scanned[at], "FROM")) {
      const name = word(scanned[at]);
      if (name === null) fail(sql, "Cin7 Core needs a column name.");
      names.push(name);
      at += 1;
      if (scanned[at]?.k === "comma") at += 1;
    }
    if (names.length === 0) fail(sql, "Cin7 Core needs a column name.");
    columns = names;
  }

  if (!same(scanned[at], "FROM")) fail(sql, "Cin7 Core needs FROM and one table.");
  at += 1;
  const table = word(scanned[at]);
  if (table === null) fail(sql, "Cin7 Core needs FROM and one table.");
  const found = cin7Resource(table);
  if (found === null) fail(sql, `Cin7 Core has no table named ${table}.`);
  at += 1;

  const filters: Cin7Filter[] = [];
  if (same(scanned[at], "WHERE")) {
    at += 1;
    for (;;) {
      if (same(scanned[at], "OR")) fail(sql, "Cin7 Core combines filters with AND.");
      if (same(scanned[at], "LIKE") || same(scanned[at], "IN") || same(scanned[at], "BETWEEN")) {
        fail(sql, "Cin7 Core filters with =.");
      }
      const column = word(scanned[at]);
      if (column === null) fail(sql, "Cin7 Core needs a column after WHERE.");
      at += 1;
      if (scanned[at]?.k !== "eq") fail(sql, "Cin7 Core filters with =.");
      at += 1;
      const value = literal(sql, scanned[at]);
      at += 1;
      const param = found.filters[column] ?? found.filters[Object.keys(found.filters).find((key) => key.toLowerCase() === column.toLowerCase()) ?? ""];
      if (param === undefined) fail(sql, `Cin7 Core cannot filter ${found.name} on ${column}.`);
      filters.push({ param, value });
      if (same(scanned[at], "AND")) {
        at += 1;
        continue;
      }
      if (same(scanned[at], "OR")) fail(sql, "Cin7 Core combines filters with AND.");
      break;
    }
  }

  if (same(scanned[at], "ORDER")) fail(sql, "Cin7 Core does not sort a page.");
  if (same(scanned[at], "JOIN") || same(scanned[at], "GROUP") || same(scanned[at], "UNION")) {
    fail(sql, "Cin7 Core reads one table.");
  }

  let limit = DEFAULT_LIMIT;
  let offset = 0;
  let capped = false;
  if (same(scanned[at], "LIMIT")) {
    if (count) fail(sql, "COUNT(*) does not take LIMIT. The count is the whole list.");
    at += 1;
    const parsed = whole(sql, scanned[at], "LIMIT");
    at += 1;
    if (parsed < 1) fail(sql, "LIMIT must be a positive whole number.");
    if (parsed > PAGE_CAP) {
      limit = PAGE_CAP;
      capped = true;
    } else {
      limit = parsed;
    }
  }
  if (same(scanned[at], "OFFSET")) {
    if (count) fail(sql, "COUNT(*) does not take OFFSET. The count is the whole list.");
    at += 1;
    offset = whole(sql, scanned[at], "OFFSET");
    at += 1;
    if (offset % limit !== 0) fail(sql, "OFFSET must be a multiple of LIMIT, because Cin7 Core reads pages.");
  }
  if (scanned[at]?.k === "semi") at += 1;
  if (at < scanned.length) fail(sql, "Cin7 Core runs one statement.");

  if (count) return { kind: "count", resource: found, alias, filters };
  return { kind: "list", resource: found, columns, filters, limit, offset, capped };
}

function literal(sql: string, token: Token | undefined): string {
  if (token?.k === "string") return token.v;
  if (token?.k === "number") return token.v;
  if (token?.k === "word" && (token.v.toLowerCase() === "true" || token.v.toLowerCase() === "false")) {
    return token.v.toLowerCase();
  }
  fail(sql, "Cin7 Core filters on a quoted value, a number, or true and false.");
}

function whole(sql: string, token: Token | undefined, label: string): number {
  if (token?.k !== "number" || !/^[0-9]+$/.test(token.v)) fail(sql, `${label} must be a whole number.`);
  return Number(token.v);
}
