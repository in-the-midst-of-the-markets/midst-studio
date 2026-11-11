import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { EXCEL_SQL_GRAMMAR } from "@/lib/db/providers/sql/excel/sql-grammar";
import {
  excelColumns,
  excelGrid,
  excelKey,
  excelRows,
  excelSheets,
  translateExcelSql,
} from "@/lib/db/providers/sql/excel/translate";

describe("Excel SQL", () => {
  test("reads one worksheet and keeps the words the editor offers", () => {
    const statement = translateExcelSql(
      "SELECT Name, amount FROM Sheet1 WHERE name = 'Ada' AND amount LIKE '%1%' ORDER BY name DESC LIMIT 5 OFFSET 1",
    );
    expect(statement.resource.name).toBe("sheet1");
    expect(statement.columns).toEqual(["name", "amount"]);
    expect(statement.filters.map((filter) => filter.field)).toEqual(["name", "amount"]);
    expect(statement.orderBy).toEqual({ column: "name", desc: true });
    expect(statement.limit).toBe(5);
    expect(statement.offset).toBe(1);
    expect(translateExcelSql("SELECT * FROM sheet1").columns).toBeNull();
    expect(EXCEL_SQL_GRAMMAR.readsSqlText).toBe(true);
    const words = EXCEL_SQL_GRAMMAR.grammar.completionWords;
    if (words == null) throw new Error("completion words are set");
    expect(words.lists).toBe("only");
    const formatSegment = EXCEL_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = EXCEL_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (formatSegment == null || readQuoted == null) throw new Error("completion helpers are set");
    expect(formatSegment('say "hi"')).toBe('"say ""hi"""');
    expect(readQuoted('"Q1 Sales".')).toBe("Q1 Sales");
    expect(readQuoted("sheet1.")).toBeUndefined();
    expect(() => translateExcelSql("DELETE FROM sheet1")).toThrow(/read-only/);
    expect(() => translateExcelSql("SELECT COUNT(*) FROM sheet1")).toThrow(/COUNT/);
    expect(() => translateExcelSql("")).toThrow(QueryError);
  });

  test("folds worksheet names and header cells into one word", () => {
    const used = new Set<string>();
    const first = excelKey("Sheet1", 1, used, "sheet");
    used.add(first);
    expect(first).toBe("sheet1");
    expect(excelKey("sheet1", 2, used, "sheet")).toBe("sheet1_2");
    expect(excelKey("Q1 Sales", 3, used, "sheet")).toBe("q1_sales");
    expect(excelKey("2024", 4, used, "sheet")).toBe("sheet4");
    expect(excelKey("   ", 5, used, "sheet")).toBe("sheet5");
    expect(excelKey("a".repeat(80), 6, used, "sheet")).toHaveLength(60);
    const long = "b".repeat(60);
    const taken = new Set([long]);
    expect(excelKey(long, 1, taken, "sheet")).toBe(`${"b".repeat(58)}_2`);
    expect(excelColumns(["Name", "", "Amount", "   "]).map((column) => column.name)).toEqual([
      "name",
      "column_2",
      "amount",
    ]);
    expect(excelColumns(["2024"]).map((column) => column.name)).toEqual(["column_1"]);
    expect(excelColumns([null, 4]).map((column) => column.name)).toEqual(["column_1", "column_2"]);
    expect(excelColumns([]).map((column) => column.name)).toEqual(["column_1"]);
    expect(excelColumns(Array.from({ length: 30 }, (_, index) => `c${index}`))).toHaveLength(26);
  });

  test("reads the worksheet list and one text grid", () => {
    const sheets = excelSheets({
      value: [
        { id: "id-sheet", name: "Sheet1", visibility: "Visible" },
        { id: "id-hidden", name: "Secret", visibility: "Hidden" },
        { id: "id-very", name: "Buried", visibility: "VeryHidden" },
        { id: "id-sales", name: "Q1 Sales" },
      ],
    });
    expect(sheets).toEqual([
      { key: "sheet1", id: "id-sheet" },
      { key: "q1_sales", id: "id-sales" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({ id: `id-${index}`, name: `Tab${index}` }));
    expect(excelSheets({ value: many })).toHaveLength(20);
    expect(() => excelSheets({ value: "nope" })).toThrow(QueryError);
    expect(() => excelSheets([])).toThrow(QueryError);
    expect(() => excelSheets({ value: ["nope"] })).toThrow(QueryError);
    expect(() => excelSheets({ value: [{ id: 1, name: "Sheet1" }] })).toThrow(QueryError);
    expect(() => excelSheets({ value: [{ id: "id", name: 1 }] })).toThrow(QueryError);
    expect(() => excelSheets({ value: [{ id: "", name: "Sheet1" }] })).toThrow(QueryError);

    const grid = excelGrid({
      text: [
        ["Name", "Amount", ""],
        ["Ada", 12, ""],
        ["Bea", true, { nested: true }],
        ["", null, ""],
      ],
    });
    expect(grid.columns.map((column) => column.name)).toEqual(["name", "amount"]);
    expect(grid.entries[0]).toEqual({ name: "Ada", amount: "12" });
    expect(grid.entries[1]).toEqual({ name: "Bea", amount: "true" });
    expect(grid.entries[2]).toEqual({ name: null, amount: null });
    expect(grid.more).toBe(false);
    expect(
      excelGrid({
        text: [
          ["Name", "Extra"],
          ["Ada", { nested: true }],
        ],
      }).entries[0],
    ).toEqual({
      name: "Ada",
      extra: null,
    });

    const wide = excelGrid({ text: [Array.from({ length: 26 }, () => "h"), ["x"]] });
    expect(wide.more).toBe(true);
    expect(wide.columns).toHaveLength(26);
    const deep = excelGrid({ text: [["h"], ...Array.from({ length: 500 }, () => ["x"])] });
    expect(deep.entries).toHaveLength(500);
    expect(deep.more).toBe(true);
    expect(() => excelGrid({})).toThrow(QueryError);
    expect(() => excelGrid({ text: [] })).toThrow(QueryError);
    expect(() => excelGrid({ text: ["nope"] })).toThrow(QueryError);
    expect(() => excelGrid({ text: [["h"], "nope"] })).toThrow(QueryError);

    const statement = translateExcelSql("SELECT name FROM sheet1 WHERE name = 'Ada' ORDER BY name");
    expect(excelRows(statement, grid.columns, grid.entries, "SELECT name FROM sheet1")).toEqual([
      { name: "Ada", amount: "12" },
    ]);
    expect(() => excelRows(statement, [{ name: "other", type: "text", json: "other" }], [], "SELECT")).toThrow(
      /no field named name/,
    );
    const filtered = translateExcelSql("SELECT * FROM sheet1 WHERE missing = 'x'");
    expect(() => excelRows(filtered, grid.columns, grid.entries, "SELECT")).toThrow(/missing/);
    const ordered = translateExcelSql("SELECT * FROM sheet1 ORDER BY missing");
    expect(() => excelRows(ordered, grid.columns, grid.entries, "SELECT")).toThrow(/missing/);
    const star = translateExcelSql("SELECT * FROM sheet1");
    expect(excelRows(star, [], [], "SELECT * FROM sheet1")).toEqual([]);
  });
});
