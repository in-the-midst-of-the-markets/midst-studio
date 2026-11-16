/**
 * The SQL subset an Amazon Business connection runs.
 *
 * Amazon Business is a buying API, not a SQL server. One SELECT becomes one GET:
 * a product search, one ASIN, orders in a 24-hour window, the lines on those
 * orders, or reconciliation transactions. Filters are equality only. COUNT(*)
 * is the product search total. Orders and transactions have no total, so they
 * have no COUNT.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "amazonbusiness" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AmazonColumn {
  readonly name: string;
  readonly type: "varchar" | "double";
}

export interface AmazonResource {
  readonly name: string;
  readonly columns: readonly AmazonColumn[];
  /** SQL name → query parameter. ASIN is a path segment, not a parameter. */
  readonly filters: Readonly<Record<string, string>>;
  /** Each inner list must all be present, and any one inner list is enough. */
  readonly required: readonly (readonly string[])[];
  readonly countable: boolean;
  readonly paging:
    | { readonly mode: "page"; readonly maxLimit: number; readonly maxPage: number }
    | { readonly mode: "token"; readonly pageSize: number; readonly maxPages: number };
  /** When set, the two named filters are instants and their span must be at most a day. */
  readonly dayWindow: readonly [string, string] | null;
}

const text = (name: string): AmazonColumn => ({ name, type: "varchar" });
const num = (name: string): AmazonColumn => ({ name, type: "double" });

/** The lists this connection reads. Names are the ones the editor offers. */
export const AMAZON_BUSINESS_RESOURCES: readonly AmazonResource[] = [
  {
    name: "Product",
    columns: [
      text("ASIN"),
      text("Title"),
      text("AsinType"),
      text("Availability"),
      num("Price"),
      text("Currency"),
      text("Merchant"),
      text("Condition"),
      text("OfferId"),
    ],
    filters: {
      Keywords: "keywords",
      ASIN: "asin",
      ProductRegion: "productRegion",
      Locale: "locale",
      Category: "category",
      SubCategory: "subCategory",
      Availability: "availability",
      ShippingPostalCode: "shippingPostalCode",
      GroupTag: "groupTag",
    },
    required: [["Keywords"], ["ASIN"]],
    countable: true,
    paging: { mode: "page", maxLimit: 24, maxPage: 13 },
    dayWindow: null,
  },
  {
    name: "Order",
    columns: [
      text("OrderId"),
      text("OrderDate"),
      text("PurchaseOrderNumber"),
      text("OrderStatus"),
      num("OrderQuantity"),
      text("BuyerName"),
      text("BuyerEmail"),
      text("BuyerGroup"),
      num("SubTotal"),
      num("Shipping"),
      num("Tax"),
      num("NetTotal"),
      text("Currency"),
    ],
    filters: { StartDate: "startDate", EndDate: "endDate" },
    required: [["StartDate", "EndDate"]],
    countable: false,
    paging: { mode: "token", pageSize: 100, maxPages: 10 },
    dayWindow: ["StartDate", "EndDate"],
  },
  {
    name: "LineItem",
    columns: [
      text("OrderId"),
      text("OrderDate"),
      text("ASIN"),
      text("Title"),
      text("Brand"),
      num("Quantity"),
      num("Price"),
      num("NetTotal"),
      text("Currency"),
      text("Seller"),
      text("Category"),
      text("Condition"),
    ],
    filters: { StartDate: "startDate", EndDate: "endDate" },
    required: [["StartDate", "EndDate"]],
    countable: false,
    paging: { mode: "token", pageSize: 100, maxPages: 10 },
    dayWindow: ["StartDate", "EndDate"],
  },
  {
    name: "Transaction",
    columns: [
      text("TransactionId"),
      text("TransactionDate"),
      text("FeedDate"),
      text("TransactionType"),
      text("InvoiceNumber"),
      num("Amount"),
      text("Currency"),
      text("PaymentInstrument"),
      text("Last4"),
      text("BuyerName"),
      text("BuyerEmail"),
      text("LegalEntity"),
      text("GroupName"),
      text("MarketplaceId"),
    ],
    filters: { FeedStartDate: "feedStartDate", FeedEndDate: "feedEndDate" },
    required: [["FeedStartDate", "FeedEndDate"]],
    countable: false,
    paging: { mode: "token", pageSize: 100, maxPages: 10 },
    dayWindow: null,
  },
];

const BY_NAME = new Map(AMAZON_BUSINESS_RESOURCES.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog table with this name, or null when the connection does not list it. */
export function amazonBusinessResource(name: string): AmazonResource | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface AmazonFilter {
  readonly name: string;
  readonly param: string;
  readonly value: string;
}

export interface AmazonListStatement {
  readonly kind: "list";
  readonly resource: AmazonResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly AmazonFilter[];
  readonly limit: number;
  readonly offset: number;
  /** True when LIMIT was larger than the page the API returns. */
  readonly capped: boolean;
}

export interface AmazonCountStatement {
  readonly kind: "count";
  readonly resource: AmazonResource;
  readonly alias: string;
  readonly filters: readonly AmazonFilter[];
}

export type AmazonStatement = AmazonListStatement | AmazonCountStatement;

interface Word {
  readonly k: "word";
  readonly v: string;
}
interface Str {
  readonly k: "string";
  readonly v: string;
}
interface Num {
  readonly k: "number";
  readonly v: string;
}
interface Ident {
  readonly k: "ident";
  readonly v: string;
}
interface Mark {
  readonly k: "star" | "comma" | "eq" | "semi" | "lp" | "rp" | "cmp" | "dot";
}
type Token = Word | Str | Num | Ident | Mark;

const WRITES = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "MERGE",
  "REPLACE",
  "GRANT",
  "REVOKE",
]);

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
      if (end < 0) fail(sql, "Amazon Business comment was not closed.");
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
      if (!closed) fail(sql, "Amazon Business string was not closed.");
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
      if (!closed) fail(sql, "Amazon Business name was not closed.");
      out.push({ k: "ident", v: value });
      continue;
    }
    if (c === "?" || c === "$")
      fail(sql, "Write the value in the statement. Amazon Business does not bind parameters.");
    if (c === "*") {
      out.push({ k: "star" });
      i += 1;
      continue;
    }
    if (c === ",") {
      out.push({ k: "comma" });
      i += 1;
      continue;
    }
    if (c === "=") {
      out.push({ k: "eq" });
      i += 1;
      continue;
    }
    if (c === "<" || c === ">" || c === "!") {
      while (i < sql.length && "<>!=".includes(sql[i] ?? "")) i += 1;
      out.push({ k: "cmp" });
      continue;
    }
    if (c === ";") {
      out.push({ k: "semi" });
      i += 1;
      continue;
    }
    if (c === ".") {
      out.push({ k: "dot" });
      i += 1;
      continue;
    }
    if (c === "(") {
      out.push({ k: "lp" });
      i += 1;
      continue;
    }
    if (c === ")") {
      out.push({ k: "rp" });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let value = "";
      while (i < sql.length && /[0-9.]/.test(sql[i] ?? "")) {
        value += sql[i];
        i += 1;
      }
      if (value.endsWith(".") || value.split(".").length > 2) fail(sql, "Amazon Business could not read that number.");
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
    fail(sql, "Amazon Business could not read that statement.");
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

function filterParam(resource: AmazonResource, column: string): string | undefined {
  if (resource.filters[column] !== undefined) return resource.filters[column];
  const found = Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? undefined : resource.filters[found];
}

function filterName(resource: AmazonResource, column: string): string {
  if (resource.filters[column] !== undefined) return column;
  return Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase()) ?? column;
}

/** One read-only statement, or a refusal that names what the subset cannot do. */
export function translateAmazonBusinessSql(sql: string): AmazonStatement {
  const scanned = tokens(sql);
  if (scanned.length === 0) fail(sql, "Amazon Business needs a SELECT.");
  const first = word(scanned[0]);
  if (first !== null && WRITES.has(first.toUpperCase())) {
    fail(sql, "Amazon Business is read-only. A write is refused before a request.");
  }
  if (!same(scanned[0], "SELECT")) fail(sql, "Amazon Business runs one SELECT or COUNT(*).");

  let at = 1;
  const count = same(scanned[at], "COUNT");
  let columns: string[] | null = null;
  let alias = "totalCount";
  if (count) {
    at += 1;
    if (scanned[at]?.k !== "lp" || scanned[at + 1]?.k !== "star" || scanned[at + 2]?.k !== "rp") {
      fail(sql, "Amazon Business counts with COUNT(*).");
    }
    at += 3;
    if (same(scanned[at], "AS")) {
      const name = word(scanned[at + 1]);
      if (name === null || name === "" || same(scanned[at + 1], "FROM") || same(scanned[at + 1], "WHERE")) {
        fail(sql, "Amazon Business needs a name after AS.");
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
      if (name === null) fail(sql, "Amazon Business needs a column name.");
      names.push(name);
      at += 1;
      if (scanned[at]?.k === "comma") at += 1;
    }
    if (names.length === 0) fail(sql, "Amazon Business needs a column name.");
    columns = names;
  }

  if (!same(scanned[at], "FROM")) fail(sql, "Amazon Business needs FROM and one table.");
  at += 1;
  const table = word(scanned[at]);
  if (table === null) fail(sql, "Amazon Business needs FROM and one table.");
  const found = amazonBusinessResource(table);
  if (found === null) fail(sql, `Amazon Business has no table named ${table}.`);
  at += 1;

  const filters: AmazonFilter[] = [];
  if (same(scanned[at], "WHERE")) {
    at += 1;
    for (;;) {
      if (same(scanned[at], "OR")) fail(sql, "Amazon Business combines filters with AND.");
      if (same(scanned[at], "LIKE") || same(scanned[at], "IN") || same(scanned[at], "BETWEEN")) {
        fail(sql, "Amazon Business filters with =.");
      }
      const column = word(scanned[at]);
      if (column === null) fail(sql, "Amazon Business needs a column after WHERE.");
      at += 1;
      if (scanned[at]?.k === "cmp") fail(sql, "Amazon Business filters with =.");
      if (scanned[at]?.k !== "eq") fail(sql, "Amazon Business filters with =.");
      at += 1;
      const value = literal(sql, scanned[at]);
      at += 1;
      const param = filterParam(found, column);
      if (param === undefined) fail(sql, `Amazon Business cannot filter ${found.name} on ${column}.`);
      filters.push({ name: filterName(found, column), param, value });
      if (same(scanned[at], "AND")) {
        at += 1;
        continue;
      }
      if (same(scanned[at], "OR")) fail(sql, "Amazon Business combines filters with AND.");
      break;
    }
  }

  if (same(scanned[at], "ORDER")) fail(sql, "Amazon Business does not sort a page.");
  if (same(scanned[at], "JOIN") || scanned[at]?.k === "dot") fail(sql, "Amazon Business reads one table.");
  if (same(scanned[at], "GROUP") || same(scanned[at], "UNION")) fail(sql, "Amazon Business reads one table.");

  const present = new Set(filters.map((filter) => filter.name));
  if (present.has("Keywords") && present.has("ASIN")) {
    fail(sql, "Amazon Business searches by Keywords or reads one ASIN.");
  }
  const satisfied = found.required.some((group) => group.every((name) => present.has(name)));
  if (!satisfied) {
    const need = found.required.map((group) => group.join(" and ")).join(", or ");
    fail(sql, `Amazon Business ${found.name} needs ${need}.`);
  }
  if (found.dayWindow !== null) {
    const [startName, endName] = found.dayWindow;
    const start = Date.parse(filters.find((filter) => filter.name === startName)?.value ?? "");
    const end = Date.parse(filters.find((filter) => filter.name === endName)?.value ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail(sql, "Amazon Business order dates are instants, such as 2024-07-18T00:00:00Z.");
    }
    if (end < start || end - start > DAY_MS) {
      fail(sql, "Amazon Business order dates must span at most 24 hours.");
    }
  }

  const pageSize = found.paging.mode === "page" ? found.paging.maxLimit : found.paging.pageSize;
  let limit = pageSize;
  let offset = 0;
  let capped = false;
  if (same(scanned[at], "LIMIT")) {
    if (count) fail(sql, "COUNT(*) does not take LIMIT.");
    at += 1;
    const parsed = whole(sql, scanned[at], "LIMIT");
    at += 1;
    if (parsed < 1) fail(sql, "LIMIT must be a positive whole number.");
    if (parsed > pageSize) {
      limit = pageSize;
      capped = true;
    } else {
      limit = parsed;
    }
  }
  if (same(scanned[at], "OFFSET")) {
    if (count) fail(sql, "COUNT(*) does not take OFFSET.");
    at += 1;
    offset = whole(sql, scanned[at], "OFFSET");
    at += 1;
    if (found.paging.mode === "page") {
      if (offset % limit !== 0) fail(sql, "OFFSET must be a multiple of LIMIT, because Amazon Business reads pages.");
      if (offset / limit >= found.paging.maxPage) fail(sql, "Amazon Business product search stops after 13 pages.");
    } else if (offset % pageSize !== 0 || offset / pageSize >= found.paging.maxPages) {
      fail(sql, "OFFSET must be a multiple of 100, and at most 900, because Amazon Business pages by token.");
    }
  }
  if (scanned[at]?.k === "semi") at += 1;
  if (at < scanned.length) fail(sql, "Amazon Business runs one statement.");
  if (count && !found.countable) fail(sql, `Amazon Business ${found.name} has no total to count. Read the page.`);

  if (count) return { kind: "count", resource: found, alias, filters };
  return { kind: "list", resource: found, columns, filters, limit, offset, capped };
}

function literal(sql: string, token: Token | undefined): string {
  if (token?.k === "string") return token.v;
  if (token?.k === "number") return token.v;
  if (token?.k === "word" && (token.v.toLowerCase() === "true" || token.v.toLowerCase() === "false")) {
    return token.v.toLowerCase();
  }
  fail(sql, "Amazon Business filters on a quoted value, a number, or true and false.");
}

function whole(sql: string, token: Token | undefined, label: string): number {
  if (token?.k !== "number" || !/^[0-9]+$/.test(token.v)) fail(sql, `${label} must be a whole number.`);
  return Number(token.v);
}
