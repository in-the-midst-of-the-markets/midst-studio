import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { AIRTABLE_SQL_GRAMMAR } from "@/lib/db/providers/sql/airtable/sql-grammar";
import { translateAirtableSql } from "@/lib/db/providers/sql/airtable/translate";

function rejected(sql: string): string {
  try {
    translateAirtableSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal for ${sql}`);
}

describe("Airtable SQL", () => {
  test("reads a filtered, sorted, paged table", () => {
    expect(
      translateAirtableSql(
        `SELECT "Task", Status FROM app."Tasks" WHERE "A}" = 'x' AND NOT Done = TRUE OR Status IS NULL ORDER BY Status DESC, "Task" LIMIT 10 OFFSET 2;`,
      ),
    ).toMatchObject({
      kind: "select",
      table: "Tasks",
      columns: ["Task", "Status"],
      sorts: [
        { field: "Status", direction: "desc" },
        { field: "Task", direction: "asc" },
      ],
      limit: 10,
      offset: 2,
    });
  });

  test("reads comparisons, LIKE, and parenthesised OR", () => {
    const statement = translateAirtableSql(
      `SELECT * FROM Tasks WHERE (Name = 'O''Brien' OR Score >= 1.5) AND Flag != FALSE AND Name LIKE 'A%' AND Note LIKE '%z' AND Title LIKE '%mid%' AND Name IS NOT NULL AND Empty = NULL`,
    );
    expect(statement.kind).toBe("select");
    if (statement.kind !== "select") return;
    expect(statement.columns).toBeNull();
    expect(statement.formula).toContain("AND(");
    expect(statement.formula).toContain("OR(");
    expect(statement.formula).toContain("LEFT(");
    expect(statement.formula).toContain("RIGHT(");
    expect(statement.formula).toContain("FIND(");
    expect(statement.formula).toContain("NOT(");
    expect(statement.formula).toContain("BLANK()");
    expect(statement.formula).toContain("FALSE()");
  });

  test("accepts a MySQL limit pair, a bare offset, and a count", () => {
    expect(translateAirtableSql("SELECT * FROM Tasks LIMIT 5, 10")).toMatchObject({ limit: 5, offset: 10 });
    expect(translateAirtableSql("SELECT * FROM Tasks OFFSET 3")).toMatchObject({ limit: null, offset: 3 });
    expect(translateAirtableSql("SELECT COUNT(*) AS row_count FROM c0.Tasks WHERE Name LIKE '%'")).toEqual({
      kind: "count",
      table: "Tasks",
      formula: "TRUE()",
    });
    expect(translateAirtableSql("SELECT COUNT(*) FROM Tasks WHERE Name LIKE '%%'").kind).toBe("count");
    expect(translateAirtableSql("-- note\nSELECT * FROM Tasks /* keep */").kind).toBe("select");
    expect(translateAirtableSql('SELECT "A""B" FROM Tasks')).toMatchObject({ columns: ['A"B'] });
    const format = AIRTABLE_SQL_GRAMMAR.completion.formatSegment;
    expect(format).not.toBeNull();
    expect(format?.('A"B')).toBe('"A""B"');
  });

  test("writes one insert, update, or delete", () => {
    expect(translateAirtableSql(`INSERT INTO Tasks (Name, Score) VALUES ('A', 1), ('B', NULL)`)).toMatchObject({
      kind: "insert",
      rows: [
        [
          ["Name", "A"],
          ["Score", 1],
        ],
        [
          ["Name", "B"],
          ["Score", null],
        ],
      ],
    });
    expect(translateAirtableSql(`UPDATE Tasks SET Name = 'B' WHERE _id = 'rec1'`)).toMatchObject({
      kind: "update",
      recordId: "rec1",
    });
    expect(translateAirtableSql(`DELETE FROM Tasks WHERE "_id" = 'rec1'`)).toMatchObject({ kind: "delete" });
    expect(translateAirtableSql("SELECT Name FROM Tasks WHERE Name LIKE 'abc'").kind).toBe("select");
    expect(
      translateAirtableSql(
        "SELECT Name FROM Tasks WHERE Score > -2 AND Score < 3 AND Score <= 3 AND Score <> 0 AND Score != NULL",
      ),
    ).toMatchObject({
      kind: "select",
    });
  });

  test("refuses what the Web API cannot run", () => {
    expect(rejected("")).toContain("SELECT");
    expect(rejected("WITH t AS (SELECT 1) SELECT * FROM t")).toContain("WITH");
    expect(rejected("JOIN Tasks")).toContain("one table");
    expect(rejected("SELECT DISTINCT Name FROM Tasks")).toContain("DISTINCT");
    expect(rejected("SELECT COUNT(Name) FROM Tasks")).toContain("COUNT(*)");
    expect(rejected("SELECT SUM(Score) FROM Tasks")).toContain("aggregates");
    expect(rejected("SELECT Name AS label FROM Tasks")).toContain("rename");
    expect(rejected("SELECT Name, * FROM Tasks")).toContain("columns");
    expect(rejected("SELECT * FROM Tasks JOIN Other")).toContain("one table");
    expect(rejected("SELECT * FROM a.b.c")).toContain("schema.table");
    expect(rejected("SELECT * FROM Tasks WHERE Name IN ('A')")).toContain("IN or BETWEEN");
    expect(rejected("SELECT * FROM Tasks WHERE Name BETWEEN 1 AND 2")).toContain("IN or BETWEEN");
    expect(rejected("SELECT * FROM Tasks WHERE Name LIKE 1")).toContain("LIKE");
    expect(rejected("SELECT * FROM Tasks WHERE Name LIKE 'a%b%'")).toContain("LIKE");
    expect(rejected("SELECT * FROM Tasks WHERE Name LIKE '%a%b'")).toContain("LIKE");
    expect(rejected("SELECT * FROM Tasks WHERE Name LIKE 'a%b'")).toContain("LIKE");
    expect(rejected("SELECT * FROM Tasks; SELECT * FROM Tasks")).toContain("one statement");
    expect(rejected("SELECT * FROM Tasks WHERE Name")).toContain("comparison");
    expect(rejected("SELECT JOIN FROM Tasks")).toContain("one table");
    expect(rejected("SELECT * FROM Tasks WHERE Name = OTHER")).toContain("value");
    expect(rejected("/*")).toContain("not closed");
    expect(rejected("SELECT 'ab")).toContain("string");
    expect(rejected('SELECT "ab')).toContain("name");
    expect(rejected('SELECT * FROM ""')).toContain("empty");
    expect(rejected("SELECT 1.2.3 FROM Tasks")).toContain("not a number");
    expect(rejected("SELECT * FROM Tasks LIMIT -1")).toContain("LIMIT");
    expect(rejected("SELECT * FROM Tasks LIMIT 1.5")).toContain("LIMIT");
    expect(rejected("SELECT * FROM Tasks WHERE @")).toContain("not part");
    expect(rejected("INSERT INTO Tasks VALUES ('A')")).toContain("column list");
    expect(rejected("INSERT INTO Tasks (Name VALUES ('A')")).toContain("not closed");
    expect(rejected("INSERT INTO Tasks (Name) VALUES 'A'")).toContain("parentheses");
    expect(rejected("INSERT INTO Tasks (Name) VALUES ('A'")).toContain("not closed");
    expect(rejected("INSERT INTO Tasks (Name, Name) VALUES ('A', 'B')")).toContain("once");
    expect(rejected("INSERT INTO Tasks (Name) VALUES ('A', 'B')")).toContain("values");
    expect(
      rejected(`INSERT INTO Tasks (Name) VALUES ${Array.from({ length: 11 }, () => "('A')").join(", ")}`),
    ).toContain("10 rows");
    expect(rejected("UPDATE Tasks SET Name = 'A'")).toContain("_id");
    expect(rejected("UPDATE Tasks SET Name = 'A', Name = 'B' WHERE _id = 'rec'")).toContain("once");
    expect(rejected("UPDATE Tasks SET _id = 'rec' WHERE _id = 'rec'")).toContain("cannot be changed");
    expect(rejected("UPDATE Tasks SET Name 'A' WHERE _id = 'rec'")).toContain("SET");
    expect(rejected("UPDATE Tasks SET Name = 'A' WHERE Name = 'rec'")).toContain("_id");
    expect(rejected("UPDATE Tasks SET Name = 'A' WHERE _id = ''")).toContain("_id");
    expect(rejected("DELETE FROM Tasks")).toContain("_id");
    expect(rejected("SELECT FROM Tasks")).toContain("FROM");
    expect(rejected("SELECT * FROM")).toContain("name is missing");
    expect(rejected("SELEC * FROM Tasks")).toContain("SELECT");
  });
});
