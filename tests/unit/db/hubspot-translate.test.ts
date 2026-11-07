import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { HUBSPOT_SQL_GRAMMAR } from "@/lib/db/providers/sql/hubspot/sql-grammar";
import { hubSpotProperty, translateHubSpotSql } from "@/lib/db/providers/sql/hubspot/translate";

function rejected(sql: string): string {
  try {
    translateHubSpotSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as QueryError).message;
  }
  throw new Error(`expected a refusal for ${sql}`);
}

describe("translateHubSpotSql", () => {
  test("reads a select with filters, sorts, and a page", () => {
    expect(
      translateHubSpotSql(
        `-- note
        /* block */ SELECT "email", score FROM crm.contacts
        WHERE email = 'a''b' AND score >= 2 OR active IS NOT NULL
        ORDER BY id DESC, email ASC LIMIT 10 OFFSET 5;`,
      ),
    ).toEqual({
      kind: "select",
      table: "contacts",
      columns: ["email", "score"],
      filterGroups: [
        {
          filters: [
            { property: "email", operator: "EQ", value: "a'b" },
            { property: "score", operator: "GTE", value: "2" },
          ],
        },
        { filters: [{ property: "active", operator: "HAS_PROPERTY" }] },
      ],
      sorts: [
        { property: "hs_object_id", direction: "DESCENDING" },
        { property: "email", direction: "ASCENDING" },
      ],
      limit: 10,
      offset: 5,
    });
  });

  test("reads a star select, a count, and the MySQL limit form", () => {
    expect(translateHubSpotSql("SELECT * FROM contacts")).toMatchObject({
      kind: "select",
      columns: null,
      limit: null,
      offset: 0,
    });
    expect(translateHubSpotSql("SELECT COUNT(*) AS n FROM contacts WHERE email LIKE '%ada%'")).toEqual({
      kind: "count",
      table: "contacts",
      filterGroups: [{ filters: [{ property: "email", operator: "CONTAINS_TOKEN", value: "ada" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts LIMIT 4, 2")).toMatchObject({ limit: 2, offset: 4 });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email LIKE 'ada%'")).toMatchObject({
      filterGroups: [{ filters: [{ property: "email", operator: "CONTAINS_TOKEN", value: "ada" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email LIKE '%ada'")).toMatchObject({
      filterGroups: [{ filters: [{ property: "email", operator: "CONTAINS_TOKEN", value: "ada" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email LIKE 'ada'")).toMatchObject({
      filterGroups: [{ filters: [{ property: "email", operator: "CONTAINS_TOKEN", value: "ada" }] }],
    });
  });

  test("reads writes addressed by id", () => {
    expect(
      translateHubSpotSql("INSERT INTO contacts (email, score, active, note) VALUES ('a@b.c', -1.5, TRUE, NULL)"),
    ).toEqual({
      kind: "insert",
      table: "contacts",
      rows: [
        [
          ["email", "a@b.c"],
          ["score", -1.5],
          ["active", true],
          ["note", null],
        ],
      ],
    });
    expect(translateHubSpotSql("UPDATE contacts SET email = 'a@b.c', active = FALSE WHERE id = '12'")).toEqual({
      kind: "update",
      table: "contacts",
      recordId: "12",
      fields: [
        ["email", "a@b.c"],
        ["active", false],
      ],
    });
    expect(translateHubSpotSql("DELETE FROM contacts WHERE id = '12'")).toEqual({
      kind: "delete",
      table: "contacts",
      recordId: "12",
    });
  });

  test("maps the id column onto HubSpot's record property", () => {
    expect(hubSpotProperty("id")).toBe("hs_object_id");
    expect(hubSpotProperty("ID")).toBe("hs_object_id");
    expect(hubSpotProperty("email")).toBe("email");
  });

  test("refuses statements the CRM search cannot run", () => {
    const cases: [string, string][] = [
      ["", "Start with"],
      ["WITH x AS (SELECT 1) SELECT * FROM contacts", "Start with"],
      ["SELECT * FROM contacts; SELECT * FROM deals", "one statement"],
      ["SELECT JOIN FROM contacts", "one object"],
      ["SELECT * FROM a.b.c", "schema.object"],
      ["SELECT COUNT(email) FROM contacts", "COUNT(*)"],
      ["SELECT SUM(score) FROM contacts", "COUNT(*)"],
      ["SELECT email AS name FROM contacts", "does not rename"],
      ["SELECT email, * FROM contacts", "on its own"],
      ["SELECT * FROM contacts WHERE (email = 'a' OR score > 1)", "not inside parentheses"],
      ["SELECT * FROM contacts WHERE (email = 'a'", "not closed"],
      ["SELECT * FROM contacts WHERE NOT email = 'a'", "no NOT"],
      ["SELECT * FROM contacts WHERE email NOT LIKE 'a'", "no NOT"],
      ["SELECT * FROM contacts WHERE email LIKE 1", "quoted pattern"],
      ["SELECT * FROM contacts WHERE email LIKE 'a%b'", "prefix"],
      ["SELECT * FROM contacts WHERE email LIKE '%'", "prefix"],
      [
        "SELECT * FROM contacts WHERE email < 1 AND email > 0 AND email <= 3 AND email >= 0 AND email != 'b' AND email = 'c' AND email = 'd'",
        "at most 6",
      ],
      [
        "SELECT * FROM contacts WHERE email = 'a' OR email = 'b' OR email = 'c' OR email = 'd' OR email = 'e' OR email = 'f'",
        "at most 5",
      ],
      ["DELETE contacts", "Expected FROM"],
      ["UPDATE contacts email = 'a'", "Expected SET"],
      ["SELECT * FROM contacts WHERE email * 1", "comparison needs"],
      ["SELECT * FROM contacts WHERE email = (", "must be a string"],
      ["SELECT * FROM contacts ORDER BY", "name is required"],
      ["SELECT * FROM contacts LIMIT -1", "whole number"],
      ["SELECT * FROM contacts LIMIT 1.5", "whole number"],
      ["INSERT INTO contacts email VALUES ('a')", "column list"],
      ["INSERT INTO contacts (email VALUES ('a')", "not closed"],
      ["INSERT INTO contacts (email) VALUES 'a'", "parentheses"],
      ["INSERT INTO contacts (email) VALUES ('a', 'b')", "2 values"],
      [
        "INSERT INTO contacts (email) VALUES ('a'),('b'),('c'),('d'),('e'),('f'),('g'),('h'),('i'),('j'),('k')",
        "at most 10",
      ],
      ["INSERT INTO contacts (id) VALUES ('1')", "assigned by HubSpot"],
      ["UPDATE contacts SET email = 'a', email = 'b' WHERE id = '1'", "once"],
      ["UPDATE contacts SET id = '2' WHERE id = '1'", "cannot be changed"],
      ["UPDATE contacts SET email 'a' WHERE id = '1'", "then ="],
      ["UPDATE contacts SET email = 'a'", "WHERE id"],
      ["DELETE FROM contacts", "WHERE id"],
      ["DELETE FROM contacts WHERE email = 'a'", "WHERE id"],
      ["DELETE FROM contacts WHERE id = ''", "WHERE id"],
      ["SELECT * FROM contacts WHERE email = 'a", "not closed"],
      ['SELECT * FROM "contacts', "not closed"],
      ["SELECT * FROM contacts /*", "not closed"],
      ["SELECT * FROM contacts WHERE email = 1.2.3", "not readable"],
      ["SELECT * FROM contacts WHERE email = @", "cannot read"],
    ];
    for (const [sql, fragment] of cases) {
      const message = rejected(sql);
      if (fragment !== "") expect(message).toContain(fragment);
    }
    expect(translateHubSpotSql("SELECT COUNT(*) FROM contacts")).toMatchObject({ kind: "count", table: "contacts" });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE (email = 'a')")).toMatchObject({
      filterGroups: [{ filters: [{ operator: "EQ", value: "a" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email <> 'a'")).toMatchObject({
      filterGroups: [{ filters: [{ operator: "NEQ", value: "a" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email IS NULL")).toMatchObject({
      filterGroups: [{ filters: [{ operator: "NOT_HAS_PROPERTY" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email = NULL")).toMatchObject({
      filterGroups: [{ filters: [{ operator: "NOT_HAS_PROPERTY" }] }],
    });
    expect(translateHubSpotSql("SELECT * FROM contacts WHERE email != NULL")).toMatchObject({
      filterGroups: [{ filters: [{ operator: "HAS_PROPERTY" }] }],
    });
    expect(translateHubSpotSql('SELECT * FROM "a""b"')).toMatchObject({ table: 'a"b' });
  });

  test("formats a completed name the way the editor inserts it", () => {
    const format = HUBSPOT_SQL_GRAMMAR.completion.formatSegment;
    expect(format).not.toBeNull();
    expect(format?.('a"b')).toBe('"a""b"');
    const read = HUBSPOT_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(read?.('"a""b".')).toBe('a"b');
    expect(read?.("contacts.")).toBeUndefined();
  });
});
