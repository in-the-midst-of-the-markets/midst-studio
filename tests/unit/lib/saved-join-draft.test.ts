import { describe, expect, test } from "bun:test";
import { crossJoinDraft, type CrossJoinKind, type JoinTable } from "@/lib/saved-join/draft";

function table(tableId: string, columns: readonly string[], star = false): JoinTable {
  return { tableId, columns, star };
}

describe("crossJoinDraft", () => {
  test("writes a DuckDB join on the columns the two queries share", () => {
    const draft = crossJoinDraft(
      table("orders", ["id", "region", "id"]),
      table("people", ["ID", 'a"b', "name"]),
      "INNER",
    );
    expect(draft.sql).toBe('SELECT *\nFROM orders\nINNER JOIN people\nON orders."id" = people."ID"');
    expect(draft.note).toBe("Joins on id.");
  });

  test("quotes a column whose name contains a quote", () => {
    const draft = crossJoinDraft(table("orders", ['a"b']), table("people", ['a"b']), "LEFT");
    expect(draft.sql).toBe('SELECT *\nFROM orders\nLEFT JOIN people\nON orders."a""b" = people."a""b"');
    expect(draft.note).toBe('Joins on a"b.');
  });

  test.each(["RIGHT", "FULL"] as const)("uses the %s join", (kind: CrossJoinKind) => {
    const draft = crossJoinDraft(table("orders", ["id"]), table("people", ["id"]), kind);
    expect(draft.sql).toContain(kind === "RIGHT" ? "RIGHT JOIN" : "FULL JOIN");
  });

  test("leaves the ON clause empty when no column name is shared", () => {
    const draft = crossJoinDraft(table("orders", ["id"]), table("people", ["name"]), "INNER");
    expect(draft.sql).toBe("SELECT *\nFROM orders\nINNER JOIN people\nON ");
    expect(draft.note).toBe("These queries do not share a column name. Finish the ON clause in the editor.");
  });

  test("says which side hides its columns behind a star", () => {
    const left = crossJoinDraft(table("orders", [], true), table("people", ["id"]), "INNER");
    expect(left.note).toBe(
      "orders uses SELECT *, so its columns stay hidden. Name them in that saved query to match a key.",
    );
    const right = crossJoinDraft(table("orders", ["id"]), table("people", [], true), "INNER");
    expect(right.note).toBe(
      "people uses SELECT *, so its columns stay hidden. Name them in that saved query to match a key.",
    );
    const both = crossJoinDraft(table("orders", [], true), table("people", [], true), "INNER");
    expect(both.note).toContain("orders uses SELECT *");
  });

  test("refuses to join a saved query to itself", () => {
    const draft = crossJoinDraft(table("Orders", ["id"]), table("orders", ["id"]), "INNER");
    expect(draft.sql).toBeNull();
    expect(draft.note).toBe("Pick two different saved queries.");
  });

  test("joins on every shared column", () => {
    const draft = crossJoinDraft(table("orders", ["id", "region"]), table("people", ["region", "id"]), "FULL");
    expect(draft.sql).toBe(
      'SELECT *\nFROM orders\nFULL JOIN people\nON orders."id" = people."id"\n  AND orders."region" = people."region"',
    );
    expect(draft.note).toBe("Joins on id and region.");
  });
});
