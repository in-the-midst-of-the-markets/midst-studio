import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { SHIPBOB_RESOURCES, shipBobResource, translateShipBobSql } from "@/lib/db/providers/sql/shipbob/translate";

const fail = (sql: string): string => {
  try {
    translateShipBobSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

describe("ShipBob SQL", () => {
  test("lists the resources and the editor words are statements the translator accepts", () => {
    expect(SHIPBOB_RESOURCES.map((entry) => entry.name)).toEqual(["Order", "Product", "Inventory", "Channel"]);
    expect(shipBobResource("order")?.name).toBe("Order");
    expect(shipBobResource("missing")).toBeNull();
    expect(SQL_GRAMMAR.shipbob.readsSqlText).toBe(true);
    expect(SQL_GRAMMAR.shipbob.grammar.formatterLanguage).toBe("mysql");
    const words = SQL_GRAMMAR.shipbob.grammar.completionWords;
    if (words === undefined) throw new Error("shipbob completion");
    expect(words.lists).toBe("only");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.shipbob.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.shipbob.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("shipbob completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"Order List".')).toBe("Order List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Product.")).toBeUndefined();
    expect(SQL_GRAMMAR.shipbob.completion.nameIsDottedWord).toBe(true);
    const clauses = SQL_GRAMMAR.shipbob.grammar.completionClauses?.values;
    expect(clauses?.FROM?.when).toBe("any");
    expect(clauses?.FROM?.words).toContain("Order");
    expect(clauses?.SELECT?.words).toContain("Sku");
    expect(clauses?.WHERE?.words).toContain("SKU");
    expect(clauses?.WHERE?.words).toContain("'Newest'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      const statement = translateShipBobSql(sql);
      expect(statement.kind === "list" || statement.kind === "count").toBe(true);
    }
  });

  test("translates orders, products, inventory and a channel count", () => {
    const orders = translateShipBobSql(
      "SELECT Id, Status FROM \"Order\" WHERE id = 15 AND ReferenceId = 'Ref 1' AND StartDate = '2024-07-18' AND EndDate = '2024-07-18T00:00:00Z' AND SortOrder = 'Newest' LIMIT 50 OFFSET 50 -- fresh\n/* note */",
    );
    expect(orders).toMatchObject({
      kind: "list",
      columns: ["Id", "Status"],
      limit: 50,
      offset: 50,
      capped: false,
      filters: [
        { name: "Id", param: "IDs", value: "15" },
        { name: "ReferenceId", param: "ReferenceIds", value: "Ref 1" },
        { name: "StartDate", value: "2024-07-18" },
        { name: "EndDate", value: "2024-07-18T00:00:00Z" },
        { name: "SortOrder", value: "Newest" },
      ],
    });
    expect(translateShipBobSql("SELECT * FROM Product WHERE SKU = 'WIDGET' AND Name = 'Blue'")).toMatchObject({
      kind: "list",
      columns: null,
      resource: { name: "Product" },
    });
    expect(
      translateShipBobSql("SELECT InventoryId FROM Inventory WHERE SearchBy = 'blue' AND IsActive = false"),
    ).toMatchObject({
      filters: [
        { name: "SearchBy", param: "SearchBy", value: "blue" },
        { name: "IsActive", value: "false" },
      ],
    });
    expect(translateShipBobSql("SELECT COUNT(*) AS channels FROM Channel")).toMatchObject({
      kind: "count",
      alias: "channels",
      resource: { name: "Channel" },
    });
    expect(translateShipBobSql("SELECT Id FROM Channel LIMIT 500 OFFSET 10")).toMatchObject({
      capped: true,
      limit: 250,
      offset: 10,
    });
  });

  test("refuses writes, the wrong shape, and a filter the list will not take", () => {
    expect(fail("")).toMatch(/SELECT/);
    expect(fail("INSERT INTO Product (Id) VALUES (1)")).toMatch(/read-only/);
    expect(fail("SHOW TABLES")).toMatch(/SELECT/);
    expect(fail("SELECT COUNT(1) FROM Channel")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Channel")).toMatch(/name after AS/);
    expect(fail("SELECT COUNT(*) AS WHERE FROM Channel")).toMatch(/name after AS/);
    expect(fail('SELECT COUNT(*) AS "" FROM Channel')).toMatch(/name after AS/);
    expect(fail("SELECT FROM Channel")).toMatch(/column name/);
    expect(fail("SELECT , FROM Channel")).toMatch(/column name/);
    expect(fail("SELECT Id")).toMatch(/FROM/);
    expect(fail("SELECT Id FROM")).toMatch(/FROM/);
    expect(fail("SELECT Id FROM Missing")).toMatch(/no table/);
    expect(fail("SELECT Id FROM Channel WHERE OR Name = 'A'")).toMatch(/AND/);
    expect(fail("SELECT Id FROM Product WHERE LIKE SKU = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Product WHERE IN SKU = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Product WHERE BETWEEN SKU = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Product WHERE SKU > 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Product WHERE SKU SKU")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Product WHERE SKU = paper")).toMatch(/quoted value/);
    expect(fail("SELECT Id FROM Channel WHERE Name = 'A'")).toMatch(/cannot filter/);
    expect(fail("SELECT Id FROM \"Order\" WHERE SortOrder = 'Sideways'")).toMatch(/Newest or Oldest/);
    expect(fail("SELECT Id FROM \"Order\" WHERE Id = 'abc'")).toMatch(/whole number/);
    expect(fail("SELECT Id FROM \"Order\" WHERE StartDate = 'yesterday'")).toMatch(/calendar days/);
    expect(fail("SELECT Id FROM \"Order\" WHERE StartDate = '2024-13-01'")).toMatch(/calendar days/);
    expect(fail("SELECT Id FROM \"Order\" WHERE StartDate = '2024-07-19' AND EndDate = '2024-07-18'")).toMatch(/later/);
    expect(fail(`SELECT Id FROM Product WHERE Search = '${"x".repeat(201)}'`)).toMatch(/printable text/);
    expect(fail("SELECT Id FROM Product WHERE Search = 'line\nbreak'")).toMatch(/printable text/);
    expect(fail("SELECT Id FROM Product WHERE SKU = 'A' ORDER BY Name")).toMatch(/does not sort/);
    expect(fail("SELECT Id FROM Product WHERE SKU = 'A' JOIN Sale")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Product.Extra")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Product GROUP BY Id")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Product UNION SELECT Id FROM Product")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Product WHERE SKU = 'A' OR Name = 'B'")).toMatch(/AND/);
    expect(fail('SELECT COUNT(*) FROM "Order"')).toMatch(/no total/);
    expect(fail("SELECT COUNT(*) FROM Channel LIMIT 1")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Channel OFFSET 1")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT Id FROM Product LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT Id FROM Product LIMIT 1.5")).toMatch(/whole number/);
    expect(fail('SELECT Id FROM "Order" LIMIT 10 OFFSET 5')).toMatch(/multiple of LIMIT/);
    expect(fail('SELECT Id FROM "Order" LIMIT 100 OFFSET 2000')).toMatch(/stop at 20/);
    expect(fail("SELECT Id FROM Product LIMIT 250 OFFSET 2500")).toMatch(/at most 10 pages/);
    expect(fail("SELECT Id FROM Channel OFFSET 10001")).toMatch(/at most 10000/);
    expect(fail("SELECT Id FROM Channel; SELECT Id FROM Channel")).toMatch(/one statement/);
    expect(translateShipBobSql("SELECT Id FROM Product WHERE SKU = 'a''b'")).toMatchObject({
      filters: [{ value: "a'b" }],
    });
    expect(translateShipBobSql('SELECT "A""B" FROM Product')).toMatchObject({ columns: ['A"B'] });
    expect(fail("SELECT Id FROM Product WHERE SKU = 'open")).toMatch(/not closed/);
    expect(fail('SELECT Id FROM "open')).toMatch(/not closed/);
    expect(fail("SELECT Id FROM Product /* open")).toMatch(/not closed/);
    expect(fail("SELECT Id FROM Product WHERE SKU = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT Id FROM Product WHERE SKU = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT Id FROM Product @")).toMatch(/could not read/);
    expect(fail("SELECT Id FROM Product WHERE SKU = 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT Id FROM Product WHERE SKU = 1.2.3")).toMatch(/could not read that number/);
    expect(translateShipBobSql("SELECT Id FROM Product LIMIT 500;")).toMatchObject({ capped: true, limit: 250 });
  });
});
