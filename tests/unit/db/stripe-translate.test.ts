import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { STRIPE_SQL_GRAMMAR } from "@/lib/db/providers/sql/stripe/sql-grammar";
import { prepareStripeStatement } from "@/lib/db/providers/sql/stripe/translate";

function statement(sql: string): ReturnType<typeof prepareStripeStatement> {
  return prepareStripeStatement(sql);
}

describe("prepareStripeStatement", () => {
  test("sends Sigma SQL through, including a comment, and drops one trailing semicolon", () => {
    expect(statement("-- note\nSELECT id FROM balance_transactions;")).toEqual({
      kind: "query",
      sql: "-- note\nSELECT id FROM balance_transactions",
    });
    expect(statement("WITH recent AS (SELECT id FROM charges) SELECT id FROM recent")).toMatchObject({ kind: "query" });
    expect(statement("select ';' from t")).toMatchObject({ kind: "query", sql: "select ';' from t" });
    expect(statement("SELECT 1 /* kept */")).toMatchObject({ kind: "query", sql: "SELECT 1 /* kept */" });
  });

  test("parses a report and its parameters", () => {
    expect(statement("REPORT balance.summary")).toEqual({ kind: "report", name: "balance.summary", parameters: {} });
    expect(
      statement(
        "report balance.summary (interval_start => '2026-01-01T00:00:00.000Z', interval_end = '2026-02-01T00:00:00.000Z', flag => true, n => 2, empty => false)",
      ),
    ).toEqual({
      kind: "report",
      name: "balance.summary",
      parameters: {
        interval_start: "2026-01-01T00:00:00.000Z",
        interval_end: "2026-02-01T00:00:00.000Z",
        flag: true,
        n: 2,
        empty: false,
      },
    });
    expect(statement("REPORT balance.summary ()")).toEqual({ kind: "report", name: "balance.summary", parameters: {} });
    expect(statement("REPORT balance.summary (label => 'a''b')")).toMatchObject({
      parameters: { label: "a'b" },
    });
  });

  test("treats a click on a report as that report", () => {
    expect(statement('SELECT * FROM "reports"."balance.summary" LIMIT 500')).toEqual({
      kind: "report-preview",
      name: "balance.summary",
    });
    expect(statement('select * from "reports"."plain" offset 10;')).toEqual({ kind: "report-preview", name: "plain" });
    expect(statement('SELECT * FROM "reports"."say""hi"')).toEqual({ kind: "report-preview", name: 'say"hi' });
  });

  test("refuses a write, a second statement, and a report it cannot read", () => {
    expect(() => statement("INSERT INTO t VALUES (1)")).toThrow(QueryError);
    expect(() => statement("")).toThrow(/read-only/);
    expect(() => statement("SELECT 1; SELECT 2")).toThrow(/one statement/);
    expect(() => statement("SELECT 1; -- trailing\nSELECT 2")).toThrow(/one statement/);
    expect(() => statement("REPORT")).toThrow(/report name/);
    expect(() => statement('SELECT * FROM "reports".""')).toThrow(/report name/);
    expect(() => statement("REPORT balance.summary (nope)")).toThrow(/name =>/);
    expect(() => statement("REPORT balance.summary (label => bare)")).toThrow(/quotes/);
    expect(() => statement("REPORT balance.summary (label => 'unterminated)")).toThrow(/could not read/);
    expect(() => statement("SELECT 'unterminated")).toThrow(/could not read/);
    expect(() => statement('SELECT "unterminated')).toThrow(/could not read/);
    expect(() => statement("SELECT 1 /* unterminated")).toThrow(/could not read/);
  });

  test("quotes a name the way the editor completes it", () => {
    const format = STRIPE_SQL_GRAMMAR.completion.formatSegment;
    expect(format('say"hi')).toBe('"say""hi"');
    const read = STRIPE_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(read?.('"balance".')).toBe("balance");
    expect(read?.("balance.")).toBeUndefined();
  });
});
