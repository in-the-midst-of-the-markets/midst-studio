import { describe, expect, test } from "bun:test";
import {
  addQueryFilter,
  applyQueryFilters,
  promoteQueryFilters,
  queryFilterShape,
  queryIdentity,
  readQueryFilters,
  removeQueryFilter,
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

  test("turns a WHERE or HAVING comparison into a filter and leaves the rest of the statement", () => {
    const sql = [
      "SELECT 'east' AS label, orders.region",
      "FROM orders JOIN cities ON cities.id = 1",
      "WHERE \"region\" = 'east' AND total >= -2 AND flag != 'no' AND city <> 'rome'",
      "AND note = 'O''Brien' AND empty = '' AND code = 01 AND raw = 'a}b'",
      "AND huge = '" + "e".repeat(201) + "'",
      "AND lower(region) = 'hidden'",
      "AND active = TRUE",
      "GROUP BY region",
      "HAVING count >= 2",
      "LIMIT 200",
    ].join(" ");
    const promoted = promoteQueryFilters(sql);
    expect(promoted).toContain('WHERE "region" = {{region:east}}');
    expect(promoted).toContain("total >= {{total:-2}}");
    expect(promoted).toContain("flag != {{flag:no}}");
    expect(promoted).toContain("city <> {{city:rome}}");
    expect(promoted).toContain("note = {{note:O'Brien}}");
    expect(promoted).toContain("empty = {{empty:}}");
    expect(promoted).toContain("code = 01");
    expect(promoted).toContain("raw = 'a}b'");
    expect(promoted).toContain(`huge = '${"e".repeat(201)}'`);
    expect(promoted).toContain("lower(region) = 'hidden'");
    expect(promoted).toContain("active = TRUE");
    expect(promoted).toContain("HAVING count >= {{count:2}}");
    expect(promoted).toContain("LIMIT 200");
    expect(applyQueryFilters(promoted).includes("note = 'O''Brien'")).toBe(true);
    expect(promoteQueryFilters("SELECT {{region:east}}")).toBe("SELECT {{region:east}}");
    expect(promoteQueryFilters(`SELECT ${"a".repeat(41)} FROM t WHERE ${"a".repeat(41)} = 'x'`)).toContain("= 'x'");
    expect(promoteQueryFilters("SELECT 1 -- WHERE a = 'hidden'\nWHERE b = 'shown'")).toBe(
      "SELECT 1 -- WHERE a = 'hidden'\nWHERE b = {{b:shown}}",
    );
    expect(promoteQueryFilters("SELECT 1 /* WHERE a = 'hidden' */ WHERE b = \"shown\"")).toBe(
      "SELECT 1 /* WHERE a = 'hidden' */ WHERE b = {{b:shown}}",
    );
    expect(promoteQueryFilters("SELECT 1 /*")).toBe("SELECT 1 /*");
    expect(promoteQueryFilters("WHERE a = 'east")).toBe("WHERE a = 'east");
    expect(promoteQueryFilters("WHERE \"a-b\" = 'east'")).toBe("WHERE \"a-b\" = 'east'");
    expect(promoteQueryFilters("WHERE `region` = 'east'")).toBe("WHERE `region` = {{region:east}}");
    expect(promoteQueryFilters("SELECT id FROM (SELECT id FROM t WHERE region = 'east') s WHERE id = 7")).toBe(
      "SELECT id FROM (SELECT id FROM t WHERE region = {{region:east}}) s WHERE id = {{id:7}}",
    );
    expect(promoteQueryFilters("WHERE region = {{region:east}} AND region = 'west'")).toBe(
      "WHERE region = {{region:east}} AND region = {{region_2:west}}",
    );
    expect(promoteQueryFilters("SELECT 'it''s' AS s FROM t WHERE b = 'shown'")).toBe(
      "SELECT 'it''s' AS s FROM t WHERE b = {{b:shown}}",
    );
  });

  test("adds a filter beside the other clauses and removes the comparison it created", () => {
    expect(addQueryFilter("SELECT 1", "no-name", "x")).toBe("SELECT 1");
    expect(addQueryFilter("SELECT 1 WHERE a = {{a:1}}", "a", "2")).toBe("SELECT 1 WHERE a = {{a:1}}");
    expect(addQueryFilter("SELECT month FROM orders LIMIT 200", "region", "east", ["east", "east", "", "west"])).toBe(
      "SELECT month FROM orders WHERE region = {{region:east|east,west}} LIMIT 200",
    );
    expect(addQueryFilter("SELECT 1 WHERE a = 1 GROUP BY a HAVING count > 1", "b", "")).toBe(
      "SELECT 1 WHERE a = 1 AND b = {{b}} GROUP BY a HAVING count > 1",
    );
    expect(addQueryFilter("SELECT 1;", "a", "1")).toBe("SELECT 1 WHERE a = {{a:1}};");
    expect(addQueryFilter("SELECT * FROM (SELECT 1 LIMIT 1) t", "a", "1")).toBe(
      "SELECT * FROM (SELECT 1 LIMIT 1) t WHERE a = {{a:1}}",
    );
    expect(addQueryFilter("SELECT 1 /*", "a", "1")).toBe("SELECT 1 /* WHERE a = {{a:1}}");
    expect(addQueryFilter("SELECT 'it''s' FROM t -- note\n/* block */ WHERE a = 1", "b", "2")).toBe(
      "SELECT 'it''s' FROM t -- note\n/* block */ WHERE a = 1 AND b = {{b:2}}",
    );
    const options = Array.from({ length: 25 }, (_, index) => `c${index}`);
    expect(addQueryFilter("SELECT 1", "bucket", "c0", options)).toContain("c23");
    expect(addQueryFilter("SELECT 1", "bucket", "c0", options)).not.toContain("c24");
    const withBoth = "SELECT 1 WHERE region = {{region:east}} AND total >= {{total:10}} LIMIT 5";
    expect(removeQueryFilter(withBoth, "region")).toBe("SELECT 1 WHERE total >= {{total:10}} LIMIT 5");
    expect(removeQueryFilter(withBoth, "total")).toBe("SELECT 1 WHERE region = {{region:east}} LIMIT 5");
    expect(removeQueryFilter("SELECT 1 WHERE region = {{region:east}}", "region")).toBe("SELECT 1");
    expect(removeQueryFilter("SELECT {{region:east}}", "region")).toBe("SELECT {{region:east}}");
    expect(removeQueryFilter("SELECT 1", "region")).toBe("SELECT 1");
    expect(removeQueryFilter("SELECT 1 WHERE myregion = {{region:east}}", "region")).toBe(
      "SELECT 1 WHERE myregion = {{region:east}}",
    );
  });
});
