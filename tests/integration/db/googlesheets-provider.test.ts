import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import { GoogleSheetsProvider } from "@/lib/db/providers/sql/googlesheets";
import type { DatabaseConnection } from "@/lib/types";

const SPREADSHEET = "1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const connection = {
  id: "gs",
  name: "gs",
  type: "googlesheets",
  password: "ya29.pasted-token-value",
  schema: SPREADSHEET,
  createdAt: new Date(0),
} as DatabaseConnection;

const token = { access_token: "ya29.access-token-value", expires_in: 32_000 };

const tabs = {
  sheets: [
    { properties: { sheetId: 1, title: "Sheet1", hidden: false } },
    { properties: { sheetId: 2, title: "Secret", hidden: true } },
    { properties: { sheetId: 3, title: "Q1's Sales" } },
  ],
};

const grid = {
  values: [
    ["Name", "Amount", ""],
    ["Ada", 12, ""],
    ["Bea", 4, ""],
    ["", "", ""],
  ],
};

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: NodeRequest[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: NodeRequest[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push(request);
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? JSON.stringify(next.body ?? {});
        return { status: next.status ?? 200, contentType: "application/json", retryAfter: null, text };
      },
      close() {
        closed.count += 1;
      },
    };
  };
  return { createTransport, requests, options, closed };
}

function provider(
  pages: ScriptedPage[],
  clock?: { now(): number },
  config: DatabaseConnection = connection,
): { opened: GoogleSheetsProvider; wire: ReturnType<typeof scripted> } {
  const wire = scripted(pages);
  const opened =
    clock === undefined
      ? new GoogleSheetsProvider(config, {}, wire.createTransport)
      : new GoogleSheetsProvider(config, {}, wire.createTransport, clock);
  return { opened, wire };
}

function account(pem: string = PEM): DatabaseConnection {
  return {
    ...connection,
    password: JSON.stringify({
      client_email: "studio@example.iam.gserviceaccount.com",
      private_key: pem,
    }),
  } as DatabaseConnection;
}

describe("GoogleSheetsProvider", () => {
  test("reads one worksheet with a pasted token", async () => {
    const { opened, wire } = provider([
      { body: tabs },
      { body: grid },
      { body: grid },
      { body: grid },
      { body: grid },
      { body: grid },
      { body: grid },
      { body: grid },
      { body: grid },
    ]);
    await expect(opened.query("SELECT * FROM sheet1")).rejects.toThrow(/Not connected/);
    await expect(opened.listContainers()).rejects.toThrow(/Not connected/);
    await opened.connect();
    await opened.connect();
    expect(wire.requests[0]?.method).toBe("GET");
    expect(wire.requests[0]?.url).toContain(`/v4/spreadsheets/${SPREADSHEET}?`);
    expect(wire.requests[0]?.url).toContain("fields=sheets.properties");
    expect(wire.options[0]?.origin.host).toBe("sheets.googleapis.com");
    expect(wire.options[0]?.headers.Authorization).toBe("Bearer ya29.pasted-token-value");
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    expect(wire.options[0]?.refusesUpgrade).toBe(true);
    expect(wire.requests.some((request) => request.url.includes("oauth2.googleapis.com"))).toBe(false);
    expect(await opened.listContainers()).toEqual([{ path: ["spreadsheet"], name: "spreadsheet", level: 0 }]);
    expect(await opened.listContainers([])).toEqual([{ path: ["spreadsheet"], name: "spreadsheet", level: 0 }]);
    expect(await opened.listContainers(["spreadsheet"])).toEqual([]);
    expect(await opened.countObjects(["spreadsheet"])).toEqual({ table: { count: 2 } });
    const tables = await opened.listObjects(["spreadsheet"], "table");
    expect(tables.map((item) => item.name)).toEqual(["sheet1", "q1_s_sales"]);
    const described = await opened.describeObject(["spreadsheet", "sheet1"], "table");
    expect(described.columns[0]).toMatchObject({ name: "name", type: "varchar", isPrimary: true, nullable: false });
    expect(described.columns[1]).toMatchObject({ name: "amount", nullable: true });
    const result = await opened.query("SELECT name, amount FROM sheet1 WHERE name = 'Ada' ORDER BY amount");
    expect(result.rows).toEqual([{ name: "Ada", amount: "12" }]);
    expect(result.fields).toEqual(["name", "amount"]);
    expect(wire.requests[2]?.url).toContain("valueRenderOption=FORMATTED_VALUE");
    expect(wire.requests[2]?.url).toContain("A1%3AZ501");
    expect(wire.requests[2]?.url).not.toContain("ya29.pasted-token-value");
    const quoted = await opened.query("SELECT name FROM q1_s_sales");
    expect(quoted.rows.map((row) => row.name)).toContain("Ada");
    expect(wire.requests[3]?.url).toContain("Q1");
    expect(wire.requests[3]?.url).toContain("%20");
    expect((await opened.getOverview()).version).toBe("Google Sheets");
    expect(opened.getLabels().entityName).toBe("Worksheet");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.describeObjects(["spreadsheet"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["spreadsheet"], "table", 1.5)).rejects.toThrow(QueryError);
    expect((await opened.describeObjects(["spreadsheet"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["spreadsheet"], "table")).details).toHaveLength(2);
    expect((await opened.query("SELECT name FROM sheet1")).rows.map((row) => row.name)).toContain(null);
    await expect(opened.describeObject(["spreadsheet", "missing"], "table")).rejects.toThrow(/no worksheet/);
    await expect(opened.listObjects(["spreadsheet"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.query("SELECT missing FROM sheet1", [])).rejects.toThrow(/no field named missing/);
    await expect(opened.query("SELECT * FROM nope")).rejects.toThrow(/no worksheet/);
    await expect(opened.query("DELETE FROM sheet1")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT * FROM sheet1", [1])).rejects.toThrow(/does not bind/);
    await expect(opened.runMaintenance()).rejects.toThrow(/no maintenance/);
    const empty = provider([{ body: tabs }, { body: {} }]);
    await empty.opened.connect();
    const blank = await empty.opened.query("SELECT * FROM sheet1");
    expect(blank.fields).toEqual(["column_1"]);
    expect(blank.rows).toEqual([]);
    await opened.disconnect();
    await expect(opened.query("SELECT * FROM sheet1")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(wire.closed.count).toBeGreaterThan(0);
  });

  test("exchanges a service-account key and refreshes it", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const local = account();
    const { opened, wire } = provider(
      [
        { body: token },
        { body: tabs },
        { body: grid },
        { body: { access_token: "ya29.second-token", expires_in: 120 } },
        { body: grid },
      ],
      clock,
      local,
    );
    await opened.connect();
    expect(wire.requests[0]?.method).toBe("POST");
    expect(wire.requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(wire.requests[0]?.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(wire.requests[0]?.url).not.toContain("PRIVATE KEY");
    expect(wire.options[0]?.origin.host).toBe("oauth2.googleapis.com");
    expect(wire.options[0]?.headers.Authorization).toBeUndefined();
    expect(wire.options[1]?.headers.Authorization).toBe("Bearer ya29.access-token-value");
    const first = await opened.query("SELECT * FROM sheet1");
    expect(first.rows).toHaveLength(3);
    local.password = account("-----BEGIN PRIVATE KEY-----\nnot-used-until-refresh\n-----END PRIVATE KEY-----").password;
    now += 32_000 * 1000 + 1;
    await expect(opened.query("SELECT name FROM sheet1")).rejects.toThrow(/private_key could not be read/);
    const kept = provider(
      [{ body: { access_token: "ya29.plain-token" } }, { body: tabs }, { body: grid }, { body: grid }],
      clock,
      account(),
    );
    await kept.opened.connect();
    await kept.opened.query("SELECT name FROM sheet1");
    expect(kept.wire.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(kept.wire.options[1]?.headers.Authorization).toBe("Bearer ya29.plain-token");
  });

  test("uses the default clock for one exchange", async () => {
    const { opened, wire } = provider([{ body: token }, { body: tabs }], undefined, account());
    await opened.connect();
    expect(wire.requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(wire.options[1]?.origin.host).toBe("sheets.googleapis.com");
  });

  test("refuses a credential or a spreadsheet id before a request", () => {
    const open = (config: Partial<DatabaseConnection>) =>
      new GoogleSheetsProvider({ ...connection, ...config } as DatabaseConnection, {}, scripted([]).createTransport);
    expect(() => open({ password: "" })).toThrow(DatabaseConfigError);
    expect(() => open({ password: "short\nsecret" })).toThrow(/single line/);
    expect(() => open({ password: "x".repeat(16_001) })).toThrow(/larger than Studio/);
    expect(() => open({ schema: "" })).toThrow(/spreadsheet id is required/i);
    expect(() => open({ schema: "https://docs.google.com/spreadsheets/d/abc" })).toThrow(/no URL/);
    const broken = account("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----");
    const refused = new GoogleSheetsProvider(broken, {}, scripted([]).createTransport);
    return expect(refused.connect()).rejects.toThrow(/private_key could not be read/);
  });

  test("maps token and spreadsheet failures without repeating the secret", async () => {
    const secret = PEM;
    const failures: ScriptedPage[] = [
      { status: 401, body: { error_description: `bad ${secret}` } },
      { body: token, text: "not-json" },
      { body: token, text: "" },
      { body: { access_token: "has space", expires_in: 100 } },
      { body: { access_token: "x".repeat(8001), expires_in: 100 } },
      { body: { error: "denied" } },
      { text: "[]" },
      { status: 500, body: { error: { code: 1 } } },
      { body: token, throw: new Error(`boom ${secret}`) },
      { status: 302, body: {} },
      { body: token, throw: new TransportError("unreachable", `down ${secret}`) },
      { body: token, throw: "down" },
      { body: token, throw: new QueryError("keep", "googlesheets") },
      { body: token, throw: new DatabaseConfigError("keep", "googlesheets") },
      { body: token, throw: new AuthenticationError("keep", "googlesheets") },
      { body: token, throw: new PermissionDeniedError("keep", "googlesheets") },
      { body: token, throw: new ConnectionError("keep", "googlesheets") },
    ];
    for (const page of failures) {
      const { opened } = provider([page], undefined, account());
      await expect(opened.connect()).rejects.toThrow();
    }
    const sheetFailures: ScriptedPage[] = [
      { status: 401, body: { error: { message: "nope ya29.pasted-token-value" } } },
      { status: 403, body: { error: { message: "", code: "forbidden" } } },
      { status: 429, body: {} },
      { status: 500, body: { error: { message: "x".repeat(400) } } },
      { status: 400, text: "" },
      { status: 400, text: "plain failure" },
      { status: 400, body: ["nope"] },
      { status: 400, body: { error: { message: "", error_description: "", error: "" } } },
      { status: 400, body: { error: { error_description: "described" } } },
      { status: 400, body: { error: "denied" } },
      { status: 302, body: {} },
      { status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { status: 200, text: "" },
      { status: 200, text: "not-json" },
      { body: { sheets: "nope" } },
      { throw: new TransportError("unreachable", "late ya29.pasted-token-value") },
      { throw: "down" },
      { throw: new QueryError("keep", "googlesheets") },
    ];
    for (const page of sheetFailures) {
      const { opened } = provider([page]);
      await expect(opened.connect()).rejects.toThrow();
    }
    const redacted = provider([{ status: 401, body: { error: { message: "nope ya29.pasted-token-value" } } }]);
    await expect(redacted.opened.connect()).rejects.toThrow(/nope ••••/);
    const described = provider([{ body: tabs }, { status: 400, body: { message: "range failed" } }]);
    await described.opened.connect();
    await expect(described.opened.describeObject(["spreadsheet", "sheet1"], "table")).rejects.toThrow(/range failed/);
    const wide = {
      values: [Array.from({ length: 26 }, (_, index) => `c${index}`), Array.from({ length: 26 }, () => "1")],
    };
    const again = provider([{ body: tabs }, { body: wide }]);
    await again.opened.connect();
    const capped = await again.opened.query("SELECT * FROM sheet1 LIMIT 5000");
    expect(capped.warnings?.[0]?.message).toMatch(/500 rows and 26 columns/);
    expect(capped.rows).toHaveLength(1);
    const offset = await again.opened.query("SELECT * FROM sheet1 OFFSET 500");
    expect(offset.rows).toEqual([]);
    expect(offset.warnings?.[0]?.message).toMatch(/OFFSET/);
    expect(again.wire.requests).toHaveLength(2);
  });
});
