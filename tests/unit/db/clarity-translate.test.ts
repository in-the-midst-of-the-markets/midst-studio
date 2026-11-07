import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { CLARITY_SQL_GRAMMAR } from "@/lib/db/providers/sql/clarity/sql-grammar";
import { clarityBreakdown, clarityDimension, translateClaritySql } from "@/lib/db/providers/sql/clarity/translate";

describe("Clarity SQL", () => {
  test("reads a select, a count, comments and quoted names", () => {
    const select = translateClaritySql(
      `-- note\nSELECT "Country/Region", OS /* mid */ FROM insights WHERE days = '2' AND OS = 'Android' ORDER BY OS ASC LIMIT 10 OFFSET 1`,
    );
    expect(select).toMatchObject({
      kind: "select",
      columns: ["Country/Region", "OS"],
      days: 2,
      filters: [{ column: "OS", value: "Android" }],
      orderBy: { column: "OS", desc: false },
      limit: 10,
      offset: 1,
    });
    expect(clarityBreakdown(select, select.kind === "select" ? select.columns : null)).toEqual([
      "Country/Region",
      "OS",
    ]);
    expect(clarityDimension("os")).toBe("OS");
    expect(clarityDimension("totalSessionCount")).toBeNull();
    const counted = translateClaritySql("SELECT COUNT(*) AS row_count FROM insights WHERE numOfDays = 3 LIMIT 5");
    expect(counted).toMatchObject({ kind: "count", days: 3 });
    expect(translateClaritySql("SELECT * FROM insights").kind).toBe("select");
    expect(translateClaritySql("SELECT OS FROM insights;").kind).toBe("select");
    const limited = translateClaritySql("SELECT OS FROM insights ORDER BY OS LIMIT 1");
    expect(limited.kind === "select" ? limited.limit : null).toBe(1);
    expect(translateClaritySql("SELECT \"O\"\"S\" FROM insights WHERE OS = 'A''B'").filters).toEqual([
      { column: "OS", value: "A'B" },
    ]);
    const format = CLARITY_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = CLARITY_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("Clarity grammar completion is incomplete");
    expect(format('a"b')).toBe('"a""b"');
    expect(readQuoted('"insights".')).toBe("insights");
    expect(readQuoted("insights.")).toBeUndefined();
  });

  test("refuses a write, a second statement, and a breakdown of more than three dimensions", () => {
    expect(() => translateClaritySql("")).toThrow(QueryError);
    expect(() => translateClaritySql("INSERT INTO insights VALUES (1)")).toThrow(/read-only/);
    expect(() => translateClaritySql("SELECT OS FROM insights; SELECT OS FROM insights")).toThrow(/one statement/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE days = 9")).toThrow(/1, 2, or 3/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE days = 1 AND days = 2")).toThrow(/1, 2, or 3/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE OS > 'a'")).toThrow(/column = 'value'/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE OS = OS")).toThrow(/quotes/);
    expect(() => translateClaritySql("SELECT FROM insights")).toThrow(/one table|FROM insights/);
    expect(() => translateClaritySql("SELECT OS insights")).toThrow(/FROM insights/);
    expect(() => translateClaritySql("SELECT OS FROM sessions")).toThrow(/one table/);
    expect(() => translateClaritySql("SELECT OS FROM insights ORDER OS")).toThrow(/ORDER BY/);
    expect(() => translateClaritySql("SELECT OS FROM insights LIMIT nope")).toThrow(/LIMIT/);
    expect(() => translateClaritySql("SELECT OS FROM insights OFFSET nope")).toThrow(/OFFSET/);
    expect(() => translateClaritySql("SELECT OS FROM insights OR 1")).toThrow(/read-only/);
    expect(() => translateClaritySql("SELECT , FROM insights")).toThrow(/column name/);
    expect(() => translateClaritySql("SELECT COUNT(OS) FROM insights")).toThrow(/COUNT\(\*\)/);
    expect(() => translateClaritySql("SELECT COUNT(*) FROM insights ORDER BY OS")).toThrow(/ORDER BY/);
    expect(() => translateClaritySql("SELECT OS FROM insights /*")).toThrow(/could not read/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE OS = 'a")).toThrow(/could not read/);
    expect(() => translateClaritySql('SELECT "OS FROM insights')).toThrow(/could not read/);
    expect(() => translateClaritySql("SELECT OS FROM insights WHERE @ = 1")).toThrow(/read-only/);
    const wide = translateClaritySql(
      "SELECT Browser, Device, OS, Source FROM insights WHERE \"Country/Region\" = 'US'",
    );
    expect(() => clarityBreakdown(wide, wide.kind === "select" ? wide.columns : null)).toThrow(/three dimensions/);
  });
});
