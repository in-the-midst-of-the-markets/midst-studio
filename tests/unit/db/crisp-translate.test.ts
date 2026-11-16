import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { CRISP_RESOURCES, crispResource, translateCrispSql } from "@/lib/db/providers/sql/crisp/translate";

const fail = (sql: string): string => {
  try {
    translateCrispSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

describe("Crisp SQL", () => {
  test("lists the resources and the editor words are statements the translator accepts", () => {
    expect(CRISP_RESOURCES.map((entry) => entry.name)).toEqual(["Conversation", "People", "Operator"]);
    expect(crispResource("PEOPLE")?.name).toBe("People");
    expect(crispResource("missing")).toBeNull();
    expect(SQL_GRAMMAR.crisp.readsSqlText).toBe(true);
    expect(SQL_GRAMMAR.crisp.grammar.formatterLanguage).toBe("mysql");
    const words = SQL_GRAMMAR.crisp.grammar.completionWords;
    if (words === undefined) throw new Error("crisp completion");
    expect(words.lists).toBe("only");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.crisp.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.crisp.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("crisp completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"People List".')).toBe("People List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Operator.")).toBeUndefined();
    expect(SQL_GRAMMAR.crisp.completion.nameIsDottedWord).toBe(true);
    const clauses = SQL_GRAMMAR.crisp.grammar.completionClauses?.values;
    expect(clauses?.FROM?.when).toBe("any");
    expect(clauses?.FROM?.words).toContain("Conversation");
    expect(clauses?.SELECT?.words).toContain("SessionId");
    expect(clauses?.WHERE?.words).toContain("SearchText");
    expect(clauses?.WHERE?.words).toContain("'1'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      const statement = translateCrispSql(sql);
      expect(statement.kind === "list" || statement.kind === "count").toBe(true);
    }
  });

  test("translates conversations, people, operators and a count", () => {
    const conversations = translateCrispSql(
      "SELECT SessionId, State FROM Conversation WHERE filterUnread = '1' AND FilterAssigned = 'ada' AND SearchText = 'hello' AND FilterDateStart = '2024-07-01' AND FilterDateEnd = '2024-07-31T00:00:00Z' LIMIT 20 OFFSET 20 -- fresh\n/* note */",
    );
    expect(conversations).toMatchObject({
      kind: "list",
      columns: ["SessionId", "State"],
      limit: 20,
      offset: 20,
      capped: false,
      filters: [
        { name: "FilterUnread", param: "filter_unread", value: "1" },
        { name: "FilterAssigned", param: "filter_assigned", value: "ada" },
        { name: "SearchText", param: "search_query", value: "hello" },
        { name: "FilterDateStart", value: "2024-07-01" },
        { name: "FilterDateEnd", value: "2024-07-31T00:00:00Z" },
      ],
    });
    expect(translateCrispSql("SELECT * FROM People WHERE SearchText = 'acme'")).toMatchObject({
      columns: null,
      resource: { name: "People" },
    });
    expect(translateCrispSql("SELECT COUNT(*) AS totalCount FROM Operator")).toMatchObject({
      kind: "count",
      alias: "totalCount",
      resource: { name: "Operator" },
    });
    expect(translateCrispSql("SELECT UserId FROM Operator LIMIT 200 OFFSET 10")).toMatchObject({
      limit: 200,
      offset: 10,
      capped: false,
    });
    expect(translateCrispSql("SELECT SessionId FROM Conversation")).toMatchObject({ limit: 20, offset: 0 });
  });

  test("refuses writes, the wrong shape, and a filter the list will not take", () => {
    expect(fail("")).toMatch(/SELECT/);
    expect(fail("DELETE FROM Operator")).toMatch(/read-only/);
    expect(fail("EXPLAIN SELECT UserId FROM Operator")).toMatch(/SELECT/);
    expect(fail("SELECT COUNT(1) FROM Operator")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Operator")).toMatch(/name after AS/);
    expect(fail("SELECT COUNT(*) AS WHERE FROM Operator")).toMatch(/name after AS/);
    expect(fail('SELECT COUNT(*) AS "" FROM Operator')).toMatch(/name after AS/);
    expect(fail("SELECT FROM Operator")).toMatch(/column name/);
    expect(fail("SELECT , FROM Operator")).toMatch(/column name/);
    expect(fail("SELECT UserId")).toMatch(/FROM/);
    expect(fail("SELECT UserId FROM")).toMatch(/FROM/);
    expect(fail("SELECT UserId FROM Missing")).toMatch(/no table/);
    expect(fail("SELECT UserId FROM Operator WHERE OR Email = 'A'")).toMatch(/AND/);
    expect(fail("SELECT PeopleId FROM People WHERE LIKE SearchText = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText > 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText SearchText")).toMatch(/filters with =/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = paper")).toMatch(/quoted value/);
    expect(fail("SELECT UserId FROM Operator WHERE Email = 'A'")).toMatch(/cannot filter/);
    expect(fail("SELECT SessionId FROM Conversation WHERE FilterUnread = '2'")).toMatch(/0 or 1/);
    expect(fail("SELECT SessionId FROM Conversation WHERE FilterDateStart = 'yesterday'")).toMatch(/calendar days/);
    expect(fail("SELECT SessionId FROM Conversation WHERE FilterDateStart = '2024-13-40'")).toMatch(/calendar days/);
    expect(
      fail("SELECT SessionId FROM Conversation WHERE FilterDateStart = '2024-07-19' AND FilterDateEnd = '2024-07-01'"),
    ).toMatch(/later/);
    expect(fail(`SELECT PeopleId FROM People WHERE SearchText = '${"x".repeat(201)}'`)).toMatch(/printable text/);
    expect(fail("SELECT UserId FROM Operator ORDER BY Email")).toMatch(/does not sort/);
    expect(fail("SELECT PeopleId FROM People JOIN Operator")).toMatch(/one table/);
    expect(fail("SELECT PeopleId FROM People.Extra")).toMatch(/one table/);
    expect(fail("SELECT PeopleId FROM People GROUP BY Email")).toMatch(/one table/);
    expect(fail("SELECT PeopleId FROM People UNION SELECT PeopleId FROM People")).toMatch(/one table/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = 'A' OR Email = 'B'")).toMatch(/AND/);
    expect(fail("SELECT COUNT(*) FROM Operator LIMIT 1")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Operator OFFSET 1")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT COUNT(*) FROM Conversation")).toMatch(/does not return a total/);
    expect(fail("SELECT COUNT(*) FROM People WHERE SearchText = 'acme'")).toMatch(/does not return a total/);
    expect(fail("SELECT UserId FROM Operator LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT UserId FROM Operator LIMIT 1.5")).toMatch(/whole number/);
    expect(fail("SELECT SessionId FROM Conversation LIMIT 10")).toMatch(/20 to 50/);
    expect(fail("SELECT SessionId FROM Conversation LIMIT 20 OFFSET 5")).toMatch(/multiple of LIMIT/);
    expect(fail("SELECT SessionId FROM Conversation LIMIT 20 OFFSET 1000")).toMatch(/stop at 50/);
    expect(fail("SELECT UserId FROM Operator OFFSET 10001")).toMatch(/at most 10000/);
    expect(fail("SELECT UserId FROM Operator; SELECT UserId FROM Operator")).toMatch(/one statement/);
    expect(translateCrispSql("SELECT PeopleId FROM People WHERE SearchText = 'a''b'")).toMatchObject({
      filters: [{ value: "a'b" }],
    });
    expect(translateCrispSql('SELECT "A""B" FROM Operator')).toMatchObject({ columns: ['A"B'] });
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = 'open")).toMatch(/not closed/);
    expect(fail('SELECT PeopleId FROM "open')).toMatch(/not closed/);
    expect(fail("SELECT PeopleId FROM People /* open")).toMatch(/not closed/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT PeopleId FROM People @")).toMatch(/could not read/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT PeopleId FROM People WHERE SearchText = 1.2.3")).toMatch(/could not read that number/);
    expect(translateCrispSql("SELECT PeopleId FROM People WHERE SearchText = true LIMIT 90;")).toMatchObject({
      capped: true,
      limit: 50,
      filters: [{ value: "true" }],
    });
  });
});
