import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { xeroQuery, translateXeroSql } from "@/lib/db/providers/sql/xero/translate";

const read = (sql: string) => translateXeroSql(sql);

describe("Xero SQL", () => {
  test("translates a select into a where and an order", () => {
    const statement = read(
      "SELECT InvoiceNumber, Total FROM invoices WHERE Status = 'AUTHORISED' AND Total >= 10.5 AND AmountPaid < -2 ORDER BY Date DESC LIMIT 100",
    );
    expect(statement).toMatchObject({ kind: "select", entity: "Invoices", limit: 100, offset: 0, capped: false });
    expect(xeroQuery(statement)).toEqual({
      entity: expect.objectContaining({ name: "Invoices", path: "Invoices" }),
      where: 'Status=="AUTHORISED"&&Total>=10.5&&AmountPaid<-2',
      order: "Date DESC",
    });
    const text = read("SELECT Name FROM Contacts WHERE IsCustomer = TRUE AND Name LIKE 'A''s%'");
    expect(xeroQuery(text).where).toBe('IsCustomer==true&&Name.StartsWith("A\'s")');
  });

  test("caps a page, shifts the start, and counts", () => {
    const page = read(
      "select * from Invoices where Contact.Name like '%Amy%' order by DueDate asc offset 4 limit 5000;",
    );
    expect(page).toMatchObject({ kind: "select", columns: null, limit: 1000, offset: 4, capped: true });
    expect(xeroQuery(page)).toMatchObject({
      where: 'Contact.Name.Contains("Amy")',
      order: "DueDate ASC",
    });
    const counted = read("SELECT COUNT(*) AS total FROM Contacts WHERE Name LIKE '%son'");
    expect(counted).toMatchObject({ kind: "count", entity: "Contacts" });
    expect(xeroQuery(counted)).toMatchObject({ where: 'Name.EndsWith("son")', order: null });
    expect(xeroQuery(read("SELECT Name FROM Contacts WHERE Name LIKE 'Amy'")).where).toBe('Name=="Amy"');
    const organisation = read("SELECT Name FROM Organisation");
    expect(xeroQuery(organisation).entity.responseKey).toBe("Organisations");
    expect(xeroQuery(read("SELECT Code FROM Currencies")).entity.primary).toBe("Code");
  });

  test("reads comments, quotes, dates, and a default page", () => {
    const statement = read(`
      -- note
      SELECT "Contact.Name" FROM Invoices /* page */ WHERE Date = '2024-01-15' AND InvoiceID <> 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    `);
    expect(statement).toMatchObject({ kind: "select", columns: ["Contact.Name"], limit: 100, offset: 0 });
    expect(xeroQuery(statement).where).toBe(
      'Date==DateTime(2024,1,15)&&InvoiceID!=guid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")',
    );
    expect(xeroQuery(read("SELECT InvoiceNumber FROM Invoices OFFSET 2 LIMIT 5"))).toMatchObject({
      order: null,
      where: null,
    });
    const format = SQL_GRAMMAR.xero.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.xero.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("Xero completion is missing.");
    expect(format('A"B')).toBe('"A""B"');
    expect(readQuoted('"A""B".')).toBe('A"B');
    expect(readQuoted("Invoices.")).toBeUndefined();
    expect(() => xeroQuery({ kind: "count", entity: "Missing", filters: [] })).toThrow(/no table/);
  });

  test("refuses a write, a join, a bad value, and a bad page", () => {
    const refused = (sql: string, pattern: RegExp) => expect(() => read(sql)).toThrow(pattern);
    refused("", /read-only/);
    refused("DELETE FROM Invoices", /read-only/);
    refused("SELECT DISTINCT InvoiceNumber FROM Invoices", /DISTINCT/);
    refused("SELECT InvoiceNumber FROM Invoices; SELECT Name FROM Contacts", /one statement/);
    refused("SELECT InvoiceNumber FROM Invoices JOIN Contacts", /one list/);
    refused("SELECT InvoiceNumber FROM Missing", /no table/);
    refused("SELECT Name FROM Contacts WHERE IsCustomer = true OR Name = 'A'", /AND/);
    refused("SELECT Name FROM Contacts WHERE Name OR IsCustomer = true", /filters with/);
    refused("SELECT Status FROM Invoices WHERE Status ! 1", /filters with/);
    refused("SELECT Name FROM Contacts WHERE Name IN ('A')", /no IN/);
    refused("SELECT InvoiceNumber FROM Invoices ORDER BY Date, Total", /one field/);
    refused("SELECT InvoiceNumber FROM Invoices ORDER Date", /ORDER BY/);
    refused("SELECT COUNT(*) FROM Invoices ORDER BY Date", /ORDER BY/);
    refused("SELECT COUNT(*) FROM Invoices LIMIT 1", /LIMIT or OFFSET/);
    refused("SELECT COUNT(InvoiceID) FROM Invoices", /COUNT\(\*\)/);
    refused("SELECT COUNT(* FROM Invoices", /COUNT\(\*\)/);
    refused("SELECT COUNT *) FROM Invoices", /COUNT\(\*\)/);
    refused("SELECT FROM Invoices", /FROM/);
    refused("SELECT *, InvoiceNumber FROM Invoices", /on its own/);
    refused("SELECT InvoiceNumber, * FROM Invoices", /on its own/);
    refused("SELECT InvoiceNumber FROM Invoices OFFSET no", /OFFSET/);
    refused("SELECT Name FROM Contacts WHERE Name LIKE 1", /LIKE/);
    refused("SELECT Total FROM Invoices WHERE Total LIKE '1%'", /LIKE applies/);
    refused("SELECT Name FROM Contacts WHERE Name LIKE 'A%B'", /prefix/);
    refused("SELECT Name FROM Contacts WHERE Name LIKE '%'", /percent signs/);
    refused("SELECT Name FROM Contacts WHERE Name LIKE '%%'", /percent signs/);
    refused("SELECT Name FROM Contacts WHERE Name = 'a\nb'", /one line/);
    refused("SELECT Name FROM Contacts WHERE Name = 'say \"hi\"'", /quote or a backslash/);
    refused("SELECT Name FROM Contacts WHERE Name = 'a\\b'", /quote or a backslash/);
    refused("SELECT InvoiceNumber FROM Invoices LIMIT 0", /LIMIT/);
    refused("SELECT InvoiceNumber FROM Invoices LIMIT 1.5", /LIMIT/);
    refused("SELECT InvoiceNumber FROM Invoices OFFSET 1.5", /OFFSET/);
    refused("SELECT InvoiceNumber FROM Invoices OFFSET -1", /OFFSET/);
    refused("SELECT 'not-a-name' FROM Invoices", /field name/);
    refused("SELECT InvoiceNumber FROM Invoices WHERE Status = Status", /value in quotes/);
    refused('SELECT "A""B" FROM Invoices', /punctuation/);
    refused("SELECT Missing FROM Invoices", /no field/);
    refused("SELECT InvoiceNumber FROM Invoices WHERE Missing = 1", /no field/);
    refused("SELECT InvoiceNumber FROM Invoices ORDER BY Missing", /no field/);
    refused("SELECT Date FROM Invoices WHERE Date = 1", /YYYY-MM-DD/);
    refused("SELECT Date FROM Invoices WHERE Date = '2024-13-01'", /YYYY-MM-DD/);
    refused("SELECT Date FROM Invoices WHERE Date = '2024-00-10'", /YYYY-MM-DD/);
    refused("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 'not-a-uuid'", /UUID/);
    refused("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 1", /UUID/);
    refused("SELECT Total FROM Invoices WHERE Total = '1'", /number/);
    refused("SELECT IsCustomer FROM Contacts WHERE IsCustomer = 'yes'", /true or false/);
    refused("SELECT Name FROM Contacts WHERE Name = 1", /in quotes/);
    refused("/* never", /could not read/);
    refused("SELECT 'open FROM Invoices", /could not read/);
    refused('SELECT "open FROM Invoices', /could not read/);
    refused("SELECT 1. FROM Invoices", /read-only/);
    refused(`SELECT ${"A".repeat(81)} FROM Invoices`, /punctuation/);
    refused("SELECT InvoiceNumber FROM Invoices WHERE Status !=", /value in quotes/);
    try {
      read("UPDATE Invoices SET Status = 'x'");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).provider).toBe("xero");
    }
  });
});
