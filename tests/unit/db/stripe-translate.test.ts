import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { stripeListQuery, stripeObject, stripeSearchQuery } from "@/lib/db/providers/sql/stripe/objects";
import { STRIPE_SQL_GRAMMAR } from "@/lib/db/providers/sql/stripe/sql-grammar";
import { translateStripeSql } from "@/lib/db/providers/sql/stripe/translate";

function rejected(sql: string): string {
  try {
    translateStripeSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as QueryError).message;
  }
  throw new Error(`expected a refusal for ${sql}`);
}

describe("translateStripeSql", () => {
  test("reads a select, a count, and the page the limiter appends", () => {
    expect(
      translateStripeSql(
        "SELECT email, name FROM customers WHERE email = 'a@b.c' AND created > 10 ORDER BY created DESC LIMIT 50 OFFSET 2",
      ),
    ).toEqual({
      kind: "select",
      table: "customers",
      columns: ["email", "name"],
      filters: [
        { column: "email", op: "EQ", value: "a@b.c" },
        { column: "created", op: "GT", value: 10 },
      ],
      limit: 50,
      offset: 2,
    });
    expect(translateStripeSql("select * from account.Customers where active = TRUE limit 10, 20")).toMatchObject({
      table: "Customers",
      columns: null,
      filters: [{ column: "active", op: "EQ", value: true }],
      limit: 20,
      offset: 10,
    });
    expect(translateStripeSql("SELECT COUNT(*) AS total FROM customers WHERE email != 'a' LIMIT 500")).toEqual({
      kind: "count",
      table: "customers",
      filters: [{ column: "email", op: "NEQ", value: "a" }],
    });
    expect(
      translateStripeSql("SELECT * FROM customers WHERE amount >= 1 AND amount <= 2 AND amount < 3 AND amount <> 4"),
    ).toMatchObject({
      filters: [
        { op: "GTE", value: 1 },
        { op: "LTE", value: 2 },
        { op: "LT", value: 3 },
        { op: "NEQ", value: 4 },
      ],
    });
    expect(
      translateStripeSql("-- note\nSELECT * FROM \"cus\"\"tomers\" /* block */ WHERE email = 'a''b';"),
    ).toMatchObject({
      table: 'cus"tomers',
      filters: [{ value: "a'b" }],
    });
    expect(translateStripeSql("SELECT id FROM customers ORDER BY created")).toMatchObject({
      columns: ["id"],
      offset: 0,
      limit: null,
    });
  });

  test("refuses a write and the SQL the API cannot run", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["INSERT INTO customers (email) VALUES ('a')", "read-only"],
      ["UPDATE customers SET email = 'a'", "read-only"],
      ["DELETE FROM customers", "read-only"],
      ["WITH t AS (SELECT 1) SELECT * FROM t", "Start with SELECT"],
      ["SELECT DISTINCT email FROM customers", "DISTINCT"],
      ["SELECT COUNT(email) FROM customers", "COUNT(*)"],
      ["SELECT * FROM a.b.c", "at most a container"],
      ["SELECT * FROM customers WHERE email = 'a' OR name = 'b'", "AND"],
      ["SELECT * FROM customers WHERE email IS NULL", "IS NULL"],
      ["SELECT * FROM customers WHERE NOT email = 'a'", "Compare a Stripe field"],
      ["SELECT * FROM customers WHERE email LIKE 'a%'", "Compare a Stripe field"],
      ["SELECT * FROM customers WHERE email IN ('a')", "Compare a Stripe field"],
      ["SELECT * FROM customers WHERE email = NULL", "IS NULL"],
      ["SELECT * FROM customers WHERE email = customers", "text, a number"],
      ["SELECT * FROM customers ORDER BY email", "newest"],
      ["SELECT * FROM customers ORDER BY created ASC", "newest"],
      ["SELECT * FROM customers JOIN charges", "JOIN"],
      ["SELECT * FROM customers GROUP BY email", "GROUP BY"],
      ["SELECT * FROM customers UNION SELECT * FROM charges", "one SELECT"],
      ["SELECT * FROM customers; SELECT * FROM charges", "one statement"],
      ["SELECT COUNT(*) FROM customers ORDER BY created", "ORDER BY"],
      ["SELECT * FROM customers WHERE email = 1.2.3", "not readable"],
      ["SELECT * FROM customers WHERE email = @", "cannot read"],
      ["SELECT * FROM customers LIMIT -1", "whole numbers"],
      ["SELECT ", "A name is required"],
      ["SELECT * FROM customers WHERE ", "A name is required"],
      ["/* unclosed", "not closed"],
      ["SELECT * FROM customers WHERE email = 'a", "not closed"],
      ['SELECT * FROM "customers', "not closed"],
    ];
    for (const [sql, fragment] of cases) expect(rejected(sql)).toContain(fragment);
  });

  test("turns filters into the list or the search the API accepts", () => {
    const customers = stripeObject("Customers");
    expect(stripeListQuery(customers, [{ column: "email", op: "EQ", value: "a@b.c" }])).toEqual({ email: "a@b.c" });
    expect(
      stripeListQuery(customers, [
        { column: "created", op: "GTE", value: 10 },
        { column: "created", op: "LT", value: 20 },
      ]),
    ).toEqual({ "created[gte]": "10", "created[lt]": "20" });
    expect(stripeListQuery(customers, [{ column: "name", op: "EQ", value: "Ada" }])).toBeNull();
    expect(stripeSearchQuery(customers, [])).toBe("created>0");
    expect(stripeSearchQuery(customers, [{ column: "name", op: "NEQ", value: "A'o" }])).toBe("-name:'A\\'o'");
    expect(stripeSearchQuery(customers, [{ column: "created", op: "LTE", value: 5 }])).toBe("created<=5");
    expect(() => stripeSearchQuery(customers, [{ column: "created", op: "EQ", value: 5 }])).toThrow(/Filter created/);
    expect(() => stripeSearchQuery(customers, [{ column: "created", op: "GT", value: 1.5 }])).toThrow(/Unix time/);
    expect(() => stripeListQuery(customers, [{ column: "created", op: "GT", value: "today" }])).toThrow(/Unix time/);
    expect(() => stripeSearchQuery(customers, [{ column: "description", op: "EQ", value: "x" }])).toThrow(
      /cannot filter/,
    );
    expect(() => stripeSearchQuery(stripeObject("refunds"), [])).toThrow(/cannot search/);
    expect(() => stripeSearchQuery(customers, [{ column: "name", op: "GT", value: "Ada" }])).toThrow(
      /Compare a number/,
    );
    expect(() => stripeObject("nope")).toThrow(/no object/);
  });

  test("formats a completed name the way the editor inserts it", () => {
    const format = STRIPE_SQL_GRAMMAR.completion.formatSegment;
    expect(format).not.toBeNull();
    expect(format?.('a"b')).toBe('"a""b"');
    const read = STRIPE_SQL_GRAMMAR.completion.readQuotedQualifier;
    expect(read?.('"a""b".')).toBe('a"b');
    expect(read?.("customers.")).toBeUndefined();
  });
});
