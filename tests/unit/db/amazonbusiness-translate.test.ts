import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import {
  AMAZON_BUSINESS_RESOURCES,
  amazonBusinessResource,
  translateAmazonBusinessSql,
} from "@/lib/db/providers/sql/amazonbusiness/translate";

const fail = (sql: string): string => {
  try {
    translateAmazonBusinessSql(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected a refusal: ${sql}`);
};

const DAY = "WHERE StartDate = '2024-07-18T00:00:00Z' AND EndDate = '2024-07-18T23:59:59Z'";

describe("Amazon Business SQL", () => {
  test("lists the resources and the editor words are statements the translator accepts", () => {
    expect(AMAZON_BUSINESS_RESOURCES.map((entry) => entry.name)).toEqual([
      "Product",
      "Order",
      "LineItem",
      "Transaction",
    ]);
    expect(amazonBusinessResource("product")?.name).toBe("Product");
    expect(amazonBusinessResource("missing")).toBeNull();
    expect(SQL_GRAMMAR.amazonbusiness.readsSqlText).toBe(true);
    expect(SQL_GRAMMAR.amazonbusiness.grammar.formatterLanguage).toBe("mysql");
    const words = SQL_GRAMMAR.amazonbusiness.grammar.completionWords;
    if (words === undefined) throw new Error("amazonbusiness completion");
    expect(words.lists).toBe("only");
    expect(words.keywords).toEqual(["SELECT", "FROM", "WHERE", "AND", "AS", "LIMIT", "OFFSET", "COUNT"]);
    const format = SQL_GRAMMAR.amazonbusiness.completion.formatSegment;
    const readQuoted = SQL_GRAMMAR.amazonbusiness.completion.readQuotedQualifier;
    if (format === null || readQuoted === null) throw new Error("amazonbusiness completion");
    expect(format('Say "hi"')).toBe('"Say ""hi"""');
    expect(readQuoted('"Order List".')).toBe("Order List");
    expect(readQuoted('"Say ""hi""".')).toBe('Say "hi"');
    expect(readQuoted("Product.")).toBeUndefined();
    expect(SQL_GRAMMAR.amazonbusiness.completion.nameIsDottedWord).toBe(true);
    const clauses = SQL_GRAMMAR.amazonbusiness.grammar.completionClauses?.values;
    expect(clauses?.FROM?.when).toBe("any");
    expect(clauses?.FROM?.words).toContain("Order");
    expect(clauses?.SELECT?.words).toContain("ASIN");
    expect(clauses?.WHERE?.words).toContain("Keywords");
    expect(clauses?.WHERE?.words).toContain("'US'");
    for (const snippet of words.snippets ?? []) {
      const sql = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, "$1");
      const statement = translateAmazonBusinessSql(sql);
      expect(statement.kind === "list" || statement.kind === "count").toBe(true);
    }
  });

  test("translates a product search, one ASIN, a day of orders, lines and transactions", () => {
    const search = translateAmazonBusinessSql(
      "SELECT ASIN, Title FROM Product WHERE keywords = 'paper' AND ProductRegion = 'US' LIMIT 24 OFFSET 24 -- fresh\n/* note */",
    );
    expect(search).toMatchObject({
      kind: "list",
      columns: ["ASIN", "Title"],
      limit: 24,
      offset: 24,
      capped: false,
      filters: [
        { name: "Keywords", param: "keywords", value: "paper" },
        { name: "ProductRegion", param: "productRegion", value: "US" },
      ],
    });
    expect(translateAmazonBusinessSql("SELECT * FROM Product WHERE ASIN = 'B06XC9321S'")).toMatchObject({
      kind: "list",
      columns: null,
      resource: { name: "Product" },
    });
    expect(translateAmazonBusinessSql(`SELECT OrderId FROM "Order" ${DAY}`)).toMatchObject({
      resource: { name: "Order" },
      limit: 100,
    });
    expect(translateAmazonBusinessSql(`SELECT ASIN FROM LineItem ${DAY} LIMIT 50`)).toMatchObject({
      resource: { name: "LineItem" },
      limit: 50,
    });
    const transactions = translateAmazonBusinessSql(
      "SELECT * FROM Transaction WHERE FeedStartDate = '2024-07-01T00:00:00Z' AND FeedEndDate = '2024-07-31T23:59:59Z' LIMIT 500 OFFSET 100;",
    );
    expect(transactions).toMatchObject({ kind: "list", limit: 100, offset: 100, capped: true });
    expect(translateAmazonBusinessSql("SELECT COUNT(*) AS total FROM Product WHERE Keywords = 'paper'")).toMatchObject({
      kind: "count",
      alias: "total",
    });
    expect(
      translateAmazonBusinessSql("SELECT COUNT(*) AS \"row count\" FROM Product WHERE Keywords = 'paper'"),
    ).toMatchObject({
      alias: "row count",
    });
    expect(translateAmazonBusinessSql("SELECT COUNT(*) FROM Product WHERE Keywords = 'paper'")).toMatchObject({
      alias: "totalCount",
    });
  });

  test("refuses writes, the wrong shape, and a date window the API will not take", () => {
    expect(fail("")).toMatch(/SELECT/);
    expect(fail("INSERT INTO Product (ASIN) VALUES ('A')")).toMatch(/read-only/);
    expect(fail("UPDATE Product SET Title = 'A'")).toMatch(/read-only/);
    expect(fail("DELETE FROM Product")).toMatch(/read-only/);
    expect(fail("DROP TABLE Product")).toMatch(/read-only/);
    expect(fail("SHOW TABLES")).toMatch(/SELECT/);
    expect(fail("SELECT COUNT(1) FROM Product")).toMatch(/COUNT\(\*\)/);
    expect(fail("SELECT COUNT(*) AS FROM Product")).toMatch(/name after AS/);
    expect(fail("SELECT COUNT(*) AS WHERE FROM Product")).toMatch(/name after AS/);
    expect(fail("SELECT FROM Product")).toMatch(/column name/);
    expect(fail("SELECT , FROM Product")).toMatch(/column name/);
    expect(fail("SELECT ASIN")).toMatch(/FROM/);
    expect(fail("SELECT ASIN FROM")).toMatch(/FROM/);
    expect(fail("SELECT ASIN FROM Missing WHERE Keywords = 'paper'")).toMatch(/no table/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' OR ASIN = 'B'")).toMatch(/AND/);
    expect(fail("SELECT ASIN FROM Product WHERE LIKE Keywords = 'paper'")).toMatch(/filters with =/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords > 'paper'")).toMatch(/filters with =/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = paper")).toMatch(/quoted value/);
    expect(fail("SELECT ASIN FROM Product WHERE Missing = 'paper'")).toMatch(/cannot filter/);
    expect(fail("SELECT ASIN FROM Product")).toMatch(/needs Keywords/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' AND ASIN = 'B'")).toMatch(/Keywords or/);
    expect(fail('SELECT OrderId FROM "Order"')).toMatch(/StartDate and EndDate/);
    expect(fail(`SELECT OrderId FROM "Order" WHERE StartDate = 'yesterday' AND EndDate = 'today'`)).toMatch(/instants/);
    expect(
      fail(`SELECT OrderId FROM "Order" WHERE StartDate = '2024-07-19T00:00:00Z' AND EndDate = '2024-07-18T00:00:00Z'`),
    ).toMatch(/24 hours/);
    expect(
      fail(`SELECT OrderId FROM "Order" WHERE StartDate = '2024-07-18T00:00:00Z' AND EndDate = '2024-07-19T00:00:01Z'`),
    ).toMatch(/24 hours/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' ORDER BY Title")).toMatch(/does not sort/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' JOIN Sale")).toMatch(/one table/);
    expect(fail("SELECT ASIN FROM Product.Extra WHERE Keywords = 'paper'")).toMatch(/one table/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' GROUP BY ASIN")).toMatch(/one table/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' UNION SELECT ASIN FROM Product")).toMatch(
      /one table/,
    );
    expect(fail('SELECT COUNT(*) FROM "Order" ' + DAY)).toMatch(/no total/);
    expect(fail("SELECT COUNT(*) FROM Product WHERE Keywords = 'paper' LIMIT 1")).toMatch(/does not take LIMIT/);
    expect(fail("SELECT COUNT(*) FROM Product WHERE Keywords = 'paper' OFFSET 1")).toMatch(/does not take OFFSET/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' LIMIT 0")).toMatch(/positive whole number/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' LIMIT 1.5")).toMatch(/whole number/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' LIMIT 10 OFFSET 5")).toMatch(/multiple of LIMIT/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' LIMIT 24 OFFSET 312")).toMatch(/13 pages/);
    expect(fail(`SELECT OrderId FROM "Order" ${DAY} OFFSET 50`)).toMatch(/multiple of 100/);
    expect(fail(`SELECT OrderId FROM "Order" ${DAY} OFFSET 1000`)).toMatch(/at most 900/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper'; SELECT ASIN FROM Product")).toMatch(
      /one statement/,
    );
    expect(translateAmazonBusinessSql("SELECT ASIN FROM Product WHERE Keywords = 'a''b'")).toMatchObject({
      filters: [{ value: "a'b" }],
    });
    expect(translateAmazonBusinessSql('SELECT "A""B" FROM Product WHERE Keywords = \'paper\'')).toMatchObject({
      columns: ['A"B'],
    });
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'open")).toMatch(/not closed/);
    expect(fail('SELECT ASIN FROM "open')).toMatch(/not closed/);
    expect(fail("SELECT ASIN FROM Product /* open")).toMatch(/not closed/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = ?")).toMatch(/bind parameters/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = $1")).toMatch(/bind parameters/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 'paper' @")).toMatch(/could not read/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 1.")).toMatch(/could not read that number/);
    expect(fail("SELECT ASIN FROM Product WHERE Keywords = 1.2.3")).toMatch(/could not read that number/);
    expect(
      translateAmazonBusinessSql("SELECT ASIN FROM Product WHERE Keywords = 12 AND Locale = true LIMIT 500"),
    ).toMatchObject({
      capped: true,
      limit: 24,
      filters: [
        { name: "Keywords", value: "12" },
        { name: "Locale", value: "true" },
      ],
    });
  });
});
