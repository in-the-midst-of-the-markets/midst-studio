import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { CIN7_RESOURCES, cin7Resource, translateCin7Sql } from "@/lib/db/providers/sql/cin7/translate";

const fail = (sql: string): string => {
  try {
    translateCin7Sql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

describe("Cin7 Core SQL", () => {
  test("lists the resources and finds a table by either case", () => {
    expect(CIN7_RESOURCES.map((entry) => entry.name)).toContain("Stock");
    expect(cin7Resource("product")?.path).toBe("/product");
    expect(cin7Resource("missing")).toBeNull();
    expect(SQL_GRAMMAR.cin7.readsSqlText).toBe(true);
    const words = SQL_GRAMMAR.cin7.grammar.completionWords;
    if (words === undefined) throw new Error("cin7 completion");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.cin7.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.cin7.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("cin7 completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"Sale List".')).toBe("Sale List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Product.")).toBeUndefined();
    const clauses = SQL_GRAMMAR.cin7.grammar.completionClauses?.values;
    expect(clauses?.FROM?.words).toContain("Stock");
    expect(clauses?.WHERE?.words).toContain("Search");
    expect(clauses?.WHERE?.words).toContain("'ORDERED'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      expect(translateCin7Sql(sql).kind === "list" || translateCin7Sql(sql).kind === "count").toBe(true);
    }
  });

  test("translates a page, a count, and equality filters", () => {
    const page = translateCin7Sql(
      "SELECT SKU, Name FROM Product WHERE SKU = 'Bread' AND Name = 'Loaf' LIMIT 50 OFFSET 100 -- fresh\n/* note */",
    );
    expect(page).toMatchObject({
      kind: "list",
      columns: ["SKU", "Name"],
      limit: 50,
      offset: 100,
      capped: false,
      filters: [
        { param: "Sku", value: "Bread" },
        { param: "Name", value: "Loaf" },
      ],
    });
    expect(translateCin7Sql('SELECT * FROM "stock"')).toMatchObject({
      kind: "list",
      columns: null,
      limit: 100,
      offset: 0,
      resource: { name: "Stock" },
    });
    const counted = translateCin7Sql(
      "SELECT COUNT(*) AS total FROM Sale WHERE Search = 'SO-1' AND OrderStatus = 'AUTHORISED';",
    );
    expect(counted).toMatchObject({
      kind: "count",
      alias: "total",
      filters: [
        { param: "Search", value: "SO-1" },
        { param: "OrderStatus", value: "AUTHORISED" },
      ],
    });
    expect(translateCin7Sql('SELECT COUNT(*) AS "row count" FROM Product')).toMatchObject({ alias: "row count" });
    expect(
      translateCin7Sql("SELECT COUNT(*) FROM PaymentTerm WHERE IsActive = TRUE AND IsDefault = false"),
    ).toMatchObject({
      filters: [
        { param: "IsActive", value: "true" },
        { param: "IsDefault", value: "false" },
      ],
    });
    expect(translateCin7Sql("SELECT ID FROM Customer WHERE ID = '0365e5bb-e5ea-4a45-b98b-fdc4466bdaf1'")).toMatchObject(
      {
        filters: [{ param: "ID", value: "0365e5bb-e5ea-4a45-b98b-fdc4466bdaf1" }],
      },
    );
    expect(translateCin7Sql("SELECT Name FROM PaymentTerm WHERE Method = 'number of days'")).toMatchObject({
      filters: [{ param: "Method", value: "number of days" }],
    });
    expect(translateCin7Sql("SELECT Name FROM Product WHERE sku = 'abc'")).toMatchObject({
      filters: [{ param: "Sku", value: "abc" }],
    });
    const wide = translateCin7Sql("SELECT SKU FROM Product LIMIT 5000");
    expect(wide).toMatchObject({ limit: 1000, capped: true });
    expect(translateCin7Sql("SELECT Name FROM Brand WHERE Name = 1.5")).toMatchObject({
      filters: [{ param: "Name", value: "1.5" }],
    });
  });

  test("refuses everything outside the subset", () => {
    expect(fail("")).toMatch(/needs a SELECT/);
    expect(fail("   -- only\n/* and this */")).toMatch(/needs a SELECT/);
    expect(fail("INSERT INTO Product (SKU) VALUES ('A')")).toMatch(/read-only/);
    expect(fail("UPDATE Product SET Name = 'A'")).toMatch(/read-only/);
    expect(fail("DELETE FROM Product")).toMatch(/read-only/);
    expect(fail("SHOW TABLES")).toMatch(/one SELECT/);
    expect(fail("SELECT COUNT(SKU) FROM Product")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Product")).toMatch(/name after AS/);
    expect(fail("SELECT , FROM Product")).toMatch(/column name/);
    expect(fail("SELECT FROM Product")).toMatch(/column name/);
    expect(fail("SELECT SKU Product")).toMatch(/FROM/);
    expect(fail("SELECT SKU FROM")).toMatch(/FROM/);
    expect(fail("SELECT SKU FROM Invoice")).toMatch(/no table named Invoice/);
    expect(fail("SELECT SKU FROM Product WHERE")).toMatch(/column after WHERE/);
    expect(fail("SELECT SKU FROM Product WHERE SKU > 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT SKU FROM Product WHERE SKU = ")).toMatch(/quoted value/);
    expect(fail("SELECT SKU FROM Product WHERE Category = 'Bakery'")).toMatch(/cannot filter Product on Category/);
    expect(fail("SELECT SKU FROM Product WHERE SKU = 'A' OR Name = 'B'")).toMatch(/AND/);
    expect(fail("SELECT SKU FROM Product WHERE Name LIKE 'A%'")).toMatch(/filters with =/);
    expect(fail("SELECT SKU FROM Product WHERE LIKE 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT SKU FROM Product ORDER BY Name")).toMatch(/does not sort/);
    expect(fail("SELECT SKU FROM Product JOIN Stock ON Product.SKU = Stock.SKU")).toMatch(/one table/);
    expect(fail("SELECT SKU FROM Product LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT SKU FROM Product LIMIT -1")).toMatch(/could not read/);
    expect(fail("SELECT SKU FROM Product LIMIT 1.5")).toMatch(/whole number/);
    expect(fail("SELECT SKU FROM Product LIMIT 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT SKU FROM Product LIMIT 10 OFFSET 5")).toMatch(/multiple of LIMIT/);
    expect(fail("SELECT SKU FROM Product OFFSET no")).toMatch(/OFFSET must be a whole number/);
    expect(fail("SELECT COUNT(*) FROM Product LIMIT 10")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Product OFFSET 0")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT SKU FROM Product; SELECT Name FROM Product")).toMatch(/one statement/);
    expect(fail('SELECT COUNT(*) AS "" FROM Product')).toMatch(/name after AS/);
    expect(fail("SELECT 'open FROM Product")).toMatch(/string was not closed/);
    expect(fail('SELECT SKU FROM "Product')).toMatch(/name was not closed/);
    expect(fail("SELECT SKU FROM Product /*")).toMatch(/comment was not closed/);
    expect(fail("SELECT SKU FROM Product WHERE SKU = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT SKU FROM Product WHERE SKU = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT SKU FROM Product LIMIT 1.2.3")).toMatch(/could not read that number/);
    expect(fail("SELECT SKU FROM Product #nope")).toMatch(/could not read that statement/);
  });

  test("keeps a doubled quote inside a name and a string", () => {
    expect(fail(`SELECT SKU FROM "Prod""uct"`)).toMatch(/no table/);
    const row = translateCin7Sql("SELECT SKU FROM Product WHERE Name = 'O''Brien'");
    expect(row.kind === "list" ? row.filters : []).toEqual([{ param: "Name", value: "O'Brien" }]);
  });
});
