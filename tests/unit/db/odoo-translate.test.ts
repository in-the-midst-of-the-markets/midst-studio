import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { odooCallBody, translateOdooSql } from "@/lib/db/providers/sql/odoo/translate";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";

const read = (sql: string) => translateOdooSql(sql);

describe("Odoo SQL", () => {
  test("translates a select into a search_read body", () => {
    const statement = read(
      "SELECT name, email FROM res.partner WHERE is_company = true AND credit >= 10.5 ORDER BY name LIMIT 100",
    );
    expect(statement).toMatchObject({
      kind: "select",
      model: "res.partner",
      columns: ["name", "email"],
      limit: 100,
      offset: 0,
      capped: false,
    });
    expect(odooCallBody(statement)).toEqual({
      domain: [
        ["is_company", "=", true],
        ["credit", ">=", 10.5],
      ],
      limit: 100,
      offset: 0,
      fields: ["name", "email"],
      order: "name asc",
    });
  });

  test("caps a page, keeps an offset, and counts with an alias", () => {
    const page = read("select * from sale.order where name in ('1', '2') order by date_order desc offset 4 limit 500;");
    expect(page).toMatchObject({ kind: "select", columns: null, limit: 200, offset: 4, capped: true });
    expect(odooCallBody(page)).toEqual({
      domain: [["name", "in", ["1", "2"]]],
      limit: 200,
      offset: 4,
      order: "date_order desc",
    });
    const counted = read("SELECT COUNT(*) AS total FROM res.partner WHERE name LIKE 'A''s'");
    expect(counted).toMatchObject({ kind: "count", alias: "total", model: "res.partner" });
    expect(odooCallBody(counted)).toEqual({ domain: [["name", "like", "A's"]] });
    const plain = read("SELECT COUNT(*) FROM res.partner");
    expect(plain).toMatchObject({ kind: "count", alias: "count", filters: [] });
    expect(odooCallBody(read("SELECT id FROM res.partner OFFSET 4"))).toMatchObject({ limit: 100, offset: 4 });
    expect(odooCallBody(read("SELECT id FROM res.partner OFFSET 4 LIMIT 10"))).toMatchObject({ limit: 10, offset: 4 });
    expect(odooCallBody(read("SELECT id FROM res.partner LIMIT 10 OFFSET 2"))).toMatchObject({ limit: 10, offset: 2 });
    expect(odooCallBody(read("SELECT id FROM res.partner LIMIT 200"))).toMatchObject({ limit: 200 });
  });

  test("reads comments, quotes, comparisons, and a default page", () => {
    const statement = read(`
      -- note
      SELECT\t"partner_id.name", id\r
      FROM res.partner /* page */ WHERE id < 3 AND id > 0 AND id <= 9 AND id != 1 AND id ILIKE 'a' AND active = false
    `);
    expect(statement).toMatchObject({
      kind: "select",
      columns: ["partner_id.name", "id"],
      limit: 100,
      filters: [
        { column: "id", op: "<", value: 3 },
        { column: "id", op: ">", value: 0 },
        { column: "id", op: "<=", value: 9 },
        { column: "id", op: "!=", value: 1 },
        { column: "id", op: "ilike", value: "a" },
        { column: "active", op: "=", value: false },
      ],
    });
    const format = SQL_GRAMMAR.odoo.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.odoo.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("Odoo completion is missing.");
    expect(format('A"B')).toBe('"A""B"');
    expect(readQuoted('"A""B".')).toBe('A"B');
    expect(readQuoted("res.partner.")).toBeUndefined();
    expect(read("SELECT id FROM res.partner ORDER BY name ASC").kind).toBe("select");
  });

  test("refuses a write, a join, a second statement, and a bad page", () => {
    const refused = (sql: string, pattern: RegExp) => expect(() => read(sql)).toThrow(pattern);
    refused("", /read-only/);
    refused("   ", /read-only/);
    refused("DELETE FROM res.partner", /read-only/);
    refused("SELECT id FROM res.partner; SELECT id FROM sale.order", /one statement/);
    refused("SELECT id FROM res.partner JOIN sale.order", /one model/);
    refused("SELECT id FROM res.partner WHERE active = true OR name = 'a'", /AND/);
    refused("SELECT id FROM res.partner WHERE active OR name = 'a'", /AND/);
    refused("SELECT id FROM res.partner WHERE name", /filters with/);
    refused("SELECT id FROM res.partner WHERE id ! 1", /filters with/);
    refused("SELECT id FROM res.partner ORDER BY name, id", /one field/);
    refused("SELECT id FROM res.partner ORDER name", /ORDER BY/);
    refused("SELECT COUNT(*) FROM res.partner ORDER BY id", /ORDER BY/);
    refused("SELECT COUNT(id) FROM res.partner", /COUNT\(\*\)/);
    refused("SELECT COUNT FROM res.partner", /COUNT\(\*\)/);
    refused("SELECT COUNT(* FROM res.partner", /COUNT\(\*\)/);
    refused("SELECT id", /FROM/);
    refused("SELECT id FROM res.partner WHERE id IN ()", /quotes/);
    refused("SELECT id FROM res.partner WHERE id IN (1,)", /quotes/);
    refused("SELECT id FROM res.partner WHERE id IN 1", /IN \(value/);
    refused("SELECT id FROM res.partner WHERE id IN (1", /IN \(value/);
    refused("SELECT id FROM res.partner OFFSET no", /OFFSET/);
    refused("SELECT COUNT(*) FROM res.partner LIMIT 1", /read-only/);
    refused("SELECT id FROM res.partner WHERE name LIKE 1", /LIKE/);
    refused("SELECT id FROM res.partner LIMIT 0", /LIMIT/);
    refused("SELECT id FROM res.partner LIMIT 1.5", /LIMIT/);
    refused("SELECT id FROM res.partner OFFSET 1.5", /OFFSET/);
    refused("SELECT 'not-a-name' FROM res.partner", /field name/);
    refused("SELECT COUNT(*) AS 1 FROM res.partner", /field name/);
    refused("SELECT id FROM res.partner WHERE id = id", /value in quotes/);
    refused('SELECT "A""B" FROM res.partner', /punctuation/);
    refused("SELECT , FROM res.partner", /field name/);
    refused("/* never", /could not read/);
    refused("SELECT 'open FROM res.partner", /could not read/);
    refused('SELECT "open FROM res.partner', /could not read/);
    refused("SELECT 1. FROM res.partner", /read-only/);
    refused("SELECT id FROM res.", /read-only/);
    refused("SELECT id FROM res.partner WHERE id = -1", /read-only/);
    refused("SELECT id FROM res.partner GROUP BY id", /read-only/);
    refused("# comment", /read-only/);
    refused(`SELECT ${"A".repeat(81)} FROM res.partner`, /punctuation/);
    expect(read("SELECT id FROM res.partner WHERE id IN (1);").kind).toBe("select");
    try {
      read("UPDATE res.partner SET name = 'x'");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
    }
  });
});
