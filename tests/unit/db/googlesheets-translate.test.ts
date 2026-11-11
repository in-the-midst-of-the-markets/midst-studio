import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import {
  readSheetsTokenGrant,
  sheetsCredential,
  sheetsSpreadsheetId,
  sheetsTokenForm,
} from "@/lib/db/providers/sql/googlesheets/auth";
import { GOOGLESHEETS_SQL_GRAMMAR } from "@/lib/db/providers/sql/googlesheets/sql-grammar";
import {
  sheetsColumns,
  sheetsGrid,
  sheetsKey,
  sheetsRows,
  sheetsTabs,
  translateSheetsSql,
} from "@/lib/db/providers/sql/googlesheets/translate";
import type { DatabaseConnection } from "@/lib/types";

const ID = "1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function config(password: string, schema: string = ID): DatabaseConnection {
  return { id: "gs", name: "gs", type: "googlesheets", password, schema, createdAt: new Date(0) } as DatabaseConnection;
}

describe("Google Sheets SQL", () => {
  test("reads one worksheet and keeps the words the editor offers", () => {
    const statement = translateSheetsSql(
      "SELECT Name, amount FROM Sheet1 WHERE name = 'Ada' AND amount LIKE '%1%' ORDER BY name DESC LIMIT 5 OFFSET 1",
    );
    expect(statement.resource.name).toBe("sheet1");
    expect(statement.columns).toEqual(["name", "amount"]);
    expect(statement.filters.map((filter) => filter.field)).toEqual(["name", "amount"]);
    expect(statement.orderBy).toEqual({ column: "name", desc: true });
    expect(statement.limit).toBe(5);
    expect(statement.offset).toBe(1);
    expect(translateSheetsSql("SELECT * FROM sheet1").columns).toBeNull();
    expect(GOOGLESHEETS_SQL_GRAMMAR.readsSqlText).toBe(true);
    const words = GOOGLESHEETS_SQL_GRAMMAR.grammar.completionWords;
    if (words == null) throw new Error("completion words are set");
    expect(words.lists).toBe("only");
    const formatSegment = GOOGLESHEETS_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = GOOGLESHEETS_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (formatSegment == null || readQuoted == null) throw new Error("completion helpers are set");
    expect(formatSegment('say "hi"')).toBe('"say ""hi"""');
    expect(readQuoted('"Q1 Sales".')).toBe("Q1 Sales");
    expect(readQuoted("sheet1.")).toBeUndefined();
    expect(() => translateSheetsSql("DELETE FROM sheet1")).toThrow(/read-only/);
    expect(() => translateSheetsSql("SELECT COUNT(*) FROM sheet1")).toThrow(/COUNT/);
    expect(() => translateSheetsSql("")).toThrow(QueryError);
  });

  test("folds worksheet names and header cells into one word", () => {
    const used = new Set<string>();
    const first = sheetsKey("Sheet1", 1, used, "sheet");
    used.add(first);
    expect(first).toBe("sheet1");
    expect(sheetsKey("sheet1", 2, used, "sheet")).toBe("sheet1_2");
    expect(sheetsKey("Q1 Sales", 3, used, "sheet")).toBe("q1_sales");
    expect(sheetsKey("2024", 4, used, "sheet")).toBe("sheet4");
    expect(sheetsKey("   ", 5, used, "sheet")).toBe("sheet5");
    expect(sheetsKey("a".repeat(80), 6, used, "sheet")).toHaveLength(60);
    const long = "b".repeat(60);
    const taken = new Set([long]);
    expect(sheetsKey(long, 1, taken, "sheet")).toBe(`${"b".repeat(58)}_2`);
    expect(sheetsColumns(["Name", "", "Amount", "   "]).map((column) => column.name)).toEqual([
      "name",
      "column_2",
      "amount",
    ]);
    expect(sheetsColumns(["2024"]).map((column) => column.name)).toEqual(["column_1"]);
    expect(sheetsColumns([null, 4]).map((column) => column.name)).toEqual(["column_1", "column_2"]);
    expect(sheetsColumns([]).map((column) => column.name)).toEqual(["column_1"]);
    expect(sheetsColumns(Array.from({ length: 30 }, (_, index) => `c${index}`))).toHaveLength(26);
  });

  test("reads the worksheet list and one text grid", () => {
    const tabs = sheetsTabs({
      sheets: [
        { properties: { sheetId: 0, title: "Sheet1", hidden: false } },
        { properties: { sheetId: 2, title: "Secret", hidden: true } },
        { properties: { sheetId: 3, title: "Q1's Sales" } },
      ],
    });
    expect(tabs).toEqual([
      { key: "sheet1", title: "Sheet1", id: "0" },
      { key: "q1_s_sales", title: "Q1's Sales", id: "3" },
    ]);
    const many = Array.from({ length: 21 }, (_, index) => ({
      properties: { sheetId: index, title: `Tab${index}` },
    }));
    expect(sheetsTabs({ sheets: many })).toHaveLength(20);
    expect(() => sheetsTabs({ sheets: "nope" })).toThrow(QueryError);
    expect(() => sheetsTabs([])).toThrow(QueryError);
    expect(() => sheetsTabs({ sheets: ["nope"] })).toThrow(QueryError);
    expect(() => sheetsTabs({ sheets: [{ properties: "nope" }] })).toThrow(QueryError);
    expect(() => sheetsTabs({ sheets: [{ properties: { sheetId: 1.5, title: "Sheet1" } }] })).toThrow(QueryError);
    expect(() => sheetsTabs({ sheets: [{ properties: { sheetId: 1, title: 1 } }] })).toThrow(QueryError);

    const grid = sheetsGrid({
      values: [
        ["Name", "Amount", ""],
        ["Ada", 12, ""],
        ["Bea", true, { nested: true }],
        ["", null, ""],
      ],
    });
    expect(grid.columns.map((column) => column.name)).toEqual(["name", "amount"]);
    expect(grid.entries[0]).toEqual({ name: "Ada", amount: "12" });
    expect(grid.entries[1]).toEqual({ name: "Bea", amount: "true" });
    expect(grid.entries[2]).toEqual({ name: null, amount: null });
    expect(grid.more).toBe(false);
    expect(sheetsGrid({}).columns.map((column) => column.name)).toEqual(["column_1"]);
    expect(
      sheetsGrid({
        values: [
          ["Name", "Extra"],
          ["Ada", { nested: true }],
        ],
      }).entries[0],
    ).toEqual({ name: "Ada", extra: null });

    const wide = sheetsGrid({ values: [Array.from({ length: 26 }, () => "h"), ["x"]] });
    expect(wide.more).toBe(true);
    expect(wide.columns).toHaveLength(26);
    const deep = sheetsGrid({ values: [["h"], ...Array.from({ length: 500 }, () => ["x"])] });
    expect(deep.entries).toHaveLength(500);
    expect(deep.more).toBe(true);
    expect(() => sheetsGrid("nope")).toThrow(QueryError);
    expect(() => sheetsGrid({ values: [] })).toThrow(QueryError);
    expect(() => sheetsGrid({ values: ["nope"] })).toThrow(QueryError);
    expect(() => sheetsGrid({ values: [["h"], "nope"] })).toThrow(QueryError);

    const statement = translateSheetsSql("SELECT name FROM sheet1 WHERE name = 'Ada' ORDER BY name");
    expect(sheetsRows(statement, grid.columns, grid.entries, "SELECT name FROM sheet1")).toEqual([
      { name: "Ada", amount: "12" },
    ]);
    expect(() => sheetsRows(statement, [{ name: "other", type: "text", json: "other" }], [], "SELECT")).toThrow(
      /no field named name/,
    );
    const filtered = translateSheetsSql("SELECT * FROM sheet1 WHERE missing = 'x'");
    expect(() => sheetsRows(filtered, grid.columns, grid.entries, "SELECT")).toThrow(/missing/);
    const ordered = translateSheetsSql("SELECT * FROM sheet1 ORDER BY missing");
    expect(() => sheetsRows(ordered, grid.columns, grid.entries, "SELECT")).toThrow(/missing/);
    const star = translateSheetsSql("SELECT * FROM sheet1");
    expect(sheetsRows(star, [], [], "SELECT * FROM sheet1")).toEqual([]);
  });

  test("accepts a token or a service-account key, and a spreadsheet id", async () => {
    expect(sheetsCredential(config("Bearer ya29.token-value"))).toEqual({
      kind: "access_token",
      token: "ya29.token-value",
    });
    expect(() => sheetsCredential(config(""))).toThrow(/required/);
    expect(() => sheetsCredential(config("x".repeat(16_001)))).toThrow(/larger than Studio/);
    expect(() => sheetsCredential(config("token\nmore"))).toThrow(/single line/);
    expect(() => sheetsCredential(config("has space"))).toThrow(/single line/);
    expect(() => sheetsCredential(config("x".repeat(8001)))).toThrow(/larger than Studio/);
    expect(() => sheetsCredential(config("{"))).toThrow(/client_email/);
    expect(() =>
      sheetsCredential(config(JSON.stringify({ client_email: 1, private_key: "BEGIN PRIVATE KEY" }))),
    ).toThrow(/client_email/);
    expect(() =>
      sheetsCredential(config(JSON.stringify({ client_email: "not-an-email", private_key: "BEGIN PRIVATE KEY" }))),
    ).toThrow(/client_email/);
    expect(() =>
      sheetsCredential(
        config(JSON.stringify({ client_email: `${"a".repeat(250)}@b.co`, private_key: "BEGIN PRIVATE KEY" })),
      ),
    ).toThrow(/client_email/);
    expect(() => sheetsCredential(config(JSON.stringify({ client_email: "a@b.co", private_key: "no" })))).toThrow(
      /client_email/,
    );
    const account = sheetsCredential(
      config(
        JSON.stringify({ client_email: "studio@example.iam.gserviceaccount.com", private_key: "BEGIN PRIVATE KEY" }),
      ),
    );
    expect(account.kind).toBe("service_account");
    expect(sheetsSpreadsheetId(config("token", ID))).toBe(ID);
    expect(() => sheetsSpreadsheetId(config("token", ""))).toThrow(/spreadsheet id is required/i);
    expect(() => sheetsSpreadsheetId({ ...config("token"), schema: undefined })).toThrow(/required/i);
    expect(() => sheetsSpreadsheetId(config("token", "https://docs.google.com/spreadsheets/d/abc"))).toThrow(/no URL/);
    expect(() => sheetsSpreadsheetId(config("token", `${ID}?token=secret`))).toThrow(/no URL/);
    const message = (() => {
      try {
        sheetsSpreadsheetId(config("token", "short"));
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();
    expect(message).not.toContain("short");

    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const signed = sheetsCredential(
      config(JSON.stringify({ client_email: "studio@example.iam.gserviceaccount.com", private_key: pem })),
    );
    if (signed.kind !== "service_account") throw new Error("service account");
    const form = await sheetsTokenForm(signed, Date.parse("2026-01-31T00:00:00Z"));
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.assertion?.split(".").length).toBe(3);
    await expect(
      sheetsTokenForm({ ...signed, privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" }, 0),
    ).rejects.toThrow(AuthenticationError);

    const grant = readSheetsTokenGrant(200, JSON.stringify({ access_token: "ya29.ok", expires_in: 120 }), 1_000, []);
    expect(grant).toEqual({ token: "ya29.ok", expiresAt: 1_000 + 120_000 });
    expect(readSheetsTokenGrant(200, JSON.stringify({ access_token: "ya29.ok" }), 1_000, []).expiresAt).toBe(
      1_000 + 3_600_000,
    );
    expect(
      readSheetsTokenGrant(200, JSON.stringify({ access_token: "ya29.ok", expires_in: 0 }), 1_000, []).expiresAt,
    ).toBe(1_000 + 3_600_000);
    const secret = "private-key-value";
    expect(() =>
      readSheetsTokenGrant(401, JSON.stringify({ error_description: `bad ${secret}` }), 0, [secret]),
    ).toThrow(/bad ••••/);
    expect(() => readSheetsTokenGrant(500, JSON.stringify({ error: { code: 1 } }), 0, [])).toThrow(/HTTP 500/);
    expect(() => readSheetsTokenGrant(400, "", 0, [])).toThrow(/HTTP 400/);
    expect(() => readSheetsTokenGrant(400, "not-json", 0, [])).toThrow(/HTTP 400/);
    expect(() => readSheetsTokenGrant(400, JSON.stringify({ error_description: "x".repeat(400) }), 0, [])).toThrow(
      /token request failed/,
    );
    expect(() => readSheetsTokenGrant(200, JSON.stringify({ access_token: "has space" }), 0, [])).toThrow(/HTTP 200/);
    expect(() => readSheetsTokenGrant(200, JSON.stringify({ access_token: "x".repeat(8001) }), 0, [])).toThrow(
      /HTTP 200/,
    );
    expect(() => readSheetsTokenGrant(200, "[]", 0, [])).toThrow(/HTTP 200/);
  });
});
