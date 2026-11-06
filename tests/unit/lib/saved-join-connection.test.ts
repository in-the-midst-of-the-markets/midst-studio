import { describe, expect, test } from "bun:test";
import {
  CROSS_DB_JOINS_CAPABILITIES,
  CROSS_DB_JOINS_ID,
  CROSS_DB_JOINS_NAME,
  crossDbJoinTables,
  crossDbJoinsConnection,
  crossDbJoinsObjectAnswer,
  crossDbJoinsSchema,
  isCrossDbJoins,
  withCrossDbJoins,
} from "@/lib/saved-join/connection";
import type { DatabaseConnection, SavedQuery } from "@/lib/types";

function query(tableId: string | undefined, connectionId = "c1", sql = "SELECT 1"): SavedQuery {
  return {
    id: tableId ?? "none",
    name: tableId ?? "none",
    tableId,
    query: sql,
    connectionType: "postgres",
    connectionId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("Cross_DB_Joins", () => {
  test("is one DuckDB connection the app keeps, named exactly Cross_DB_Joins", () => {
    const connection = crossDbJoinsConnection();
    expect(connection).toMatchObject({
      id: CROSS_DB_JOINS_ID,
      name: CROSS_DB_JOINS_NAME,
      type: "duckdb",
    });
    expect(connection.database).toBeUndefined();
    expect(isCrossDbJoins(connection)).toBe(true);
    expect(isCrossDbJoins(null)).toBe(false);
    expect(isCrossDbJoins(undefined)).toBe(false);
    expect(isCrossDbJoins({ id: "c1" })).toBe(false);
  });

  test("lists it first and does not keep a second copy", () => {
    const own = { id: "c1", name: "App", type: "postgres" } as DatabaseConnection;
    const listed = withCrossDbJoins([crossDbJoinsConnection(), own]);
    expect(listed.map((connection) => connection.id)).toEqual([CROSS_DB_JOINS_ID, "c1"]);
    expect(listed[0]?.name).toBe(CROSS_DB_JOINS_NAME);
  });

  test("tables are saved-query IDs, with no columns, and a query saved here is left out", () => {
    const schema = crossDbJoinsSchema([
      query("people"),
      query("orders"),
      query("Orders"),
      query("not a name"),
      query(undefined),
      query("joined", CROSS_DB_JOINS_ID),
    ]);
    expect(schema.map((object) => object.name)).toEqual(["orders", "people"]);
    expect(schema[0]).toEqual({ name: "orders", kind: "table", path: ["orders"], columns: [], indexes: [] });
    expect(CROSS_DB_JOINS_CAPABILITIES.supportsExplain).toBe(false);
    expect(CROSS_DB_JOINS_CAPABILITIES.supportsTransactions).toBe(false);
    expect(CROSS_DB_JOINS_CAPABILITIES.supportsMaintenance).toBe(false);
    expect(CROSS_DB_JOINS_CAPABILITIES.maintenanceOperations).toEqual([]);
    expect(CROSS_DB_JOINS_CAPABILITIES.supportsConnectionString).toBe(false);
    expect(CROSS_DB_JOINS_CAPABILITIES.defaultPort).toBeNull();
    expect(CROSS_DB_JOINS_CAPABILITIES.queryLanguage).toBe("sql");
  });

  test("the object tree reads those IDs and nothing from a database", () => {
    const queries = [query("orders")];
    expect(crossDbJoinsObjectAnswer(queries, { route: "list", kind: "table" })).toEqual([
      { name: "orders", kind: "table", path: ["orders"] },
    ]);
    expect(crossDbJoinsObjectAnswer(queries, { route: "list", kind: "view" })).toEqual([]);
    expect(crossDbJoinsObjectAnswer(queries, { route: "counts" })).toEqual({});
    expect(crossDbJoinsObjectAnswer(queries, { route: "containers" })).toEqual([]);
    expect(crossDbJoinsObjectAnswer(queries, { route: "describe" })).toEqual({ columns: [], indexes: [] });
    expect(crossDbJoinsObjectAnswer(queries, { route: "describe", path: ["missing"] })).toEqual({
      columns: [],
      indexes: [],
    });
  });

  test("a saved query's select list becomes the table's columns", () => {
    const queries = [
      query("orders", "c1", "SELECT id, id, region -- , secret\n, 'a, b' AS label FROM t"),
      query("people", "c1", "SELECT * FROM people"),
      query("wide", "c1", "SELECT user_id, name FROM people"),
    ];
    expect(crossDbJoinTables(queries)).toEqual([
      { tableId: "orders", columns: ["id", "region", "label"], star: false },
      { tableId: "people", columns: [], star: true },
      { tableId: "wide", columns: ["user_id", "name"], star: false },
    ]);
    const columns = [
      { name: "id", type: "", nullable: true, isPrimary: false },
      { name: "region", type: "", nullable: true, isPrimary: false },
      { name: "label", type: "", nullable: true, isPrimary: false },
    ];
    expect(crossDbJoinsSchema(queries)[0]?.columns).toEqual(columns);
    expect(crossDbJoinsObjectAnswer(queries, { route: "describe", path: ["orders"] })).toEqual({
      columns,
      indexes: [],
    });
  });
});
