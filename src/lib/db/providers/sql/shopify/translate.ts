/**
 * The SQL subset a Shopify connection runs.
 *
 * Shopify's Admin API is GraphQL, not a SQL server. The editor still runs one
 * SELECT or COUNT(*) against one resource. This module turns that statement
 * into a search string and a GraphQL document. A write, a join, OR, and a
 * second statement fail here, before a request.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "shopify" as const;
const READ_ONLY = "Shopify is read-only. Write one SELECT or COUNT(*).";
const ONE_TABLE = "Shopify reads one table. A join is not a query this connection runs.";
const AND_ONLY = "Shopify combines filters with AND.";
const ONE_STATEMENT = "Shopify runs one statement at a time.";

export const SHOPIFY_PAGE_SIZE = 250;
export const SHOPIFY_SCAN_CAP = 1000;
export const SHOPIFY_DEFAULT_LIMIT = 50;

export interface ShopifyColumn {
  readonly name: string;
  readonly type: string;
}

export interface ShopifyTable {
  readonly name: string;
  readonly listField: string;
  readonly countField: string;
  readonly sortType: string;
  readonly node: string;
  readonly columns: readonly ShopifyColumn[];
  readonly search: Readonly<Record<string, string>>;
  readonly sort: Readonly<Record<string, string>>;
}

const VARCHAR = "varchar";
const INTEGER = "integer";

function cols(names: readonly string[], types: Readonly<Record<string, string>> = {}): readonly ShopifyColumn[] {
  return names.map((name) => ({ name, type: types[name] ?? VARCHAR }));
}

function table(spec: ShopifyTable): ShopifyTable {
  return spec;
}

/** The resources this connection lists. The names are the SQL table names. */
export const SHOPIFY_TABLES: readonly ShopifyTable[] = Object.freeze([
  table({
    name: "products",
    listField: "products",
    countField: "productsCount",
    sortType: "ProductSortKeys",
    node: "id title handle status vendor productType totalInventory createdAt updatedAt",
    columns: cols(
      ["id", "title", "handle", "status", "vendor", "productType", "totalInventory", "createdAt", "updatedAt"],
      { totalInventory: INTEGER },
    ),
    search: {
      id: "id",
      title: "title",
      handle: "handle",
      status: "status",
      vendor: "vendor",
      productType: "product_type",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    sort: {
      id: "ID",
      title: "TITLE",
      vendor: "VENDOR",
      productType: "PRODUCT_TYPE",
      totalInventory: "INVENTORY_TOTAL",
      createdAt: "CREATED_AT",
      updatedAt: "UPDATED_AT",
    },
  }),
  table({
    name: "variants",
    listField: "productVariants",
    countField: "productVariantsCount",
    sortType: "ProductVariantSortKeys",
    node: "id title sku price inventoryQuantity product { id title }",
    columns: cols(["id", "title", "sku", "price", "inventoryQuantity", "productId", "productTitle"], {
      inventoryQuantity: INTEGER,
    }),
    search: { id: "id", title: "title", sku: "sku" },
    sort: { id: "ID", title: "TITLE", sku: "SKU", inventoryQuantity: "INVENTORY_QUANTITY" },
  }),
  table({
    name: "customers",
    listField: "customers",
    countField: "customersCount",
    sortType: "CustomerSortKeys",
    node: "id displayName email phone numberOfOrders createdAt",
    columns: cols(["id", "displayName", "email", "phone", "numberOfOrders", "createdAt"], {
      numberOfOrders: INTEGER,
    }),
    search: { id: "id", email: "email", phone: "phone", createdAt: "created_at" },
    sort: { id: "ID", displayName: "NAME", createdAt: "CREATED_AT" },
  }),
  table({
    name: "orders",
    listField: "orders",
    countField: "ordersCount",
    sortType: "OrderSortKeys",
    node: "id name email displayFinancialStatus displayFulfillmentStatus createdAt totalPriceSet { shopMoney { amount currencyCode } }",
    columns: cols([
      "id",
      "name",
      "email",
      "displayFinancialStatus",
      "displayFulfillmentStatus",
      "totalPrice",
      "currencyCode",
      "createdAt",
    ]),
    search: {
      id: "id",
      name: "name",
      email: "email",
      displayFinancialStatus: "financial_status",
      displayFulfillmentStatus: "fulfillment_status",
      createdAt: "created_at",
    },
    sort: {
      id: "ID",
      name: "ORDER_NUMBER",
      displayFinancialStatus: "FINANCIAL_STATUS",
      displayFulfillmentStatus: "FULFILLMENT_STATUS",
      totalPrice: "TOTAL_PRICE",
      createdAt: "CREATED_AT",
    },
  }),
  table({
    name: "collections",
    listField: "collections",
    countField: "collectionsCount",
    sortType: "CollectionSortKeys",
    node: "id title handle updatedAt productsCount { count }",
    columns: cols(["id", "title", "handle", "productsCount", "updatedAt"], { productsCount: INTEGER }),
    search: { id: "id", title: "title", handle: "handle", updatedAt: "updated_at" },
    sort: { id: "ID", title: "TITLE", updatedAt: "UPDATED_AT" },
  }),
]);

const TABLE_BY_NAME = new Map(SHOPIFY_TABLES.map((table) => [table.name.toLowerCase(), table]));

/** The catalog table, or null when the name is not one this connection lists. */
export function shopifyTable(name: string): ShopifyTable | null {
  return TABLE_BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface ShopifyFilter {
  readonly column: string;
  readonly op: "=" | "!=" | "<>" | "<" | ">" | "<=" | ">=" | "LIKE";
  readonly value: string;
}

export interface ShopifyList {
  readonly kind: "select";
  readonly table: ShopifyTable;
  readonly columns: readonly string[] | null;
  readonly search: string | null;
  readonly sortKey: string | null;
  readonly reverse: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly capped: boolean;
}

export interface ShopifyCount {
  readonly kind: "count";
  readonly table: ShopifyTable;
  readonly search: string | null;
  readonly alias: string;
}

export type ShopifyStatement = ShopifyList | ShopifyCount;

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
      if (end < 0) fail("Shopify could not read that statement.", sql);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let value = "";
      i += 1;
      let closed = false;
      while (i < length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) fail("Shopify could not read that statement.", sql);
      tokens.push(quote === "'" ? { t: "string", v: value } : { t: "ident", v: value });
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
      if (c === "<" && next === ">") {
        tokens.push({ t: "word", v: "<>" });
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
      tokens.push({ t: "word", v: raw });
      continue;
    }
    fail(READ_ONLY, sql);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  parse(): ShopifyStatement {
    const first = this.word();
    if (first === null || first.toUpperCase() !== "SELECT") fail(READ_ONLY, this.sql);
    if (this.word("COUNT") !== null) return this.count();
    return this.select();
  }

  private table(): ShopifyTable {
    if (this.word("FROM") === null) fail("Write FROM and a table, such as products.", this.sql);
    const table = shopifyTable(this.name());
    if (this.word("JOIN") !== null) fail(ONE_TABLE, this.sql);
    if (table === null) fail("Shopify has no table with that name.", this.sql);
    return table;
  }

  private literal(): string {
    const token = this.peek();
    if (token.t === "string") {
      this.take();
      if (/[\r\n\u0000]/.test(token.v)) fail("Write the value on one line.", this.sql);
      return token.v;
    }
    if (token.t === "number") {
      this.take();
      return String(token.v);
    }
    fail("Write the value in quotes or as a number.", this.sql);
  }

  private filter(table: ShopifyTable): ShopifyFilter {
    const column = this.column(table);
    if (this.word("IN") !== null) fail("Shopify filters with =, <, >, <=, >=, or LIKE.", this.sql);
    if (this.word("LIKE") !== null) {
      const token = this.peek();
      if (token.t !== "string") fail("Write LIKE with a quoted value.", this.sql);
      return { column, op: "LIKE", value: this.literal() };
    }
    const op = this.word();
    if (op === "=" || op === "<" || op === ">" || op === "<=" || op === ">=" || op === "!=" || op === "<>") {
      return { column, op, value: this.literal() };
    }
    if (op !== null && op.toUpperCase() === "OR") fail(AND_ONLY, this.sql);
    fail("Shopify filters with =, <, >, <=, >=, or LIKE.", this.sql);
  }

  private column(table: ShopifyTable): string {
    const raw = this.name();
    const found = table.columns.find((column) => column.name.toLowerCase() === raw.toLowerCase());
    if (found === undefined) fail("Shopify has no field with that name.", this.sql);
    return found.name;
  }

  private where(table: ShopifyTable): ShopifyFilter[] {
    if (this.word("WHERE") === null) return [];
    const filters: ShopifyFilter[] = [];
    for (;;) {
      filters.push(this.filter(table));
      if (this.word("OR") !== null) fail(AND_ONLY, this.sql);
      if (this.word("AND") === null) break;
    }
    return filters;
  }

  private orderBy(table: ShopifyTable): { sortKey: string; desc: boolean } | null {
    if (this.word("ORDER") === null) return null;
    if (this.word("BY") === null) fail("Write ORDER BY and a field.", this.sql);
    const column = this.column(table);
    const sortKey = table.sort[column];
    if (sortKey === undefined) fail("Shopify cannot order by that field.", this.sql);
    const direction = this.word();
    const desc = direction !== null && direction.toUpperCase() === "DESC";
    if (direction !== null && !desc && direction.toUpperCase() !== "ASC") this.index -= 1;
    if (this.peek().t === "comma") fail("Shopify orders by one field.", this.sql);
    return { sortKey, desc };
  }

  private takeLimit(): { limit: number; capped: boolean } {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 1) {
      fail("Write LIMIT as a whole number greater than zero.", this.sql);
    }
    return { limit: token.v > SHOPIFY_SCAN_CAP ? SHOPIFY_SCAN_CAP : token.v, capped: token.v > SHOPIFY_SCAN_CAP };
  }

  private takeOffset(): number {
    const token = this.take();
    if (token.t !== "number" || !Number.isInteger(token.v) || token.v < 0) {
      fail("Write OFFSET as a whole number.", this.sql);
    }
    return token.v;
  }

  private limit(): { limit: number; offset: number; capped: boolean } {
    let limit = SHOPIFY_DEFAULT_LIMIT;
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

  private select(): ShopifyList {
    const columns = this.columns();
    const table = this.table();
    const named = columns === null ? null : columns.map((column) => this.known(table, column));
    const filters = this.where(table);
    const orderBy = this.orderBy(table);
    const window = this.limit();
    this.finish();
    return {
      kind: "select",
      table,
      columns: named,
      search: compileSearch(table, filters, this.sql),
      sortKey: orderBy === null ? null : orderBy.sortKey,
      reverse: orderBy !== null && orderBy.desc,
      ...window,
    };
  }

  private known(table: ShopifyTable, raw: string): string {
    const found = table.columns.find((column) => column.name.toLowerCase() === raw.toLowerCase());
    if (found === undefined) fail("Shopify has no field with that name.", this.sql);
    return found.name;
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

  private count(): ShopifyCount {
    if (this.peek().t !== "lparen") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "star") fail("Write COUNT(*).", this.sql);
    this.take();
    if (this.peek().t !== "rparen") fail("Write COUNT(*).", this.sql);
    this.take();
    const alias = this.word("AS") === null ? "count" : safeName(this.name(), this.sql);
    const table = this.table();
    const filters = this.where(table);
    if (this.word("ORDER") !== null || this.word("LIMIT") !== null || this.word("OFFSET") !== null) {
      fail("COUNT(*) does not take ORDER BY, LIMIT, or OFFSET.", this.sql);
    }
    this.finish();
    return { kind: "count", table, search: compileSearch(table, filters, this.sql), alias };
  }
}

function searchToken(value: string): string {
  if (/^[A-Za-z0-9_.:@/*-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function likeToken(value: string, sql: string): string {
  if (!/[A-Za-z0-9]/.test(value)) fail("Write LIKE with letters or digits.", sql);
  return searchToken(value.replaceAll("%", "*"));
}

function renderSearch(table: ShopifyTable, filter: ShopifyFilter, sql: string): string {
  const field = table.search[filter.column];
  if (field === undefined) fail("Shopify cannot filter on that field.", sql);
  if (filter.op === "LIKE") return `${field}:${likeToken(filter.value, sql)}`;
  const token = searchToken(filter.value);
  if (filter.op === "!=" || filter.op === "<>") return `-${field}:${token}`;
  if (filter.op === "=") return `${field}:${token}`;
  return `${field}:${filter.op}${token}`;
}

function compileSearch(table: ShopifyTable, filters: readonly ShopifyFilter[], sql: string): string | null {
  if (filters.length === 0) return null;
  return filters.map((filter) => renderSearch(table, filter, sql)).join(" AND ");
}

/** One statement. The provider sends it as one GraphQL query after this returns. */
export function translateShopifySql(sql: string): ShopifyStatement {
  const trimmed = sql.trim();
  if (trimmed === "") fail(READ_ONLY, sql);
  return new Parser(tokenize(trimmed), sql).parse();
}

/** The GraphQL document and variables for one page of a statement. */
export function shopifyGraphql(
  statement: ShopifyStatement,
  page: { readonly first: number; readonly after: string | null } = {
    first: statement.kind === "select" ? Math.min(statement.limit, SHOPIFY_PAGE_SIZE) : 1,
    after: null,
  },
): { readonly query: string; readonly variables: Record<string, unknown> } {
  if (statement.kind === "count") {
    return {
      query: `query Count($query: String) { ${statement.table.countField}(query: $query) { count } }`,
      variables: { query: statement.search },
    };
  }
  const table = statement.table;
  return {
    query: `query List($first: Int!, $after: String, $query: String, $sortKey: ${table.sortType}, $reverse: Boolean) { ${table.listField}(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) { edges { node { ${table.node} } } pageInfo { hasNextPage endCursor } } }`,
    variables: {
      first: page.first,
      after: page.after,
      query: statement.search,
      sortKey: statement.sortKey,
      reverse: statement.reverse,
    },
  };
}
