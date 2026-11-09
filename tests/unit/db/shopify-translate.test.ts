import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import {
  shopifyGraphql,
  shopifyTable,
  translateShopifySql,
  SHOPIFY_TABLES,
} from "@/lib/db/providers/sql/shopify/translate";

function read(sql: string) {
  return translateShopifySql(sql);
}

describe("translateShopifySql", () => {
  test("lists the five resources and finds one by either case", () => {
    expect(SHOPIFY_TABLES.map((table) => table.name)).toEqual([
      "products",
      "variants",
      "customers",
      "orders",
      "collections",
    ]);
    expect(shopifyTable("Products")?.name).toBe("products");
    expect(shopifyTable("missing")).toBeNull();
  });

  test("reads a select, a count, comments, quotes and a trailing semicolon", () => {
    const listed = read(
      "-- note\nSELECT /* keep */ title, \"vendor\" FROM products WHERE title = 'blue shirt' AND status != 'draft' ORDER BY title DESC LIMIT 10 OFFSET 2;",
    );
    expect(listed.kind).toBe("select");
    if (listed.kind !== "select") return;
    expect(listed.columns).toEqual(["title", "vendor"]);
    expect(listed.search).toBe('title:"blue shirt" AND -status:draft');
    expect(listed.sortKey).toBe("TITLE");
    expect(listed.reverse).toBe(true);
    expect(listed.limit).toBe(10);
    expect(listed.offset).toBe(2);
    expect(listed.capped).toBe(false);

    const counted = read("SELECT COUNT(*) FROM orders WHERE email = 'a@b.co'");
    expect(counted).toMatchObject({ kind: "count", alias: "count", search: "email:a@b.co" });
    expect(
      read("SELECT COUNT(*) AS total FROM customers").kind === "count" &&
        read("SELECT COUNT(*) AS total FROM customers"),
    ).toMatchObject({
      alias: "total",
      search: null,
    });
  });

  test("builds the GraphQL document from the catalog, not from the statement text", () => {
    const listed = read("SELECT * FROM variants WHERE sku LIKE 'AB%' ORDER BY sku ASC LIMIT 3");
    const page = shopifyGraphql(listed, { first: 3, after: "cursor" });
    expect(page.query).toContain("productVariants");
    expect(page.query).toContain("ProductVariantSortKeys");
    expect(page.query).not.toContain("AB%");
    expect(page.variables).toEqual({
      first: 3,
      after: "cursor",
      query: "sku:AB*",
      sortKey: "SKU",
      reverse: false,
    });
    const counted = read("SELECT COUNT(*) FROM collections WHERE title LIKE '%sale%'");
    expect(shopifyGraphql(counted).query).toContain("collectionsCount");
    expect(shopifyGraphql(counted).variables).toEqual({ query: "title:*sale*" });
    const plain = read("SELECT id FROM products");
    expect(shopifyGraphql(plain).variables).toMatchObject({
      first: 50,
      after: null,
      query: null,
      sortKey: null,
      reverse: false,
    });
  });

  test("quotes a search value that is not a single token and turns comparisons into search syntax", () => {
    const compared = read("SELECT id FROM products WHERE createdAt >= '2024-01-01' AND title <> 'a\\b\"c'");
    expect(compared.kind === "select" && compared.search).toBe('created_at:>=2024-01-01 AND -title:"a\\\\b\\"c"');
    expect(read("SELECT id FROM orders WHERE name < '1000'").kind === "select").toBe(true);
    const like = read("SELECT id FROM products WHERE title LIKE '%hat'");
    expect(like.kind === "select" && like.search).toBe("title:*hat");
  });

  test("caps a limit, accepts offset before limit, and keeps an unordered page", () => {
    const capped = read("SELECT id FROM products LIMIT 1001");
    expect(capped.kind === "select" && capped.limit).toBe(1000);
    expect(capped.kind === "select" && capped.capped).toBe(true);
    const swapped = read("SELECT id FROM products OFFSET 4 LIMIT 2");
    expect(swapped.kind === "select" && swapped.offset).toBe(4);
    expect(swapped.kind === "select" && swapped.limit).toBe(2);
    const unordered = read("SELECT id FROM products ORDER BY title LIMIT 1");
    expect(unordered.kind === "select" && unordered.reverse).toBe(false);
  });

  test("refuses writes, joins, a second statement, and a filter the search syntax cannot carry", () => {
    const refuse = (sql: string, pattern: RegExp) => {
      expect(() => read(sql)).toThrow(QueryError);
      expect(() => read(sql)).toThrow(pattern);
    };
    refuse("", /read-only/);
    refuse("DELETE FROM products", /read-only/);
    refuse("SELECT id FROM products; SELECT id FROM orders", /one statement/);
    refuse("SELECT id FROM products JOIN variants", /one table/);
    refuse("SELECT id FROM missing", /no table/);
    refuse("SELECT id", /Write FROM/);
    refuse("SELECT nope FROM products", /no field/);
    refuse("SELECT id FROM products WHERE nope = 'a'", /no field/);
    refuse("SELECT id FROM products WHERE totalInventory = 1", /cannot filter/);
    refuse("SELECT id FROM products WHERE title = 'a' OR status = 'active'", /AND/);
    refuse("SELECT id FROM products WHERE title OR status = 'active'", /AND/);
    refuse("SELECT id FROM products WHERE title", /LIKE/);
    refuse("SELECT id FROM products WHERE OR", /no field/);
    refuse("SELECT id FROM products WHERE title IN ('a')", /LIKE/);
    refuse("SELECT id FROM products WHERE title LIKE 1", /LIKE with a quoted/);
    refuse("SELECT id FROM products WHERE title LIKE '%'", /letters or digits/);
    refuse("SELECT id FROM products ORDER title", /ORDER BY/);
    refuse("SELECT id FROM products ORDER BY handle", /cannot order/);
    refuse("SELECT id FROM products ORDER BY title, vendor", /one field/);
    refuse("SELECT id FROM products LIMIT 0", /LIMIT/);
    refuse("SELECT id FROM products LIMIT 1.5", /LIMIT/);
    refuse("SELECT id FROM products OFFSET -1", /read-only/);
    refuse("SELECT id FROM products OFFSET 1.5", /OFFSET/);
    refuse("SELECT COUNT( FROM products", /COUNT/);
    refuse("SELECT COUNT(id) FROM products", /COUNT/);
    refuse("SELECT COUNT(* FROM products", /COUNT/);
    refuse("SELECT COUNT(*) AS total FROM products ORDER BY title", /does not take/);
    refuse("SELECT COUNT(*) FROM products LIMIT 1", /does not take/);
    refuse("SELECT COUNT(*) FROM products OFFSET 1", /does not take/);
    refuse("SELECT id FROM products WHERE title = 'a' leftover", /read-only/);
    refuse("SELECT 'title' FROM products", /field name/);
    refuse(`SELECT ${"a".repeat(81)} FROM products`, /punctuation/);
    refuse("SELECT id FROM products /*", /could not read/);
    refuse("SELECT id FROM products WHERE title = 'ab", /could not read/);
    refuse('SELECT "title FROM products', /could not read/);
    refuse("SELECT id FROM products WHERE title = 'a\nb'", /one line/);
    refuse("SELECT id FROM products ?", /read-only/);
    refuse("SELECT id FROM products WHERE title = true", /quotes or as a number/);
  });

  test("reads a doubled quote, a decimal, and an identifier", () => {
    const doubled = read("SELECT id FROM products WHERE title = 'it''s'");
    expect(doubled.kind === "select" && doubled.search).toBe('title:"it\'s"');
    expect(() => read("SELECT price FROM variants WHERE price > 1.5")).toThrow(/cannot filter/);
  });

  test("completion quotes a Shopify name the way the grammar says", () => {
    const format = SQL_GRAMMAR.shopify.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.shopify.completion.readQuotedQualifier;
    expect(format).toBeTypeOf("function");
    expect(readQuoted).toBeTypeOf("function");
    if (!format || !readQuoted) return;
    expect(format('a"b')).toBe('"a""b"');
    expect(readQuoted('"a""b".')).toBe('a"b');
    expect(readQuoted("products.")).toBeUndefined();
  });
});
