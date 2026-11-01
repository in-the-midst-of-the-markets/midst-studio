import { describe, expect, test } from "bun:test";
import {
  applyQueryFilters,
  queryFilterShape,
  queryIdentity,
  readQueryFilters,
  writeQueryFilter,
} from "@/lib/charts/query-filters";

describe("query filters", () => {
  test("reads one control per name and ignores placeholders that are not code", () => {
    const sql = [
      "SELECT '{{region:hidden}}' AS quoted, \"{{region:hidden}}\" AS ident, `{{region:hidden}}` AS tick,",
      "'it''s {{region:hidden}}' AS escaped,",
      "-- {{region:hidden}}",
      "/* {{region:hidden}} */",
      "region = {{ region : east | east, west }},",
      "note = {{note:into}},",
      "amount >= {{min:10}},",
      "code = {{code:01}},",
      "again = {{region:west|west}}",
      "/* unfinished",
    ].join("\n");
    expect(readQueryFilters(sql)).toEqual([
      { name: "region", value: "east", options: ["east", "west"] },
      { name: "note", value: "into", options: [] },
      { name: "min", value: "10", options: [] },
      { name: "code", value: "01", options: [] },
    ]);
    expect(readQueryFilters("SELECT {{not-a name}}")).toEqual([]);
    expect(readQueryFilters("SELECT {{region")).toEqual([]);
    expect(readQueryFilters("-- {{region:east}}")).toEqual([]);
    expect(readQueryFilters("SELECT 1")).toEqual([]);
  });

  test("substitutes a literal and leaves a statement with no filter untouched", () => {
    const plain = "SELECT * FROM users";
    expect(applyQueryFilters(plain)).toBe(plain);
    expect(
      applyQueryFilters(
        "SELECT month FROM orders WHERE region = {{region:O'Brien|east,west}} AND total >= {{min:-2.5}} AND zip = {{zip:01}} AND label = {{label:}} AND code = {{code:10|10,11}}",
      ),
    ).toBe(
      "SELECT month FROM orders WHERE region = 'O''Brien' AND total >= -2.5 AND zip = '01' AND label = '' AND code = '10'",
    );
  });

  test("caps a long list of choices and skips a choice that cannot be stored", () => {
    const options = Array.from({ length: 25 }, (_, index) => `c${index}`);
    options.splice(3, 0, "bad}choice", "");
    const filters = readQueryFilters(`SELECT {{bucket:c0|${options.join(",")}}}`);
    expect(filters[0]?.options).toHaveLength(24);
    expect(filters[0]?.options).not.toContain("bad}choice");
    expect(filters[0]?.options[0]).toBe("c0");
  });

  test("compares two values of one filter as the same statement", () => {
    const east = "  SELECT month FROM orders WHERE region = {{region:east|east,west}} AND total >= {{min:1}}  ";
    const west = "SELECT month FROM orders WHERE region = {{region:west|east,west}} AND total >= {{min:9}}";
    expect(queryFilterShape(east)).toBe(queryFilterShape(west));
    expect(queryFilterShape("  SELECT 1  ")).toBe("SELECT 1");
  });

  test("ignores spacing, a trailing limit, and a semicolon when naming a statement", () => {
    const left = "SELECT month, revenue FROM orders WHERE region = {{region:east|east,west}} LIMIT 200;";
    const right = "SELECT   month,\nrevenue FROM orders WHERE region = {{region:west|east,west}}\nLIMIT 50 OFFSET 0";
    expect(queryIdentity(left)).toBe(queryIdentity(right));
    expect(queryIdentity(left)).toBe("SELECT month, revenue FROM orders WHERE region = {{region|east,west}}");
    expect(queryIdentity('SELECT "Month" FROM orders')).toBe('SELECT "Month" FROM orders');
    expect(queryIdentity("SELECT month FROM orders")).not.toBe(queryIdentity("select month FROM orders"));
  });

  test("writes a new value into every placeholder of that name", () => {
    const sql = "SELECT {{region:east|east}} , {{region:east|west,north}} , {{min:1}}";
    expect(writeQueryFilter(sql, "region", " we|st}\n")).toBe(
      "SELECT {{region:west|east}} , {{region:west|west,north}} , {{min:1}}",
    );
    expect(writeQueryFilter(sql, "min", "")).toBe("SELECT {{region:east|east}} , {{region:east|west,north}} , {{min}}");
    expect(writeQueryFilter(sql, "region", "")).toBe("SELECT {{region:|east}} , {{region:|west,north}} , {{min:1}}");
    expect(writeQueryFilter("SELECT 1", "region", "east")).toBe("SELECT 1");
  });
});
