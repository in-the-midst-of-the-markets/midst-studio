/**
 * The SQL subset a ShipBob connection runs.
 *
 * ShipBob is a fulfillment API, not a SQL server. One SELECT becomes one GET:
 * orders, products, inventory levels, or channels. Filters are equality only.
 * COUNT(*) is the channel list, which arrives in one response. The other lists
 * have no total, so they have no COUNT.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "shipbob" as const;

export interface ShipBobColumn {
  readonly name: string;
  readonly type: "varchar" | "double";
}

export interface ShipBobResource {
  readonly name: string;
  readonly columns: readonly ShipBobColumn[];
  /** SQL name → query parameter. */
  readonly filters: Readonly<Record<string, string>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly integers: readonly string[];
  readonly dates: readonly string[];
  readonly countable: boolean;
  readonly paging:
    | { readonly mode: "page"; readonly maxLimit: number; readonly maxPage: number }
    | { readonly mode: "cursor"; readonly pageSize: number; readonly maxPages: number }
    | { readonly mode: "once"; readonly maxLimit: number };
}

const text = (name: string): ShipBobColumn => ({ name, type: "varchar" });
const num = (name: string): ShipBobColumn => ({ name, type: "double" });

/** The lists this connection reads. Names are the ones the editor offers. */
export const SHIPBOB_RESOURCES: readonly ShipBobResource[] = [
  {
    name: "Order",
    columns: [
      text("Id"),
      text("OrderNumber"),
      text("ReferenceId"),
      text("Status"),
      text("Type"),
      text("CreatedDate"),
      text("PurchaseDate"),
      text("ShippingMethod"),
      text("RecipientName"),
      text("RecipientCity"),
      text("RecipientCountry"),
      text("ChannelId"),
    ],
    filters: {
      Id: "IDs",
      ReferenceId: "ReferenceIds",
      StartDate: "StartDate",
      EndDate: "EndDate",
      SortOrder: "SortOrder",
    },
    enums: { SortOrder: ["Newest", "Oldest"] },
    integers: ["Id"],
    dates: ["StartDate", "EndDate"],
    countable: false,
    paging: { mode: "page", maxLimit: 100, maxPage: 20 },
  },
  {
    name: "Product",
    columns: [
      text("Id"),
      text("Name"),
      text("Type"),
      text("CreatedOn"),
      text("Sku"),
      text("VariantId"),
      text("VariantStatus"),
    ],
    filters: { Search: "Search", SKU: "SKU", Name: "Name" },
    enums: {},
    integers: [],
    dates: [],
    countable: false,
    paging: { mode: "cursor", pageSize: 250, maxPages: 10 },
  },
  {
    name: "Inventory",
    columns: [
      text("InventoryId"),
      text("Name"),
      text("Sku"),
      num("Fulfillable"),
      num("OnHand"),
      num("Committed"),
      num("Sellable"),
      num("Awaiting"),
      num("Backordered"),
    ],
    filters: { SearchBy: "SearchBy", IsActive: "IsActive" },
    enums: {},
    integers: [],
    dates: [],
    countable: false,
    paging: { mode: "cursor", pageSize: 100, maxPages: 10 },
  },
  {
    name: "Channel",
    columns: [text("Id"), text("Name"), text("ApplicationName")],
    filters: {},
    enums: {},
    integers: [],
    dates: [],
    countable: true,
    paging: { mode: "once", maxLimit: 250 },
  },
];

const BY_NAME = new Map(SHIPBOB_RESOURCES.map((entry) => [entry.name.toLowerCase(), entry]));

/** The catalog table with this name, or null when the connection does not list it. */
export function shipBobResource(name: string): ShipBobResource | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface ShipBobFilter {
  readonly name: string;
  readonly param: string;
  readonly value: string;
}

export interface ShipBobListStatement {
  readonly kind: "list";
  readonly resource: ShipBobResource;
  readonly columns: readonly string[] | null;
  readonly filters: readonly ShipBobFilter[];
  readonly limit: number;
  readonly offset: number;
  /** True when LIMIT was larger than the page the API returns. */
  readonly capped: boolean;
}

export interface ShipBobCountStatement {
  readonly kind: "count";
  readonly resource: ShipBobResource;
  readonly alias: string;
  readonly filters: readonly ShipBobFilter[];
}

export type ShipBobStatement = ShipBobListStatement | ShipBobCountStatement;

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

const PRINTABLE = /^[\x20-\x7e]+$/;
const DATE_VALUE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z)?$/;

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
      if (end < 0) fail(sql, "ShipBob comment was not closed.");
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
      if (!closed) fail(sql, "ShipBob string was not closed.");
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
      if (!closed) fail(sql, "ShipBob name was not closed.");
      out.push({ k: "ident", v: value });
      continue;
    }
    if (c === "?" || c === "$") fail(sql, "Write the value in the statement. ShipBob does not bind parameters.");
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
      if (value.endsWith(".") || value.split(".").length > 2) fail(sql, "ShipBob could not read that number.");
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
    fail(sql, "ShipBob could not read that statement.");
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

function filterParam(resource: ShipBobResource, column: string): string | undefined {
  if (resource.filters[column] !== undefined) return resource.filters[column];
  const found = Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase());
  return found === undefined ? undefined : resource.filters[found];
}

function filterName(resource: ShipBobResource, column: string): string {
  if (resource.filters[column] !== undefined) return column;
  return Object.keys(resource.filters).find((key) => key.toLowerCase() === column.toLowerCase()) ?? column;
}

function checkFilter(sql: string, resource: ShipBobResource, name: string, value: string): void {
  const allowed = resource.enums[name];
  if (allowed !== undefined && !allowed.includes(value)) {
    fail(sql, `ShipBob ${name} must be ${allowed.join(" or ")}.`);
  }
  if (resource.integers.includes(name) && !/^[0-9]+$/.test(value)) {
    fail(sql, `ShipBob ${name} must be a whole number.`);
  }
  if (resource.dates.includes(name)) {
    if (!DATE_VALUE.test(value) || !Number.isFinite(Date.parse(value))) {
      fail(sql, "ShipBob dates are calendar days or instants, such as 2024-07-18 or 2024-07-18T00:00:00Z.");
    }
  } else if (
    allowed === undefined &&
    !resource.integers.includes(name) &&
    (!PRINTABLE.test(value) || value.length > 200)
  ) {
    fail(sql, "ShipBob filter values are printable text, at most 200 characters.");
  }
}

/** One read-only statement, or a refusal that names what the subset cannot do. */
export function translateShipBobSql(sql: string): ShipBobStatement {
  const scanned = tokens(sql);
  if (scanned.length === 0) fail(sql, "ShipBob needs a SELECT.");
  const first = word(scanned[0]);
  if (first !== null && WRITES.has(first.toUpperCase())) {
    fail(sql, "ShipBob is read-only. A write is refused before a request.");
  }
  if (!same(scanned[0], "SELECT")) fail(sql, "ShipBob runs one SELECT or COUNT(*).");

  let at = 1;
  const count = same(scanned[at], "COUNT");
  let columns: string[] | null = null;
  let alias = "totalCount";
  if (count) {
    at += 1;
    if (scanned[at]?.k !== "lp" || scanned[at + 1]?.k !== "star" || scanned[at + 2]?.k !== "rp") {
      fail(sql, "ShipBob counts with COUNT(*).");
    }
    at += 3;
    if (same(scanned[at], "AS")) {
      const name = word(scanned[at + 1]);
      if (name === null || name === "" || same(scanned[at + 1], "FROM") || same(scanned[at + 1], "WHERE")) {
        fail(sql, "ShipBob needs a name after AS.");
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
      if (name === null) fail(sql, "ShipBob needs a column name.");
      names.push(name);
      at += 1;
      if (scanned[at]?.k === "comma") at += 1;
    }
    if (names.length === 0) fail(sql, "ShipBob needs a column name.");
    columns = names;
  }

  if (!same(scanned[at], "FROM")) fail(sql, "ShipBob needs FROM and one table.");
  at += 1;
  const table = word(scanned[at]);
  if (table === null) fail(sql, "ShipBob needs FROM and one table.");
  const found = shipBobResource(table);
  if (found === null) fail(sql, `ShipBob has no table named ${table}.`);
  at += 1;

  const filters: ShipBobFilter[] = [];
  if (same(scanned[at], "WHERE")) {
    at += 1;
    for (;;) {
      if (same(scanned[at], "OR")) fail(sql, "ShipBob combines filters with AND.");
      if (same(scanned[at], "LIKE") || same(scanned[at], "IN") || same(scanned[at], "BETWEEN")) {
        fail(sql, "ShipBob filters with =.");
      }
      const column = word(scanned[at]);
      if (column === null) fail(sql, "ShipBob needs a column after WHERE.");
      at += 1;
      if (scanned[at]?.k === "cmp") fail(sql, "ShipBob filters with =.");
      if (scanned[at]?.k !== "eq") fail(sql, "ShipBob filters with =.");
      at += 1;
      const value = literal(sql, scanned[at]);
      at += 1;
      const param = filterParam(found, column);
      if (param === undefined) fail(sql, `ShipBob cannot filter ${found.name} on ${column}.`);
      const name = filterName(found, column);
      checkFilter(sql, found, name, value);
      filters.push({ name, param, value });
      if (same(scanned[at], "AND")) {
        at += 1;
        continue;
      }
      if (same(scanned[at], "OR")) fail(sql, "ShipBob combines filters with AND.");
      break;
    }
  }

  if (same(scanned[at], "ORDER")) fail(sql, "ShipBob does not sort a page.");
  if (same(scanned[at], "JOIN") || scanned[at]?.k === "dot") fail(sql, "ShipBob reads one table.");
  if (same(scanned[at], "GROUP") || same(scanned[at], "UNION")) fail(sql, "ShipBob reads one table.");

  const start = filters.find((filter) => filter.name === "StartDate")?.value;
  const end = filters.find((filter) => filter.name === "EndDate")?.value;
  if (start !== undefined && end !== undefined && Date.parse(end) < Date.parse(start)) {
    fail(sql, "ShipBob EndDate must be the same instant as StartDate or later.");
  }

  const pageSize =
    found.paging.mode === "once"
      ? found.paging.maxLimit
      : found.paging.mode === "page"
        ? found.paging.maxLimit
        : found.paging.pageSize;
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
      if (offset % limit !== 0) fail(sql, "OFFSET must be a multiple of LIMIT, because ShipBob reads pages.");
      if (offset / limit + 1 > found.paging.maxPage) fail(sql, "ShipBob order pages stop at 20.");
    } else if (found.paging.mode === "cursor") {
      if (offset % limit !== 0 || offset / limit >= found.paging.maxPages) {
        fail(sql, "OFFSET must be a multiple of LIMIT, and ShipBob follows at most 10 pages.");
      }
    } else if (offset > 10_000) {
      fail(sql, "OFFSET must be at most 10000.");
    }
  }
  if (scanned[at]?.k === "semi") at += 1;
  if (at < scanned.length) fail(sql, "ShipBob runs one statement.");
  if (count && !found.countable) fail(sql, `ShipBob ${found.name} has no total to count. Read the page.`);

  if (count) return { kind: "count", resource: found, alias, filters };
  return { kind: "list", resource: found, columns, filters, limit, offset, capped };
}

function literal(sql: string, token: Token | undefined): string {
  if (token?.k === "string") return token.v;
  if (token?.k === "number") return token.v;
  if (token?.k === "word" && (token.v.toLowerCase() === "true" || token.v.toLowerCase() === "false")) {
    return token.v.toLowerCase();
  }
  fail(sql, "ShipBob filters on a quoted value, a number, or true and false.");
}

function whole(sql: string, token: Token | undefined, label: string): number {
  if (token?.k !== "number" || !/^[0-9]+$/.test(token.v)) fail(sql, `${label} must be a whole number.`);
  return Number(token.v);
}
