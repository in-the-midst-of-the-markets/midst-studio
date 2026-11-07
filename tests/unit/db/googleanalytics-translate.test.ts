import { describe, expect, test } from "bun:test";
import { GOOGLEANALYTICS_SQL_GRAMMAR } from "@/lib/db/providers/sql/googleanalytics/sql-grammar";
import { gaDate, translateGaSql } from "@/lib/db/providers/sql/googleanalytics/translate";

describe("Google Analytics SQL", () => {
  test("reads a report select and defaults the dates", () => {
    const parsed = translateGaSql(
      "SELECT country, activeUsers FROM report WHERE startDate = '2024-01-01' AND endDate = 'today' AND country = 'US' AND activeUsers = 10 ORDER BY activeUsers DESC LIMIT 20 OFFSET 5",
    );
    expect(parsed).toMatchObject({
      columns: ["country", "activeUsers"],
      startDate: "2024-01-01",
      endDate: "today",
      filters: [
        { column: "country", value: "US" },
        { column: "activeUsers", value: "10" },
      ],
      orderBy: { column: "activeUsers", desc: true },
      limit: 20,
      offset: 5,
    });
    expect(translateGaSql("SELECT * FROM report")).toMatchObject({
      columns: null,
      startDate: "7daysAgo",
      endDate: "yesterday",
      limit: null,
    });
    expect(gaDate("yesterday")).toBe(true);
    expect(gaDate("7daysAgo")).toBe(true);
    expect(gaDate("soon")).toBe(false);
    const noted = translateGaSql(
      "-- note\nSELECT \"a\"\"b\", activeUsers /* kept */ FROM report WHERE country = 'O''Brien';",
    );
    expect(noted.columns).toEqual(['a"b', "activeUsers"]);
    expect(noted.filters).toEqual([{ column: "country", value: "O'Brien" }]);
    expect(translateGaSql("SELECT country, activeUsers FROM report ORDER BY country LIMIT 1").limit).toBe(1);
    const format = GOOGLEANALYTICS_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = GOOGLEANALYTICS_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("Google Analytics grammar completion is incomplete");
    expect(format('a"b')).toBe('"a""b"');
    expect(readQuoted('"report".')).toBe("report");
    expect(readQuoted("report.")).toBeUndefined();
  });

  test("refuses a count, a write, and a date the API does not take", () => {
    expect(() => translateGaSql("")).toThrow(/read-only/);
    expect(() => translateGaSql("DELETE FROM report")).toThrow(/read-only/);
    expect(() => translateGaSql("SELECT COUNT(*) FROM report")).toThrow(/activeUsers/);
    expect(() => translateGaSql("SELECT country FROM report; SELECT country FROM report")).toThrow(/one statement/);
    expect(() => translateGaSql("SELECT country FROM report WHERE startDate = 'soon'")).toThrow(/YYYY-MM-DD/);
    expect(() => translateGaSql("SELECT country FROM report WHERE country > 'US'")).toThrow(/column = 'value'/);
    expect(() => translateGaSql("SELECT country FROM report WHERE country = country")).toThrow(/quotes/);
    expect(() => translateGaSql("SELECT country sessions")).toThrow(/FROM report/);
    expect(() => translateGaSql("SELECT country FROM sessions")).toThrow(/one table/);
    expect(() => translateGaSql("SELECT country FROM report ORDER country")).toThrow(/ORDER BY/);
    expect(() => translateGaSql("SELECT country FROM report LIMIT nope")).toThrow(/LIMIT/);
    expect(() => translateGaSql("SELECT country FROM report OFFSET nope")).toThrow(/OFFSET/);
    expect(() => translateGaSql("SELECT country FROM report /*")).toThrow(/could not read/);
    expect(() => translateGaSql("SELECT country FROM report WHERE country = 'US")).toThrow(/could not read/);
    expect(() => translateGaSql('SELECT "country FROM report')).toThrow(/could not read/);
    expect(() => translateGaSql("SELECT country FROM report @")).toThrow(/read-only/);
    expect(() => translateGaSql("SELECT , FROM report")).toThrow(/column name/);
  });
});
