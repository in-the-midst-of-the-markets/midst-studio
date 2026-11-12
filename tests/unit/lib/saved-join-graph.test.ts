import { describe, expect, test } from "bun:test";
import { linkedQueryNames, propertyGraphSql } from "@/lib/saved-join/graph";

describe("propertyGraphSql", () => {
  test("links a src/dst table to the one other vertex, and a foreign key to its plural name", () => {
    expect(linkedQueryNames(["id", "customer_id", "source_id"], ["customers", "source"])).toEqual(["customers"]);
    const knows = propertyGraphSql([
      { name: "person", fields: ["id", "name"] },
      { name: "knows", fields: ["src", "dst"] },
    ]);
    expect(knows[0]).toBe("CREATE SCHEMA graph");
    expect(knows.some((statement) => statement.includes('LABEL "knows"'))).toBe(true);
    const orders = propertyGraphSql([
      { name: "orders", fields: ["id", "customer_id"] },
      { name: "customers", fields: ["id", "email"] },
    ]);
    expect(orders.some((statement) => statement.includes('LABEL "orders_customer_id"'))).toBe(true);
    expect(orders.at(-1)).toContain("CREATE PROPERTY GRAPH saved");
  });

  test("builds nothing when no edge can be named", () => {
    expect(propertyGraphSql([{ name: "person", fields: ["id", "name"] }])).toEqual([]);
    expect(propertyGraphSql([{ name: "notes", fields: ["body"] }])).toEqual([]);
  });
});
