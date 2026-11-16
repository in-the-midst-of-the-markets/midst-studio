import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import {
  SHIPSTATION_RESOURCES,
  shipStationResource,
  translateShipStationSql,
} from "@/lib/db/providers/sql/shipstation/translate";

const fail = (sql: string): string => {
  try {
    translateShipStationSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

describe("ShipStation SQL", () => {
  test("lists the resources and the editor words are statements the translator accepts", () => {
    expect(SHIPSTATION_RESOURCES.map((entry) => entry.name)).toEqual(["Order", "Shipment", "Product", "Store"]);
    expect(shipStationResource("SHIPMENT")?.name).toBe("Shipment");
    expect(shipStationResource("missing")).toBeNull();
    expect(SQL_GRAMMAR.shipstation.readsSqlText).toBe(true);
    expect(SQL_GRAMMAR.shipstation.grammar.formatterLanguage).toBe("mysql");
    const words = SQL_GRAMMAR.shipstation.grammar.completionWords;
    if (words === undefined) throw new Error("shipstation completion");
    expect(words.lists).toBe("only");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.shipstation.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.shipstation.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("shipstation completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"Order List".')).toBe("Order List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Store.")).toBeUndefined();
    expect(SQL_GRAMMAR.shipstation.completion.nameIsDottedWord).toBe(true);
    const clauses = SQL_GRAMMAR.shipstation.grammar.completionClauses?.values;
    expect(clauses?.FROM?.when).toBe("any");
    expect(clauses?.FROM?.words).toContain("Shipment");
    expect(clauses?.SELECT?.words).toContain("TrackingNumber");
    expect(clauses?.WHERE?.words).toContain("OrderStatus");
    expect(clauses?.WHERE?.words).toContain("'awaiting_shipment'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      const statement = translateShipStationSql(sql);
      expect(statement.kind === "list" || statement.kind === "count").toBe(true);
    }
  });

  test("translates orders, shipments, products, stores and a count", () => {
    const orders = translateShipStationSql(
      "SELECT OrderId, OrderStatus FROM \"Order\" WHERE orderStatus = 'awaiting_shipment' AND StoreId = 12 AND OrderNumber = '100' AND OrderDateStart = '2024-07-01' AND OrderDateEnd = '2024-07-31T00:00:00Z' LIMIT 100 OFFSET 100 -- fresh\n/* note */",
    );
    expect(orders).toMatchObject({
      kind: "list",
      columns: ["OrderId", "OrderStatus"],
      limit: 100,
      offset: 100,
      capped: false,
      filters: [
        { name: "OrderStatus", param: "orderStatus", value: "awaiting_shipment" },
        { name: "StoreId", param: "storeId", value: "12" },
        { name: "OrderNumber", param: "orderNumber", value: "100" },
        { name: "OrderDateStart", value: "2024-07-01" },
        { name: "OrderDateEnd", value: "2024-07-31T00:00:00Z" },
      ],
    });
    expect(
      translateShipStationSql(
        "SELECT * FROM Shipment WHERE TrackingNumber = '1Z' AND CarrierCode = 'ups' AND ShipDateStart = '2024-07-01' AND ShipDateEnd = '2024-07-02'",
      ),
    ).toMatchObject({ columns: null, resource: { name: "Shipment" } });
    expect(translateShipStationSql("SELECT COUNT(*) AS totalCount FROM Product WHERE SKU = 'BEAU-000'")).toMatchObject({
      kind: "count",
      alias: "totalCount",
      resource: { name: "Product" },
    });
    expect(translateShipStationSql("SELECT StoreId FROM Store LIMIT 500 OFFSET 10")).toMatchObject({
      limit: 500,
      offset: 10,
      capped: false,
    });
  });

  test("refuses writes, the wrong shape, and a filter the list will not take", () => {
    expect(fail("")).toMatch(/SELECT/);
    expect(fail('DELETE FROM "Order"')).toMatch(/read-only/);
    expect(fail("EXPLAIN SELECT StoreId FROM Store")).toMatch(/SELECT/);
    expect(fail("SELECT COUNT(1) FROM Store")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Store")).toMatch(/name after AS/);
    expect(fail("SELECT COUNT(*) AS WHERE FROM Store")).toMatch(/name after AS/);
    expect(fail('SELECT COUNT(*) AS "" FROM Store')).toMatch(/name after AS/);
    expect(fail("SELECT FROM Store")).toMatch(/column name/);
    expect(fail("SELECT , FROM Store")).toMatch(/column name/);
    expect(fail("SELECT StoreId")).toMatch(/FROM/);
    expect(fail("SELECT StoreId FROM")).toMatch(/FROM/);
    expect(fail("SELECT StoreId FROM Missing")).toMatch(/no table/);
    expect(fail("SELECT StoreId FROM Store WHERE OR Name = 'A'")).toMatch(/AND/);
    expect(fail("SELECT Sku FROM Product WHERE LIKE SKU = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Sku FROM Product WHERE SKU > 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Sku FROM Product WHERE SKU SKU")).toMatch(/filters with =/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = paper")).toMatch(/quoted value/);
    expect(fail("SELECT StoreId FROM Store WHERE Name = 'A'")).toMatch(/cannot filter/);
    expect(fail("SELECT OrderId FROM \"Order\" WHERE OrderStatus = 'lost'")).toMatch(/awaiting_payment/);
    expect(fail("SELECT OrderId FROM \"Order\" WHERE StoreId = 'north'")).toMatch(/whole number/);
    expect(fail("SELECT OrderId FROM \"Order\" WHERE OrderDateStart = 'yesterday'")).toMatch(/calendar days/);
    expect(fail("SELECT OrderId FROM \"Order\" WHERE OrderDateStart = '2024-13-40'")).toMatch(/calendar days/);
    expect(
      fail("SELECT OrderId FROM \"Order\" WHERE OrderDateStart = '2024-07-19' AND OrderDateEnd = '2024-07-01'"),
    ).toMatch(/later/);
    expect(fail(`SELECT Sku FROM Product WHERE Name = '${"x".repeat(201)}'`)).toMatch(/printable text/);
    expect(fail("SELECT TrackingNumber FROM Shipment WHERE TrackingNumber = 'A' ORDER BY ShipDate")).toMatch(
      /does not sort/,
    );
    expect(fail("SELECT Sku FROM Product JOIN Store")).toMatch(/one table/);
    expect(fail("SELECT Sku FROM Product.Extra")).toMatch(/one table/);
    expect(fail("SELECT Sku FROM Product GROUP BY Sku")).toMatch(/one table/);
    expect(fail("SELECT Sku FROM Product UNION SELECT Sku FROM Product")).toMatch(/one table/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = 'A' OR Name = 'B'")).toMatch(/AND/);
    expect(fail("SELECT COUNT(*) FROM Store LIMIT 1")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Store OFFSET 1")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT StoreId FROM Store LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT StoreId FROM Store LIMIT 1.5")).toMatch(/whole number/);
    expect(fail('SELECT OrderId FROM "Order" LIMIT 10 OFFSET 5')).toMatch(/multiple of LIMIT/);
    expect(fail('SELECT OrderId FROM "Order" LIMIT 500 OFFSET 10000')).toMatch(/stop at 20/);
    expect(fail("SELECT StoreId FROM Store OFFSET 10001")).toMatch(/at most 10000/);
    expect(fail("SELECT StoreId FROM Store; SELECT StoreId FROM Store")).toMatch(/one statement/);
    expect(translateShipStationSql("SELECT Sku FROM Product WHERE SKU = 'a''b'")).toMatchObject({
      filters: [{ value: "a'b" }],
    });
    expect(translateShipStationSql('SELECT "A""B" FROM Store')).toMatchObject({ columns: ['A"B'] });
    expect(fail("SELECT Sku FROM Product WHERE SKU = 'open")).toMatch(/not closed/);
    expect(fail('SELECT Sku FROM "open')).toMatch(/not closed/);
    expect(fail("SELECT Sku FROM Product /* open")).toMatch(/not closed/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT Sku FROM Product @")).toMatch(/could not read/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT Sku FROM Product WHERE SKU = 1.2.3")).toMatch(/could not read that number/);
    expect(translateShipStationSql("SELECT Sku FROM Product WHERE Name = true LIMIT 900;")).toMatchObject({
      capped: true,
      limit: 500,
      filters: [{ value: "true" }],
    });
  });
});
