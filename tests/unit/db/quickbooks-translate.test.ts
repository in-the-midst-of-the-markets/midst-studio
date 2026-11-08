import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { quickbooksQueryText, translateQuickBooksSql } from "@/lib/db/providers/sql/quickbooks/translate";

const read = (sql: string) => translateQuickBooksSql(sql);

describe("QuickBooks Online SQL", () => {
  test("translates a select into the query spelling", () => {
    const statement = read(
      "SELECT DisplayName, Balance FROM customer WHERE Active = true AND Balance >= 10.5 ORDER BY DisplayName LIMIT 100",
    );
    expect(statement).toMatchObject({ kind: "select", entity: "Customer", limit: 100, offset: 0, capped: false });
    expect(quickbooksQueryText(statement)).toBe(
      "SELECT DisplayName, Balance FROM Customer WHERE Active = true AND Balance >= 10.5 ORDERBY DisplayName ASC STARTPOSITION 1 MAXRESULTS 100",
    );
  });

  test("caps a page, shifts the start, and counts", () => {
    const page = read("select * from Invoice where DocNumber in ('1', '2') order by TxnDate desc offset 4 limit 5000;");
    expect(page).toMatchObject({ kind: "select", columns: null, limit: 1000, offset: 4, capped: true });
    expect(quickbooksQueryText(page)).toContain("ORDERBY TxnDate DESC STARTPOSITION 5 MAXRESULTS 1000");
    const counted = read("SELECT COUNT(*) AS total FROM Vendor WHERE DisplayName LIKE 'A''s'");
    expect(counted).toMatchObject({ kind: "count", entity: "Vendor" });
    expect(quickbooksQueryText(counted)).toBe("SELECT COUNT(*) FROM Vendor WHERE DisplayName LIKE 'A\\'s'");
    expect(quickbooksQueryText(read("SELECT Id FROM Item WHERE Name LIKE 'a\\b'"))).toContain("LIKE 'a\\\\b'");
  });

  test("reads comments, quotes, and a default page", () => {
    const statement = read(`
      -- note
      SELECT "CustomerRef.value" FROM Invoice /* page */ WHERE Id < 3
    `);
    expect(statement).toMatchObject({ kind: "select", columns: ["CustomerRef.value"], limit: 100 });
    const format = SQL_GRAMMAR.quickbooks.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.quickbooks.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("QuickBooks Online completion is missing.");
    expect(format('A"B')).toBe('"A""B"');
    expect(readQuoted('"A""B".')).toBe('A"B');
    expect(readQuoted("Customer.")).toBeUndefined();
  });

  test("refuses a write, a join, a parameter shape, and a bad page", () => {
    const refused = (sql: string, pattern: RegExp) => expect(() => read(sql)).toThrow(pattern);
    refused("", /read-only/);
    refused("DELETE FROM Customer", /read-only/);
    refused("SELECT Id FROM Customer; SELECT Id FROM Vendor", /one statement/);
    refused("SELECT Id FROM Customer JOIN Vendor", /one entity/);
    refused("SELECT Id FROM Missing", /no table/);
    refused("SELECT Id FROM Customer WHERE Active = true OR Balance > 1", /AND/);
    refused("SELECT Id FROM Customer WHERE Active OR Balance > 1", /filters with/);
    refused("SELECT Id FROM Customer ORDER BY DisplayName, Id", /one field/);
    refused("SELECT Id FROM Customer ORDER DisplayName", /ORDER BY/);
    refused("SELECT COUNT(*) FROM Customer ORDER BY Id", /ORDER BY/);
    refused("SELECT COUNT(Id) FROM Customer", /COUNT\(\*\)/);
    refused("SELECT COUNT(* FROM Customer", /COUNT\(\*\)/);
    refused("SELECT FROM Customer", /FROM/);
    refused("SELECT Id FROM Customer WHERE Id IN ()", /quotes/);
    refused("SELECT Id FROM Customer WHERE Id IN 1", /IN \(value/);
    refused("SELECT Id FROM Customer OFFSET no", /OFFSET/);
    refused("SELECT COUNT(*) FROM Customer LIMIT 1", /read-only/);
    refused("SELECT Id FROM Customer WHERE DisplayName LIKE 1", /LIKE/);
    refused("SELECT Id FROM Customer WHERE Id = 'a\nb'", /one line/);
    refused("SELECT Id FROM Customer LIMIT 0", /LIMIT/);
    refused("SELECT Id FROM Customer LIMIT 1.5", /LIMIT/);
    refused("SELECT Id FROM Customer OFFSET 1.5", /OFFSET/);
    refused("SELECT 'not-a-name' FROM Customer", /field name/);
    refused("SELECT Id FROM Customer WHERE Id = Id", /value in quotes/);
    refused('SELECT "A""B" FROM Customer', /punctuation/);
    refused("SELECT Id FROM Customer WHERE Id != 1", /filters with/);
    expect(read("SELECT CustomerRef.value FROM Invoice").kind).toBe("select");
    refused("/* never", /could not read/);
    refused("SELECT 'open FROM Customer", /could not read/);
    refused('SELECT "open FROM Customer', /could not read/);
    refused("SELECT 1. FROM Customer", /read-only/);
    refused(`SELECT ${"A".repeat(81)} FROM Customer`, /punctuation/);
    try {
      read("UPDATE Customer SET DisplayName = 'x'");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
    }
  });
});
