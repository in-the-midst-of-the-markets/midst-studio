/**
 * The ShopifyQL a Shopify connection runs.
 *
 * ShopifyQL is the shop's analytics language (`FROM sales SHOW total_sales`).
 * Studio does not translate SQL into it. This module checks that the statement
 * is one ShopifyQL query, then the provider sends that text through the Admin
 * API's `shopifyqlQuery` field. A write and a second statement fail here,
 * before a request.
 */
import { QueryError } from "@/lib/db/errors";

const PROVIDER = "shopify" as const;
const READ_ONLY = "ShopifyQL is read-only. Write one query that starts with FROM.";
const ONE_STATEMENT = "ShopifyQL runs one statement at a time.";
const UNREADABLE = "Shopify could not read that statement.";

export interface ShopifyqlSchema {
  readonly name: string;
}

/**
 * The schemas the ShopifyQL reference lists for Admin API 2025-10.
 * A query can name any schema Shopify accepts; this list is what the object tree shows.
 */
export const SHOPIFYQL_SCHEMAS: readonly ShopifyqlSchema[] = Object.freeze(
  [
    "customers",
    "chargebacks",
    "fees",
    "gift_cards",
    "payment_attempts",
    "payments",
    "payouts",
    "store_credit_summaries",
    "store_credit_transactions",
    "inventory",
    "inventory_adjustment_history",
    "inventory_by_location",
    "inventory_shipments",
    "inventory_transfers",
    "campaign_products",
    "campaign_sales",
    "campaign_sessions",
    "shop_campaign_insights",
    "fulfillments",
    "profitability",
    "shipping_labels",
    "discounts",
    "returns",
    "sales",
    "sales_taxes",
    "subscriptions",
    "global_searches",
    "low_engagement_product_recommendations",
    "product_recommendation_conversions",
    "search_conversions",
    "search_queries",
    "searches",
    "sessions",
    "shop_post_purchase_offers",
    "shop_product_impressions",
    "shopify_forms",
    "web_performance",
  ].map((name) => ({ name })),
);

const SCHEMA_BY_NAME = new Map(SHOPIFYQL_SCHEMAS.map((schema) => [schema.name.toLowerCase(), schema]));

/** The catalog schema, or null when the name is not one this connection lists. */
export function shopifySchema(name: string): ShopifyqlSchema | null {
  return SCHEMA_BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface ShopifyqlStatement {
  /** The ShopifyQL text sent as the `shopifyqlQuery` argument. */
  readonly text: string;
}

function fail(message: string, sql: string): never {
  throw new QueryError(message, PROVIDER, sql);
}

/**
 * One ShopifyQL statement, with comments removed and a trailing semicolon dropped.
 * The words themselves are Shopify's to parse.
 */
export function translateShopifyql(sql: string): ShopifyqlStatement {
  return { text: statementText(sql) };
}

function statementText(sql: string): string {
  let index = 0;
  let out = "";
  let started = false;
  const length = sql.length;
  while (index < length) {
    const current = sql[index] ?? "";
    if (!started && (current === " " || current === "\n" || current === "\t" || current === "\r")) {
      index += 1;
      continue;
    }
    if (current === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < length && sql[index] !== "\n") index += 1;
      if (started) out += " ";
      continue;
    }
    if (current === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) fail(UNREADABLE, sql);
      index = end + 2;
      if (started) out += " ";
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      const end = readQuoted(sql, index, quote);
      out += sql.slice(index, end);
      index = end;
      started = true;
      continue;
    }
    if (current === ";") {
      if (sql.slice(index + 1).trim() !== "") fail(ONE_STATEMENT, sql);
      break;
    }
    out += current;
    started = true;
    index += 1;
  }
  const text = out.trim();
  if (text === "") fail(READ_ONLY, sql);
  const first = /^[A-Za-z]+/.exec(text)?.[0]?.toUpperCase() ?? "";
  if (first !== "FROM") fail(READ_ONLY, sql);
  return text;
}

function readQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) return index + 1;
    index += 1;
  }
  fail(UNREADABLE, sql);
}
