import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { intercomQuery, translateIntercomSql } from "@/lib/db/providers/sql/intercom/translate";

const read = (sql: string) => translateIntercomSql(sql);

describe("Intercom SQL", () => {
  test("translates a select into filters and an order", () => {
    const statement = read(
      "SELECT email, name FROM contacts WHERE role = 'user' AND owner_id >= 10.5 AND owner_id < -2 ORDER BY name DESC LIMIT 100",
    );
    expect(statement).toMatchObject({
      kind: "select",
      entity: "Contacts",
      columns: ["email", "name"],
      limit: 100,
      offset: 0,
      capped: false,
      orderBy: { column: "name", desc: true },
    });
    expect(intercomQuery(statement).name).toBe("Contacts");
    expect(statement.kind === "select" ? statement.filters : []).toEqual([
      { field: "role", operator: "=", value: "user" },
      { field: "owner_id", operator: ">=", value: 10.5 },
      { field: "owner_id", operator: "<", value: -2 },
    ]);
    const text = read("SELECT name FROM Contacts WHERE unsubscribed_from_emails = TRUE AND name LIKE 'A''s%'");
    expect(text.kind === "select" ? text.filters : []).toEqual([
      { field: "unsubscribed_from_emails", operator: "=", value: true },
      { field: "name", operator: "^", value: "A's" },
    ]);
  });

  test("caps a page, shifts the start, and counts", () => {
    const page = read(
      "select * from Conversations where source.type like '%email%' order by state asc offset 4 limit 5000;",
    );
    expect(page).toMatchObject({ kind: "select", columns: null, limit: 1000, offset: 4, capped: true });
    expect(page.kind === "select" ? page.filters : []).toEqual([
      { field: "source.type", operator: "~", value: "email" },
    ]);
    expect(page.kind === "select" ? page.orderBy : null).toEqual({ column: "state", desc: false });
    const counted = read("SELECT COUNT(*) AS total FROM Contacts WHERE email LIKE '%son'");
    expect(counted).toMatchObject({ kind: "count", entity: "Contacts" });
    expect(counted.kind === "count" ? counted.filters : []).toEqual([{ field: "email", operator: "$", value: "son" }]);
    const exact = read("SELECT name FROM Tags WHERE name LIKE 'Amy'");
    expect(exact.kind === "select" ? exact.filters : []).toEqual([{ field: "name", operator: "=", value: "Amy" }]);
    expect(intercomQuery(read("SELECT name FROM Admins")).responseKey).toBe("admins");
    expect(intercomQuery(read("SELECT id FROM Teams")).primary).toBe("id");
    const dated = read("SELECT created_at FROM Contacts WHERE created_at = '2024-01-15'");
    expect(dated.kind === "select" ? dated.filters[0] : null).toEqual({
      field: "created_at",
      operator: "=",
      value: Math.floor(Date.UTC(2024, 0, 15) / 1000),
    });
    const numbered = read("SELECT created_at FROM Contacts WHERE created_at = 10");
    expect(numbered.kind === "select" ? numbered.filters[0]?.value : null).toBe(10);
  });

  test("reads comments, quotes, and a default page", () => {
    const statement = read(`
      -- note
      SELECT "source.type" FROM Conversations /* page */ WHERE id <> '1' AND read = false
    `);
    expect(statement).toMatchObject({ kind: "select", columns: ["source.type"], limit: 100, offset: 0 });
    expect(statement.kind === "select" ? statement.filters : []).toEqual([
      { field: "id", operator: "!=", value: "1" },
      { field: "read", operator: "=", value: false },
    ]);
    expect(read("SELECT name FROM Tags OFFSET 2 LIMIT 5")).toMatchObject({ limit: 5, offset: 2, orderBy: null });
    const ordered = read("SELECT name FROM Tags ORDER BY name LIMIT 5");
    expect(ordered.kind === "select" ? ordered.orderBy : null).toEqual({ column: "name", desc: false });
    const format = SQL_GRAMMAR.intercom.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.intercom.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("Intercom completion is missing.");
    expect(format('A"B')).toBe('"A""B"');
    expect(readQuoted('"A""B".')).toBe('A"B');
    expect(readQuoted("Contacts.")).toBeUndefined();
    expect(() => read('SELECT "A""B" FROM Tags')).toThrow(/punctuation/);
    expect(() => intercomQuery({ kind: "count", entity: "Missing", filters: [] })).toThrow(QueryError);
  });

  test("refuses a write, a join, a bad value, and a bad page", () => {
    const refused = (sql: string, pattern: RegExp) => expect(() => read(sql)).toThrow(pattern);
    refused("", /read-only/);
    refused("   ", /read-only/);
    refused("DELETE FROM Contacts", /read-only/);
    refused("SELECT DISTINCT email FROM Contacts", /DISTINCT/);
    refused("SELECT email FROM Contacts; SELECT name FROM Tags", /one statement/);
    refused("SELECT email FROM Contacts JOIN Tags", /one list/);
    refused("SELECT email FROM Missing", /no table/);
    refused("SELECT name FROM Tags WHERE name = 'A' OR name = 'B'", /AND/);
    refused("SELECT name FROM Tags WHERE name OR type = 'user'", /AND/);
    refused("SELECT email FROM Contacts WHERE email ! 1", /filters with/);
    refused("SELECT name FROM Tags WHERE name IN ('A')", /no IN/);
    refused("SELECT name FROM Tags ORDER BY name, id", /one field/);
    refused("SELECT name FROM Tags ORDER name", /ORDER BY/);
    refused("SELECT COUNT(*) FROM Tags ORDER BY name", /ORDER BY/);
    refused("SELECT COUNT(*) FROM Tags LIMIT 1", /LIMIT or OFFSET/);
    refused("SELECT COUNT(*) FROM Tags OFFSET 1", /LIMIT or OFFSET/);
    refused("SELECT COUNT(id) FROM Tags", /COUNT\(\*\)/);
    refused("SELECT COUNT(* FROM Tags", /COUNT\(\*\)/);
    refused("SELECT COUNT(*) AS total FROM Tags extra", /read-only/);
    refused("SELECT email, * FROM Contacts", /on its own/);
    refused("SELECT *, email FROM Contacts", /on its own/);
    refused("SELECT , email FROM Contacts", /field name/);
    refused("SELECT email Contacts", /FROM/);
    refused("SELECT email FROM Contacts WHERE", /field name/);
    refused("SELECT nope FROM Tags", /no field/);
    refused("SELECT name FROM Tags WHERE missing = 'A'", /no field/);
    refused("SELECT name FROM Tags WHERE name = 'a\nb'", /one line/);
    refused("SELECT name FROM Tags WHERE name LIKE '%a\nb%'", /one line/);
    refused("SELECT name FROM Tags WHERE name LIKE '%%'", /percent signs/);
    refused("SELECT name FROM Tags WHERE name LIKE '%a%b%'", /prefix/);
    refused("SELECT owner_id FROM Contacts WHERE owner_id LIKE '1%'", /text field/);
    refused("SELECT name FROM Tags WHERE name LIKE 1", /quoted value/);
    refused("SELECT created_at FROM Contacts WHERE created_at = 'yesterday'", /YYYY-MM-DD/);
    refused("SELECT created_at FROM Contacts WHERE created_at = '2024-13-01'", /YYYY-MM-DD/);
    refused("SELECT created_at FROM Contacts WHERE created_at = '2024-00-01'", /YYYY-MM-DD/);
    refused("SELECT created_at FROM Contacts WHERE created_at = '2024-01-00'", /YYYY-MM-DD/);
    refused("SELECT created_at FROM Contacts WHERE created_at = true", /YYYY-MM-DD/);
    refused("SELECT owner_id FROM Contacts WHERE owner_id = '1'", /number/);
    refused("SELECT open FROM Conversations WHERE open = 1", /true or false/);
    refused("SELECT email FROM Contacts WHERE email = 1", /quotes/);
    refused("SELECT email FROM Contacts WHERE email = true", /quotes/);
    refused("SELECT email FROM Contacts WHERE email = (", /quotes, as a number/);
    refused("SELECT name FROM Tags LIMIT 0", /greater than zero/);
    refused("SELECT name FROM Tags LIMIT 1.5", /greater than zero/);
    refused("SELECT name FROM Tags LIMIT -1", /greater than zero/);
    refused("SELECT name FROM Tags OFFSET -1", /whole number/);
    refused("SELECT name FROM Tags OFFSET 1.5", /whole number/);
    refused("SELECT 'unterminated FROM Tags", /could not read/);
    refused('SELECT "unterminated FROM Tags', /could not read/);
    refused("SELECT name FROM Tags /*", /could not read/);
    refused("SELECT name FROM Tags WHERE name = @", /read-only/);
    refused("SELECT 1name FROM Tags", /field name/);
  });
});
