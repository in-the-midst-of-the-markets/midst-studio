import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { DATADOG_RESOURCES, datadogResource, translateDatadogSql } from "@/lib/db/providers/sql/datadog/translate";

const fail = (sql: string): string => {
  try {
    translateDatadogSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

describe("Datadog SQL", () => {
  test("lists the resources and the editor words are statements the translator accepts", () => {
    expect(DATADOG_RESOURCES.map((entry) => entry.name)).toEqual(["Monitor", "Host", "Dashboard"]);
    expect(datadogResource("HOST")?.name).toBe("Host");
    expect(datadogResource("missing")).toBeNull();
    expect(SQL_GRAMMAR.datadog.readsSqlText).toBe(true);
    expect(SQL_GRAMMAR.datadog.grammar.formatterLanguage).toBe("mysql");
    const words = SQL_GRAMMAR.datadog.grammar.completionWords;
    if (words === undefined) throw new Error("datadog completion");
    expect(words.lists).toBe("only");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.datadog.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.datadog.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("datadog completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"Host List".')).toBe("Host List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Monitor.")).toBeUndefined();
    expect(SQL_GRAMMAR.datadog.completion.nameIsDottedWord).toBe(true);
    const clauses = SQL_GRAMMAR.datadog.grammar.completionClauses?.values;
    expect(clauses?.FROM?.when).toBe("any");
    expect(clauses?.FROM?.words).toContain("Monitor");
    expect(clauses?.SELECT?.words).toContain("Name");
    expect(clauses?.WHERE?.words).toContain("Status");
    expect(clauses?.WHERE?.words).toContain("'Alert'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      const statement = translateDatadogSql(sql);
      expect(statement.kind === "list" || statement.kind === "count").toBe(true);
    }
  });

  test("translates monitors, hosts, dashboards and a count", () => {
    const monitors = translateDatadogSql(
      "SELECT Id, Name FROM Monitor WHERE status = 'Alert' AND Query = 'type:metric' LIMIT 30 OFFSET 30 -- fresh\n/* note */",
    );
    expect(monitors).toMatchObject({
      kind: "list",
      columns: ["Id", "Name"],
      limit: 30,
      offset: 30,
      capped: false,
      filters: [
        { name: "Status", param: "status", value: "Alert" },
        { name: "Query", param: "query", value: "type:metric" },
      ],
    });
    expect(translateDatadogSql("SELECT * FROM Host WHERE Filter = 'env:prod' AND SortDir = 'asc'")).toMatchObject({
      columns: null,
      resource: { name: "Host" },
      limit: 100,
    });
    expect(translateDatadogSql("SELECT COUNT(*) AS totalCount FROM Host WHERE From = 1700000000")).toMatchObject({
      kind: "count",
      alias: "totalCount",
      resource: { name: "Host" },
      filters: [{ name: "From", value: "1700000000" }],
    });
    expect(translateDatadogSql("SELECT Id FROM Dashboard WHERE Shared = true")).toMatchObject({
      limit: 100,
      filters: [{ name: "Shared", value: "true" }],
    });
    expect(translateDatadogSql("SELECT Name FROM Host LIMIT 1000 OFFSET 1000")).toMatchObject({
      limit: 1000,
      offset: 1000,
      capped: false,
    });
    expect(translateDatadogSql("SELECT Id FROM Monitor")).toMatchObject({ limit: 30, offset: 0 });
  });

  test("refuses writes, the wrong shape, and a filter the list will not take", () => {
    expect(fail("")).toMatch(/SELECT/);
    expect(fail("DELETE FROM Monitor")).toMatch(/read-only/);
    expect(fail("EXPLAIN SELECT Id FROM Monitor")).toMatch(/SELECT/);
    expect(fail("SELECT COUNT(1) FROM Monitor")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Monitor")).toMatch(/name after AS/);
    expect(fail("SELECT COUNT(*) AS WHERE FROM Monitor")).toMatch(/name after AS/);
    expect(fail('SELECT COUNT(*) AS "" FROM Monitor')).toMatch(/name after AS/);
    expect(fail("SELECT FROM Monitor")).toMatch(/column name/);
    expect(fail("SELECT , FROM Monitor")).toMatch(/column name/);
    expect(fail("SELECT Id")).toMatch(/FROM/);
    expect(fail("SELECT Id FROM")).toMatch(/FROM/);
    expect(fail("SELECT Id FROM Missing")).toMatch(/no table/);
    expect(fail("SELECT Id FROM Monitor WHERE OR Name = 'A'")).toMatch(/AND/);
    expect(fail("SELECT Id FROM Monitor WHERE LIKE Query = 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Monitor WHERE Query > 'A'")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Monitor WHERE Query Query")).toMatch(/filters with =/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = paper")).toMatch(/quoted value/);
    expect(fail("SELECT Id FROM Monitor WHERE Name = 'A'")).toMatch(/cannot filter/);
    expect(fail("SELECT Id FROM Monitor WHERE Status = 'down'")).toMatch(/must be Alert, Warn, OK/);
    expect(fail("SELECT Name FROM Host WHERE SortDir = 'up'")).toMatch(/must be asc or desc/);
    expect(fail("SELECT Id FROM Dashboard WHERE Shared = 'yes'")).toMatch(/must be true or false/);
    expect(fail("SELECT Name FROM Host WHERE From = 'yesterday'")).toMatch(/whole number of seconds/);
    expect(fail("SELECT Name FROM Host WHERE From = 1.5")).toMatch(/whole number of seconds/);
    expect(fail("SELECT Name FROM Host WHERE SortField = 'CPU'")).toMatch(/short name/);
    expect(fail(`SELECT Id FROM Monitor WHERE Query = '${"x".repeat(201)}'`)).toMatch(/printable text/);
    expect(fail("SELECT Id FROM Monitor ORDER BY Name")).toMatch(/does not sort/);
    expect(fail("SELECT Id FROM Monitor JOIN Host")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Monitor.Extra")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Monitor GROUP BY Name")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Monitor UNION SELECT Id FROM Monitor")).toMatch(/one table/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = 'A' OR Status = 'Alert'")).toMatch(/AND/);
    expect(fail("SELECT COUNT(*) FROM Monitor LIMIT 1")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Monitor OFFSET 1")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT COUNT(*) FROM Dashboard")).toMatch(/does not return a total/);
    expect(fail("SELECT Id FROM Dashboard WHERE Shared = true AND Deleted = false")).toMatch(/not both/);
    expect(fail("SELECT Id FROM Monitor LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT Id FROM Monitor LIMIT 1.5")).toMatch(/whole number/);
    expect(fail("SELECT Id FROM Monitor LIMIT 30 OFFSET 5")).toMatch(/multiple of LIMIT/);
    expect(fail("SELECT Id FROM Monitor LIMIT 30 OFFSET 10020")).toMatch(/at most 10000/);
    expect(fail("SELECT Id FROM Monitor; SELECT Id FROM Monitor")).toMatch(/one statement/);
    expect(translateDatadogSql("SELECT Id FROM Monitor WHERE Query = 'a''b'")).toMatchObject({
      filters: [{ value: "a'b" }],
    });
    expect(translateDatadogSql('SELECT "A""B" FROM Monitor')).toMatchObject({ columns: ['A"B'] });
    expect(fail("SELECT Id FROM Monitor WHERE Query = 'open")).toMatch(/not closed/);
    expect(fail('SELECT Id FROM "open')).toMatch(/not closed/);
    expect(fail("SELECT Id FROM Monitor /* open")).toMatch(/not closed/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT Id FROM Monitor @")).toMatch(/could not read/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT Id FROM Monitor WHERE Query = 1.2.3")).toMatch(/could not read that number/);
    expect(translateDatadogSql("SELECT Id FROM Monitor WHERE Query = true LIMIT 500;")).toMatchObject({
      capped: true,
      limit: 100,
      filters: [{ value: "true" }],
    });
  });
});
