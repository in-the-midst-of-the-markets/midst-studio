import { describe, expect, test } from "bun:test";
import { joinSqlPieces } from "@/lib/saved-join/preview";

describe("joinSqlPieces", () => {
  test("keeps each SQL keyword separate from the rest of its line", () => {
    expect(
      joinSqlPieces(
        'SELECT *\nFROM orders\nINNER JOIN people\nON orders."id" = people."id"\n  AND orders."region" = people."region"',
      ),
    ).toEqual([
      { indent: "", keyword: "SELECT", rest: " *" },
      { indent: "", keyword: "FROM", rest: " orders" },
      { indent: "", keyword: "INNER JOIN", rest: " people" },
      { indent: "", keyword: "ON", rest: ' orders."id" = people."id"' },
      { indent: "  ", keyword: "AND", rest: ' orders."region" = people."region"' },
    ]);
    expect(joinSqlPieces("LEFT JOIN t\nRIGHT JOIN t\nFULL JOIN t\nplain").map((piece) => piece.keyword)).toEqual([
      "LEFT JOIN",
      "RIGHT JOIN",
      "FULL JOIN",
      "",
    ]);
    expect(joinSqlPieces("plain").map((piece) => piece.rest)).toEqual(["plain"]);
  });
});
