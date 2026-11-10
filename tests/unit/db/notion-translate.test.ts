import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { NOTION_SQL_GRAMMAR } from "@/lib/db/providers/sql/notion/sql-grammar";
import {
  NOTION_ROW_CAP,
  notionFilter,
  notionSorts,
  translateNotionSql,
  type NotionProperty,
} from "@/lib/db/providers/sql/notion/translate";

const properties: readonly NotionProperty[] = [
  { name: "Name", type: "title" },
  { name: "Notes", type: "rich_text" },
  { name: "Link", type: "url" },
  { name: "Email", type: "email" },
  { name: "Phone", type: "phone_number" },
  { name: "Estimate", type: "number" },
  { name: "ID", type: "unique_id" },
  { name: "Done", type: "checkbox" },
  { name: "Status", type: "select" },
  { name: "State", type: "status" },
  { name: "Tags", type: "multi_select" },
  { name: "Due", type: "date" },
  { name: "Created", type: "created_time" },
  { name: "Edited", type: "last_edited_time" },
  { name: "Owner", type: "people" },
  { name: "Editor", type: "created_by" },
  { name: "Last", type: "last_edited_by" },
  { name: "Parent", type: "relation" },
  { name: "Check", type: "verification" },
  { name: "Files", type: "files" },
  { name: "Calc", type: "formula" },
  { name: "Total", type: "rollup" },
  { name: "Place", type: "place" },
];

function read(sql: string) {
  return translateNotionSql(sql);
}

function where(sql: string) {
  const statement = read(sql);
  return notionFilter(statement.kind === "select" ? statement.where : statement.where, properties);
}

function refuse(sql: string, pattern: RegExp): void {
  expect(() => read(sql)).toThrow(QueryError);
  expect(() => read(sql)).toThrow(pattern);
}

describe("translateNotionSql", () => {
  test("reads one SELECT and one COUNT, and drops comments", () => {
    expect(NOTION_ROW_CAP).toBe(1000);
    const select = read(`-- note
      /* keep */ SELECT "Name", Status
      FROM workspace."Tasks"
      WHERE Name = 'A''B' AND Done = TRUE
      ORDER BY Name DESC, Created ASC
      LIMIT 10 OFFSET 2;`);
    expect(select).toEqual({
      kind: "select",
      table: "Tasks",
      columns: ["Name", "Status"],
      where: {
        kind: "and",
        parts: [
          { kind: "cmp", column: "Name", op: "=", value: "A'B" },
          { kind: "cmp", column: "Done", op: "=", value: true },
        ],
      },
      sorts: [
        { field: "Name", direction: "descending" },
        { field: "Created", direction: "ascending" },
      ],
      limit: 10,
      offset: 2,
    });
    const star = read("SELECT * FROM Tasks");
    expect(star.kind === "select" ? star.columns : "not-a-select").toBeNull();
    expect(read("SELECT COUNT(*) AS row_count FROM Tasks WHERE Done = FALSE")).toEqual({
      kind: "count",
      table: "Tasks",
      where: { kind: "cmp", column: "Done", op: "=", value: false },
    });
    expect(read("SELECT Name FROM Tasks LIMIT 5, 1")).toMatchObject({ kind: "select", limit: 5, offset: 1 });
  });

  test("refuses anything outside the read-only subset", () => {
    refuse("", /SELECT/);
    refuse("INSERT INTO Tasks (Name) VALUES ('A')", /read-only/);
    refuse("UPDATE Tasks SET Name = 'A'", /read-only/);
    refuse("DELETE FROM Tasks", /read-only/);
    refuse("WITH t AS (SELECT 1) SELECT * FROM t", /WITH/);
    refuse("JOIN Tasks", /one database/);
    refuse("SELECT DISTINCT Name FROM Tasks", /DISTINCT/);
    refuse("SELECT SUM(Estimate) FROM Tasks", /COUNT/);
    refuse("SELECT Name, Name FROM Tasks", /once/);
    refuse("SELECT Name AS label FROM Tasks", /rename/);
    refuse("SELECT Name, * FROM Tasks", /on its own/);
    refuse("SELECT Name FROM Tasks JOIN Other", /one database/);
    refuse("SELECT Name FROM Tasks, Other", /one database/);
    refuse("SELECT Name FROM a.b.c", /deeper/);
    refuse("SELECT Name FROM Tasks WHERE Name IN ('A')", /IN or BETWEEN/);
    refuse("SELECT Name FROM Tasks WHERE Estimate BETWEEN 1 AND 2", /IN or BETWEEN/);
    refuse("SELECT COUNT(Name) FROM Tasks", /COUNT\(\*\)/);
    refuse("SELECT * FROM Tasks; SELECT * FROM Tasks", /one statement/);
    refuse("SELECT * FROM Tasks WHERE (Name = 'A'", /not closed/);
    refuse("SELECT * FROM /* oops", /not closed/);
    refuse("SELECT * FROM Tasks WHERE Name = 'A", /not closed/);
    refuse('SELECT * FROM "Tas', /not closed/);
    refuse("SELECT * FROM Tasks WHERE Name = 1.2.3", /not a number/);
    refuse("SELECT * FROM Tasks WHERE Name = @", /not part/);
    refuse('SELECT "" FROM Tasks', /empty/);
    refuse("SELECT * FROM", /missing/);
    refuse("SELECT Name FROM Tasks LIMIT -1", /whole number/);
    refuse("SELECT Name FROM Tasks WHERE Name LIKE 1", /LIKE supports/);
    refuse("EXPLAIN Tasks", /read-only/);
    refuse("SELECT * FROM Tasks WHERE Name (", /comparison needs/);
    refuse("SELECT * FROM Tasks WHERE Name = (", /must be a string/);
    const format = NOTION_SQL_GRAMMAR.completion.formatSegment;
    expect(format?.('A"B')).toBe('"A""B"');
    expect(NOTION_SQL_GRAMMAR.completion.readQuotedQualifier?.('"Tasks".')).toBe("Tasks");
  });

  test("builds a filter for each property type Notion can compare", () => {
    expect(where("SELECT * FROM Tasks WHERE Name = 'Alpha'")).toEqual({
      property: "Name",
      title: { equals: "Alpha" },
    });
    expect(where("SELECT * FROM Tasks WHERE name != 'Alpha'")).toEqual({
      property: "Name",
      title: { does_not_equal: "Alpha" },
    });
    expect(where("SELECT * FROM Tasks WHERE Name <> 'Alpha'")).toEqual({
      property: "Name",
      title: { does_not_equal: "Alpha" },
    });
    expect(where("SELECT * FROM Tasks WHERE Notes LIKE 'exact'")).toEqual({
      property: "Notes",
      rich_text: { equals: "exact" },
    });
    expect(where("SELECT * FROM Tasks WHERE Notes LIKE '%cross%'")).toEqual({
      property: "Notes",
      rich_text: { contains: "cross" },
    });
    expect(where("SELECT * FROM Tasks WHERE Link LIKE 'https%'")).toEqual({
      property: "Link",
      url: { starts_with: "https" },
    });
    expect(where("SELECT * FROM Tasks WHERE Email LIKE '%@example.com'")).toEqual({
      property: "Email",
      email: { ends_with: "@example.com" },
    });
    expect(where("SELECT * FROM Tasks WHERE Phone = '555'")).toEqual({
      property: "Phone",
      phone_number: { equals: "555" },
    });
    expect(where("SELECT * FROM Tasks WHERE Notes IS NULL")).toEqual({
      property: "Notes",
      rich_text: { is_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE Notes IS NOT NULL")).toEqual({
      property: "Notes",
      rich_text: { is_not_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate >= 3 AND Estimate < 9 OR Estimate = 0")).toEqual({
      or: [
        {
          and: [
            { property: "Estimate", number: { greater_than_or_equal_to: 3 } },
            { property: "Estimate", number: { less_than: 9 } },
          ],
        },
        { property: "Estimate", number: { equals: 0 } },
      ],
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate != 1")).toEqual({
      property: "Estimate",
      number: { does_not_equal: 1 },
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate <= 1")).toEqual({
      property: "Estimate",
      number: { less_than_or_equal_to: 1 },
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate > 1")).toEqual({
      property: "Estimate",
      number: { greater_than: 1 },
    });
    expect(where("SELECT * FROM Tasks WHERE ID = 'TASK-12'")).toEqual({
      property: "ID",
      unique_id: { equals: 12 },
    });
    expect(where("SELECT * FROM Tasks WHERE ID > 4")).toEqual({
      property: "ID",
      unique_id: { greater_than: 4 },
    });
    expect(where("SELECT * FROM Tasks WHERE Done != FALSE")).toEqual({
      property: "Done",
      checkbox: { does_not_equal: false },
    });
    expect(where("SELECT * FROM Tasks WHERE Status != 'Done'")).toEqual({
      property: "Status",
      select: { does_not_equal: "Done" },
    });
    expect(where("SELECT * FROM Tasks WHERE State = 'Open'")).toEqual({
      property: "State",
      status: { equals: "Open" },
    });
    expect(where("SELECT * FROM Tasks WHERE Tags = 'A'")).toEqual({
      property: "Tags",
      multi_select: { contains: "A" },
    });
    expect(where("SELECT * FROM Tasks WHERE Tags != 'A'")).toEqual({
      property: "Tags",
      multi_select: { does_not_contain: "A" },
    });
    expect(where("SELECT * FROM Tasks WHERE Tags LIKE '%TypeScript%'")).toEqual({
      property: "Tags",
      multi_select: { contains: "TypeScript" },
    });
    expect(where("SELECT * FROM Tasks WHERE Due >= '2026-01-01'")).toEqual({
      property: "Due",
      date: { on_or_after: "2026-01-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Due = 'today'")).toEqual({
      property: "Due",
      date: { equals: "today" },
    });
    expect(where("SELECT * FROM Tasks WHERE Due < '2026-02-01'")).toEqual({
      property: "Due",
      date: { before: "2026-02-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Due > '2026-01-01'")).toEqual({
      property: "Due",
      date: { after: "2026-01-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Due <= '2026-02-01'")).toEqual({
      property: "Due",
      date: { on_or_before: "2026-02-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Created >= '2026-01-01'")).toEqual({
      timestamp: "created_time",
      created_time: { on_or_after: "2026-01-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Edited < '2026-02-01'")).toEqual({
      timestamp: "last_edited_time",
      last_edited_time: { before: "2026-02-01" },
    });
    expect(where("SELECT * FROM Tasks WHERE Owner = 'user-1'")).toEqual({
      property: "Owner",
      people: { contains: "user-1" },
    });
    expect(where("SELECT * FROM Tasks WHERE Editor != 'user-1'")).toEqual({
      property: "Editor",
      people: { does_not_contain: "user-1" },
    });
    expect(where("SELECT * FROM Tasks WHERE Last = 'user-2'")).toEqual({
      property: "Last",
      people: { contains: "user-2" },
    });
    expect(where("SELECT * FROM Tasks WHERE Parent = 'page-1'")).toEqual({
      property: "Parent",
      relation: { contains: "page-1" },
    });
    expect(where("SELECT * FROM Tasks WHERE Parent != 'page-1'")).toEqual({
      property: "Parent",
      relation: { does_not_contain: "page-1" },
    });
    expect(where("SELECT * FROM Tasks WHERE Check = 'verified'")).toEqual({
      property: "Check",
      verification: { status: "verified" },
    });
    expect(where("SELECT * FROM Tasks WHERE Check != 'expired'")).toEqual({
      property: "Check",
      verification: { does_not_equal: "expired" },
    });
    expect(where("SELECT * FROM Tasks WHERE Files IS NULL")).toEqual({
      property: "Files",
      files: { is_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE Files IS NOT NULL")).toEqual({
      property: "Files",
      files: { is_not_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate = NULL")).toEqual({
      property: "Estimate",
      number: { is_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE Estimate != NULL")).toEqual({
      property: "Estimate",
      number: { is_not_empty: true },
    });
    expect(where("SELECT * FROM Tasks WHERE NOT (Done = TRUE OR Status = 'Done')")).toEqual({
      and: [
        { property: "Done", checkbox: { does_not_equal: true } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    });
    expect(where("SELECT * FROM Tasks WHERE NOT NOT Name = 'A'")).toEqual({
      property: "Name",
      title: { equals: "A" },
    });
    expect(() => notionSorts([{ field: "_id", direction: "ascending" }], properties)).toThrow(/page id/);
    expect(notionFilter(null, properties)).toBeNull();
    const sorted = read("SELECT * FROM Tasks ORDER BY Created DESC, Name");
    expect(notionSorts(sorted.kind === "select" ? sorted.sorts : [], properties)).toEqual([
      { timestamp: "created_time", direction: "descending" },
      { property: "Name", direction: "ascending" },
    ]);
  });

  test("refuses a comparison Notion's filter cannot express", () => {
    const bad: ReadonlyArray<readonly [string, RegExp]> = [
      ["SELECT * FROM Tasks WHERE Name > 'A'", / = or !=/],
      ["SELECT * FROM Tasks WHERE Notes LIKE '%'", /LIKE supports/],
      ["SELECT * FROM Tasks WHERE Notes LIKE 'a%b%'", /LIKE supports/],
      ["SELECT * FROM Tasks WHERE Notes LIKE '%a%b'", /LIKE supports/],
      ["SELECT * FROM Tasks WHERE Notes LIKE '%%a'", /LIKE supports/],
      ["SELECT * FROM Tasks WHERE Done IS NULL", /checkbox/],
      ["SELECT * FROM Tasks WHERE Done > TRUE", / = or !=/],
      ["SELECT * FROM Tasks WHERE Done = 'yes'", /TRUE or FALSE/],
      ["SELECT * FROM Tasks WHERE ID IS NULL", /number/],
      ["SELECT * FROM Tasks WHERE ID = 'TASK'", /number/],
      ["SELECT * FROM Tasks WHERE ID = 1.5", /number/],
      ["SELECT * FROM Tasks WHERE Estimate = '3'", /number/],
      ["SELECT * FROM Tasks WHERE Name = 1", /string/],
      ["SELECT * FROM Tasks WHERE Due != 'today'", /not equal/],
      ["SELECT * FROM Tasks WHERE Created IS NULL", /timestamp/],
      ["SELECT * FROM Tasks WHERE Created != 'today'", / =, >, >=, <, or <=/],
      ["SELECT * FROM Tasks WHERE Owner > 'user-1'", /person id/],
      ["SELECT * FROM Tasks WHERE Parent > 'page-1'", /page id/],
      ["SELECT * FROM Tasks WHERE Status > 'Open'", / = or !=/],
      ["SELECT * FROM Tasks WHERE Tags > 'A'", / = or !=/],
      ["SELECT * FROM Tasks WHERE Tags LIKE 'A%'", /contains/],
      ["SELECT * FROM Tasks WHERE Status LIKE '%Open%'", /LIKE filters text/],
      ["SELECT * FROM Tasks WHERE Check = 'maybe'", /verified, expired, or none/],
      ["SELECT * FROM Tasks WHERE Check > 'verified'", /verified, expired, or none/],
      ["SELECT * FROM Tasks WHERE Check IS NULL", /verified, expired, or none/],
      ["SELECT * FROM Tasks WHERE Files = 'a'", /cannot filter Files/],
      ["SELECT * FROM Tasks WHERE Calc = 1", /cannot filter Calc/],
      ["SELECT * FROM Tasks WHERE Calc IS NULL", /formula or a rollup/],
      ["SELECT * FROM Tasks WHERE Total > 1", /cannot filter Total/],
      ["SELECT * FROM Tasks WHERE Place = 'here'", /place/],
      ["SELECT * FROM Tasks WHERE Missing = 1", /no property/],
      ["SELECT * FROM Tasks WHERE _id = 'page'", /page id/],
      ["SELECT * FROM Tasks WHERE NOT Name LIKE '%A%'", /negate LIKE/],
      ["SELECT * FROM Tasks WHERE Name LIKE 'A%B'", /LIKE supports/],
      ["SELECT * FROM Tasks WHERE Name = 'A' AND (Notes = 'B' OR (Status = 'C' AND Done = TRUE))", /two levels/],
    ];
    for (const [sql, pattern] of bad) {
      expect(() => where(sql)).toThrow(pattern);
    }
  });
});
