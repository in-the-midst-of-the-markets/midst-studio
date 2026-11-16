import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { SalesforceProvider, salesforceApiHost, type SalesforceFetch } from "@/lib/db/providers/sql/salesforce";
import { SALESFORCE_SQL_GRAMMAR } from "@/lib/db/providers/sql/salesforce/sql-grammar";
import { translateSalesforceSql } from "@/lib/db/providers/sql/salesforce/translate";
import type { DatabaseConnection } from "@/lib/types";

const TOKEN = "00D-census-token-value";

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "sf",
    name: "sf",
    host: "acme.my.salesforce.com",
    password: TOKEN,
    ...overrides,
    type: "salesforce",
    createdAt: overrides.createdAt ?? new Date("2026-11-15T00:00:00.000Z"),
  };
}

interface Scripted {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: Scripted[]): { fetchImpl: SalesforceFetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl: SalesforceFetch = async (url, init) => {
    requests.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const next = pages.shift();
    if (next === undefined) throw new Error(`no response for ${url}`);
    if ("throw" in next && next.throw !== undefined) throw next.throw;
    return new Response(next.text ?? JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { fetchImpl, requests };
}

const describeBody = {
  fields: [
    { name: "Id", type: "id" },
    { name: "Name", type: "string" },
    { name: "AnnualRevenue", type: "currency" },
    { name: "IsDeleted", type: "boolean" },
    { name: "CloseDate", type: "date" },
    { name: "Employees", type: "int" },
    { name: "Score", type: "double" },
    { name: "Rate", type: "percent" },
    { name: "Opened", type: "datetime" },
    { name: "Alarm", type: "time" },
    { name: "1bad", type: "string" },
  ],
};

const record = {
  attributes: { type: "Account", url: "/x" },
  Id: "001",
  Name: "Acme",
  AnnualRevenue: 12,
  IsDeleted: false,
  CloseDate: null,
  Nest: { city: "A" },
};

describe("SalesforceProvider", () => {
  test("requires a My Domain and an access token, and pins the host", () => {
    expect(() => new SalesforceProvider(connection({ host: "" }))).toThrow(DatabaseConfigError);
    expect(() => new SalesforceProvider(connection({ host: "localhost" }))).toThrow(DatabaseConfigError);
    expect(() => new SalesforceProvider(connection({ host: "https://user:pass@acme.my.salesforce.com" }))).toThrow(
      DatabaseConfigError,
    );
    expect(() => new SalesforceProvider(connection({ password: "  " }))).toThrow(DatabaseConfigError);
    expect(salesforceApiHost(connection({ host: "https://acme.my.salesforce.com/home" }))).toBe(
      "acme.my.salesforce.com",
    );
    expect(SALESFORCE_SQL_GRAMMAR.completion.formatSegment?.('A"B')).toBe('"A""B"');
    expect(SALESFORCE_SQL_GRAMMAR.completion.readQuotedQualifier?.('"A""B".')).toBe('A"B');
  });

  test("probes the versions resource once and reads a filtered select", async () => {
    const wire = scripted([
      { body: { version: "59.0" } },
      { body: { done: true, records: [record] } },
    ]);
    const engine = new SalesforceProvider(connection(), {}, wire.fetchImpl);
    await engine.connect();
    await engine.connect();
    const result = await engine.query(
      "SELECT Name, AnnualRevenue FROM Account WHERE Name = 'O''Brien' AND AnnualRevenue >= 10 ORDER BY Name DESC, AnnualRevenue ASC LIMIT 10 OFFSET 5 -- note\n/* kept */",
    );
    expect(result.rows).toEqual([
      { Name: "Acme", AnnualRevenue: 12 },
    ]);
    expect(result.fields).toEqual(["Name", "AnnualRevenue"]);
    expect(wire.requests[0]).toBe("https://acme.my.salesforce.com/services/data/v59.0/");
    expect(wire.requests[1]).toContain("/query?q=");
    expect(decodeURIComponent(wire.requests[1].split("q=")[1] ?? "")).toBe(
      "SELECT Name, AnnualRevenue FROM Account WHERE Name = 'O''Brien' AND AnnualRevenue >= 10 ORDER BY Name DESC, AnnualRevenue ASC LIMIT 10 OFFSET 5",
    );
    expect(wire.requests[1]).not.toContain(TOKEN);
    await engine.disconnect();
    await expect(engine.query("SELECT Name FROM Account")).rejects.toThrow(NOT);
  });

  test("expands a star from describe, caches it, and follows a same-host page", async () => {
    const wire = scripted([
      { body: {} },
      { body: describeBody },
      {
        body: {
          done: false,
          nextRecordsUrl: "/services/data/v59.0/query/next",
          records: [{ Id: "001", Name: { note: "x".repeat(5000) } }],
        },
      },
      { body: { done: true, records: [{ Id: "002", Name: "Beta" }] } },
    ]);
    const engine = new SalesforceProvider(connection(), {}, wire.fetchImpl);
    await engine.connect();
    const result = await engine.query("SELECT * FROM Account");
    expect(result.fields[0]).toBe("Id");
    expect(result.fields).toContain("Name");
    expect(result.rows).toHaveLength(2);
    expect(String(result.rows[0]?.Name).length).toBe(4000);
    expect(wire.requests.filter((url) => url.includes("/describe"))).toHaveLength(1);
    const detail = await engine.describeObject(["org", "Account"], "table");
    expect(detail.columns.find((column) => column.name === "Id")).toMatchObject({ isPrimary: true, nullable: false });
    expect(detail.columns.find((column) => column.name === "AnnualRevenue")?.type).toBe("numeric");
    expect(detail.columns.find((column) => column.name === "IsDeleted")?.type).toBe("boolean");
    expect(detail.columns.find((column) => column.name === "CloseDate")?.type).toBe("timestamp");
    expect(detail.columns.find((column) => column.name === "Opened")?.type).toBe("timestamp");
    expect(detail.columns.some((column) => column.name === "1bad")).toBe(false);
    expect(wire.requests.filter((url) => url.includes("/describe"))).toHaveLength(1);
  });

  test("counts, warns when a further page is left, and refuses a foreign page", async () => {
    const counted = scripted([
      { body: {} },
      { body: { done: true, records: [{ expr0: 4 }] } },
    ]);
    const engine = new SalesforceProvider(connection(), {}, counted.fetchImpl);
    await engine.connect();
    expect(await engine.query("SELECT COUNT(*) AS row_count FROM Account WHERE IsDeleted = FALSE OR Name IS NULL")).toMatchObject({
      rows: [{ row_count: 4 }],
      fields: ["row_count"],
    });
    expect(decodeURIComponent(counted.requests[1].split("q=")[1] ?? "")).toContain("SELECT COUNT() FROM Account WHERE");

    const warned = scripted([
      { body: {} },
      { body: describeBody },
      { body: { done: false, nextRecordsUrl: "https://elsewhere.example/services/data/v59.0/query/next", records: [record] } },
    ]);
    const foreign = new SalesforceProvider(connection(), {}, warned.fetchImpl);
    await foreign.connect();
    await expect(foreign.query("SELECT * FROM Account")).rejects.toThrow(/different host/);

    const relative = scripted([
      { body: {} },
      {
        body: {
          done: false,
          nextRecordsUrl: "https://acme.my.salesforce.com/services/data/v59.0/query/same",
          records: [{ Id: "001", Name: "Acme" }],
        },
      },
      { body: { done: true, records: [] } },
    ]);
    const same = new SalesforceProvider(connection(), {}, relative.fetchImpl);
    await same.connect();
    const page = await same.query('SELECT Id FROM "Account" WHERE Name LIKE \'A%\' AND Name IS NOT NULL');
    expect(page.rows).toEqual([{ Id: "001" }]);
    expect(relative.requests[2]).toContain("/query/same");
  });

  test("maps auth and transport failures without echoing the token", async () => {
    const denied = scripted([{ status: 401, body: [{ message: `bad ${TOKEN}` }] }]);
    const engine = new SalesforceProvider(connection(), {}, denied.fetchImpl);
    await expect(engine.connect()).rejects.toThrow(/••••/);

    const forbidden = scripted([{ status: 403, body: { error_description: "no" } }]);
    await expect(new SalesforceProvider(connection(), {}, forbidden.fetchImpl).connect()).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    const down = scripted([{ status: 500, body: { message: "down" } }]);
    await expect(new SalesforceProvider(connection(), {}, down.fetchImpl).connect()).rejects.toThrow(/down/);

    const bare = scripted([{ status: 500, body: ["nope"] }]);
    await expect(new SalesforceProvider(connection(), {}, bare.fetchImpl).connect()).rejects.toThrow(/answered 500/);

    const blank = scripted([{ status: 400, body: { other: true } }]);
    await expect(new SalesforceProvider(connection(), {}, blank.fetchImpl).connect()).rejects.toThrow(/answered 400/);

    const html = scripted([{ text: "<html>" }]);
    await expect(new SalesforceProvider(connection(), {}, html.fetchImpl).connect()).rejects.toThrow(/did not return JSON/);

    const redirected = scripted([{ status: 302, text: "" }]);
    await expect(new SalesforceProvider(connection(), {}, redirected.fetchImpl).connect()).rejects.toBeInstanceOf(
      ConnectionError,
    );

    const thrown = scripted([{ throw: new Error(`socket ${TOKEN}`) }]);
    await expect(new SalesforceProvider(connection(), {}, thrown.fetchImpl).connect()).rejects.toThrow(/••••/);

    const blown = scripted([{ throw: "down" }]);
    await expect(new SalesforceProvider(connection(), {}, blown.fetchImpl).connect()).rejects.toThrow(
      /could not be reached/,
    );
  });

  test("refuses a statement outside the subset before a request", async () => {
    const wire = scripted([{ body: {} }]);
    const engine = new SalesforceProvider(connection(), {}, wire.fetchImpl);
    await engine.connect();
    await expect(engine.query("SELECT Name FROM Account", ["x"])).rejects.toThrow(/parameters/);
    await expect(engine.query("INSERT INTO Account (Name) VALUES ('A')")).rejects.toThrow(/reads/);
    await expect(engine.query("SELECT Name FROM Account JOIN Contact")).rejects.toThrow(/one object/);
    await expect(engine.query("SELECT Name AS label FROM Account")).rejects.toThrow(/rename/);
    await expect(engine.query("SELECT COUNT(*) FROM Account LIMIT 1")).rejects.toThrow(/does not take/);
    await expect(engine.query("SELECT Name FROM Account WHERE Name = 'A' OR Name = 'B' AND Name = 'C'")).rejects.toThrow(
      /either AND or OR/,
    );
    await expect(engine.query("SELECT Name FROM Account LIMIT 0")).rejects.toThrow(/LIMIT/);
    await expect(engine.query("SELECT Name FROM Account OFFSET 2001")).rejects.toThrow(/OFFSET/);
    await expect(engine.query("SELECT Name FROM Account WHERE Name = 'open")).rejects.toThrow(/not closed/);
    await expect(engine.query("SELECT /*")).rejects.toThrow(/not closed/);
    await expect(engine.query("SELECT Name FROM Account WHERE Name = 'a\nb'")).rejects.toThrow(/span a line/);
    await expect(engine.query("SELECT 1name FROM Account")).rejects.toThrow(/field name/);
    await expect(engine.query('SELECT "A""B" FROM Account')).rejects.toThrow(/field name/);
    await expect(engine.query("SELECT Name FROM Account;")).rejects.toThrow(/character/);
    expect(translateSalesforceSql("SELECT Name FROM Account WHERE Name = NULL")).toMatchObject({
      where: "Name = null",
    });
    await expect(engine.query("SELECT Name FROM Account WHERE Name = Other")).rejects.toThrow(/string, a number/);
    await expect(engine.query("SELECT Name FROM Account WHERE Name (")).rejects.toThrow(/Compare a field/);
    expect(wire.requests).toHaveLength(1);
    expect(translateSalesforceSql("SELECT Name FROM Account WHERE Name != 'A'").kind).toBe("select");
  });

  test("lists the standard objects and describes one page", async () => {
    const fields = scripted([
      { body: {} },
      { body: describeBody },
      { body: describeBody },
      { body: describeBody },
      { body: describeBody },
      { body: describeBody },
    ]);
    const engine = new SalesforceProvider(connection(), {}, fields.fetchImpl);
    await engine.connect();
    expect(await engine.listContainers(["org"])).toEqual([]);
    expect(await engine.listContainers()).toEqual([{ path: ["org"], name: "org", level: 0 }]);
    expect(await engine.countObjects(["org"])).toEqual({ table: { count: 5 } });
    const listed = await engine.listObjects(["org"], "table");
    expect(listed.map((object) => object.name)).toEqual(["Account", "Contact", "Lead", "Opportunity", "Case"]);
    const batch = await engine.describeObjects(["org"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated?.limit).toBe(1);
    const whole = await engine.describeObjects(["org"], "table");
    expect(whole.details).toHaveLength(5);
    await expect(engine.describeObjects(["org"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(engine.listObjects(["org"], "view")).rejects.toThrow(/no object kind/);
    await expect(engine.describeObject(["org", "nope!"], "table")).rejects.toThrow(/no object/);
    expect(engine.getLabels().entityName).toBe("Object");
    expect((await engine.getOverview()).tableCount).toBe(5);
    await expect(engine.runMaintenance()).rejects.toThrow(/maintenance/);
    expect(await engine.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await engine.getPerformanceMetrics()).toEqual({});
    expect(await engine.getSlowQueries()).toEqual([]);
    expect(await engine.getActiveSessions()).toEqual([]);
    expect(await engine.getTableStats()).toEqual([]);
    expect(await engine.getIndexStats()).toEqual([]);
    expect(await engine.getStorageStats()).toEqual([]);
  });

  test("refuses a count with no number and a describe with no fields", async () => {
    const empty = scripted([
      { body: {} },
      { body: { done: true, records: [{ expr0: "none" }] } },
    ]);
    const engine = new SalesforceProvider(connection(), {}, empty.fetchImpl);
    await engine.connect();
    await expect(engine.query("SELECT COUNT(*) FROM Account")).rejects.toThrow(/did not return a count/);

    const missing = scripted([{ body: {} }, { body: { fields: [] } }]);
    const other = new SalesforceProvider(connection(), {}, missing.fetchImpl);
    await other.connect();
    await expect(other.query("SELECT * FROM Account")).rejects.toThrow(/did not return object fields/);

    const warned = scripted([
      { body: {} },
      { body: { done: false, nextRecordsUrl: "/services/data/v59.0/query/more", records: [{ Name: "Acme" }] } },
    ]);
    const paging = new SalesforceProvider(connection(), {}, warned.fetchImpl);
    await paging.connect();
    const limited = await paging.query("SELECT Name FROM Account LIMIT 1");
    expect(limited.warnings?.[0]?.message).toContain("first page");

    const odd = scripted([
      { body: {} },
      { body: { done: false, nextRecordsUrl: "%%%", records: [{ Name: "Acme" }] } },
    ]);
    const badLink = new SalesforceProvider(connection(), {}, odd.fetchImpl);
    await badLink.connect();
    await expect(badLink.query("SELECT Name FROM Account")).rejects.toThrow(/different host/);

    const shapeless = scripted([{ body: {} }, { body: { fields: "no" } }]);
    const noShape = new SalesforceProvider(connection(), {}, shapeless.fetchImpl);
    await noShape.connect();
    await expect(noShape.query("SELECT * FROM Account")).rejects.toThrow(/did not return object fields/);

    const none = scripted([{ body: {} }, { body: { done: true, records: [] } }]);
    const noCount = new SalesforceProvider(connection(), {}, none.fetchImpl);
    await noCount.connect();
    await expect(noCount.query("SELECT COUNT(*) FROM Account")).rejects.toThrow(/did not return a count/);

    const broken = scripted([{ body: {} }, { body: { done: true } }]);
    const third = new SalesforceProvider(connection(), {}, broken.fetchImpl);
    await third.connect();
    await expect(third.query("SELECT Name FROM Account")).rejects.toThrow(/did not return records/);
  });
});

const NOT = /Not connected/;
