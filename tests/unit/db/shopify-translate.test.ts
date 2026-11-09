import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { SHOPIFYQL_SCHEMAS, shopifySchema, translateShopifyql } from "@/lib/db/providers/sql/shopify/translate";

function read(sql: string) {
  return translateShopifyql(sql).text;
}

describe("translateShopifyql", () => {
  test("lists the ShopifyQL schemas and finds one by either case", () => {
    expect(SHOPIFYQL_SCHEMAS.map((schema) => schema.name)).toContain("sales");
    expect(SHOPIFYQL_SCHEMAS.map((schema) => schema.name)).toContain("sessions");
    expect(shopifySchema("Sales")?.name).toBe("sales");
    expect(shopifySchema("missing")).toBeNull();
  });

  test("keeps a ShopifyQL query and drops comments and a trailing semicolon", () => {
    expect(
      read(`-- note
        /* keep */ FROM sales
          SHOW total_sales, orders
          WHERE sales_channel = 'Online Store'
          GROUP BY sales_channel
          DURING last_month;`),
    ).toBe(`FROM sales
          SHOW total_sales, orders
          WHERE sales_channel = 'Online Store'
          GROUP BY sales_channel
          DURING last_month`);
    expect(read(`FROM sales SHOW total_sales WHERE product_title = 'it''s a hat'`)).toBe(
      `FROM sales SHOW total_sales WHERE product_title = 'it''s a hat'`,
    );
    expect(read(`FROM sales SHOW total_sales WHERE product_title = "a""b"`)).toBe(
      `FROM sales SHOW total_sales WHERE product_title = "a""b"`,
    );
    expect(read(`FROM sales SHOW total_sales WHERE billing_country = 'a;b'`)).toContain("'a;b'");
    expect(read("FROM sales VISUALIZE total_sales TYPE line")).toBe("FROM sales VISUALIZE total_sales TYPE line");
    expect(read("FROM/**/sales SHOW total_sales")).toBe("FROM sales SHOW total_sales");
  });

  test("refuses SQL, a second statement, and a statement it cannot read", () => {
    const refuse = (sql: string, pattern: RegExp) => {
      expect(() => read(sql)).toThrow(QueryError);
      expect(() => read(sql)).toThrow(pattern);
    };
    refuse("", /read-only/);
    refuse("-- only", /read-only/);
    refuse("/* nothing */", /read-only/);
    refuse("SELECT total_sales FROM sales", /FROM/);
    refuse("DELETE FROM sales", /read-only/);
    refuse("FROM sales SHOW total_sales; FROM sessions SHOW sessions", /one statement/);
    refuse("FROM sales SHOW total_sales /*", /could not read/);
    refuse("FROM sales SHOW total_sales WHERE product_title = 'ab", /could not read/);
    refuse('FROM sales SHOW total_sales WHERE product_title = "ab', /could not read/);
  });

  test("completion quotes a Shopify name the way the grammar says", () => {
    const format = SQL_GRAMMAR.shopify.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.shopify.completion.readQuotedQualifier;
    expect(format).toBeTypeOf("function");
    expect(readQuoted).toBeTypeOf("function");
    if (!format || !readQuoted) return;
    expect(format('a"b')).toBe('"a""b"');
    expect(readQuoted('"a""b".')).toBe('a"b');
    expect(readQuoted("sales.")).toBeUndefined();
  });
});
