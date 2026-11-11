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
import { ExcelProvider } from "@/lib/db/providers/sql/excel";
import type { DatabaseConnection } from "@/lib/types";

const DRIVE = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ITEM = "01BYE5RZitem";
const WORKBOOK = `/drives/${DRIVE}/items/${ITEM}`;
const SHEET_ID = "{00000000-0001-0000-0000-000000000000}";

const connection = {
  id: "xl",
  name: "xl",
  type: "excel",
  host: "",
  user: "11111111-1111-4111-8111-111111111111",
  database: "22222222-2222-4222-8222-222222222222",
  password: "client-secret",
  schema: WORKBOOK,
  createdAt: new Date(0),
} as DatabaseConnection;

const token = { access_token: "access-token-value", expires_in: 32_000, token_type: "Bearer" };

const sheets = {
  value: [
    { id: SHEET_ID, name: "Sheet1", visibility: "Visible" },
    { id: "hidden-sheet-id", name: "Secret", visibility: "Hidden" },
    { id: "sales-sheet-id", name: "Q1 Sales" },
  ],
};

const grid = {
  text: [
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
): { opened: ExcelProvider; wire: ReturnType<typeof scripted> } {
  const wire = scripted(pages);
  const opened =
    clock === undefined
      ? new ExcelProvider(config, {}, wire.createTransport)
      : new ExcelProvider(config, {}, wire.createTransport, clock);
  return { opened, wire };
}

describe("ExcelProvider", () => {
  test("exchanges the secret once and reads one worksheet", async () => {
    const clock = { now: () => Date.parse("2026-01-31T00:00:00Z") };
    const { opened, wire } = provider(
      [
        { body: token },
        { body: sheets },
        { body: grid },
        { body: grid },
        { body: grid },
        { body: grid },
        { body: grid },
        { body: grid },
        { body: grid },
      ],
      clock,
    );
    await expect(opened.query("SELECT * FROM sheet1")).rejects.toThrow(/Not connected/);
    await expect(opened.listContainers()).rejects.toThrow(/Not connected/);
    await opened.connect();
    await opened.connect();
    expect(wire.requests[0]?.method).toBe("POST");
    expect(wire.requests[0]?.url).toBe(
      "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/oauth2/v2.0/token",
    );
    expect(wire.requests[0]?.form).toEqual({
      grant_type: "client_credentials",
      client_id: "11111111-1111-4111-8111-111111111111",
      client_secret: "client-secret",
      scope: "https://graph.microsoft.com/.default",
    });
    expect(wire.requests[0]?.url).not.toContain("client-secret");
    expect(wire.requests[1]?.url).toContain(`/drives/${DRIVE.toLowerCase()}/items/${ITEM}/workbook/worksheets?`);
    expect(wire.requests[1]?.url).toContain("select=id");
    expect(wire.options[0]?.origin.host).toBe("login.microsoftonline.com");
    expect(wire.options[1]?.origin.host).toBe("graph.microsoft.com");
    expect(wire.options[1]?.headers.Authorization).toBe("Bearer access-token-value");
    expect(wire.options[1]?.refusesLinkLocal).toBe(true);
    expect(wire.options[1]?.refusesUpgrade).toBe(true);
    expect(await opened.listContainers()).toEqual([{ path: ["workbook"], name: "workbook", level: 0 }]);
    expect(await opened.listContainers([])).toEqual([{ path: ["workbook"], name: "workbook", level: 0 }]);
    expect(await opened.listContainers(["workbook"])).toEqual([]);
    expect(await opened.countObjects(["workbook"])).toEqual({ table: { count: 2 } });
    const tables = await opened.listObjects(["workbook"], "table");
    expect(tables.map((item) => item.name)).toEqual(["sheet1", "q1_sales"]);
    const described = await opened.describeObject(["workbook", "sheet1"], "table");
    expect(described.columns[0]).toMatchObject({ name: "name", type: "varchar", isPrimary: true, nullable: false });
    expect(described.columns[1]).toMatchObject({ name: "amount", nullable: true });
    const result = await opened.query("SELECT name, amount FROM sheet1 WHERE name = 'Ada' ORDER BY amount");
    expect(result.rows).toEqual([{ name: "Ada", amount: "12" }]);
    expect(result.fields).toEqual(["name", "amount"]);
    expect(wire.requests[3]?.url).toContain(encodeURIComponent(SHEET_ID));
    expect(wire.requests[3]?.url).toContain("range(address='A1:Z501')");
    expect(wire.requests[3]?.url).not.toContain("client-secret");
    expect((await opened.getOverview()).version).toBe("Microsoft Excel");
    expect(opened.getLabels().entityName).toBe("Worksheet");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.describeObjects(["workbook"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["workbook"], "table", 1.5)).rejects.toThrow(QueryError);
    expect((await opened.describeObjects(["workbook"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["workbook"], "table")).details).toHaveLength(2);
    expect((await opened.query("SELECT name FROM sheet1")).rows.map((row) => row.name)).toContain(null);
    await expect(opened.describeObject(["workbook", "missing"], "table")).rejects.toThrow(/no worksheet/);
    await expect(opened.listObjects(["workbook"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.query("SELECT missing FROM sheet1", [])).rejects.toThrow(/no field named missing/);
    await expect(opened.query("SELECT * FROM nope")).rejects.toThrow(/no worksheet/);
    await expect(opened.query("DELETE FROM sheet1")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT * FROM sheet1", [1])).rejects.toThrow(/does not bind/);
    await expect(opened.runMaintenance()).rejects.toThrow(/no maintenance/);
    const wide = {
      text: [Array.from({ length: 26 }, (_, index) => `c${index}`), Array.from({ length: 26 }, () => "1")],
    };
    const again = provider([{ body: token }, { body: sheets }, { body: wide }], clock);
    await again.opened.connect();
    const capped = await again.opened.query("SELECT * FROM sheet1 LIMIT 5000");
    expect(capped.warnings?.[0]?.message).toMatch(/500 rows and 26 columns/);
    expect(capped.rows).toHaveLength(1);
    const offset = await again.opened.query("SELECT name FROM sheet1 OFFSET 500");
    expect(offset.rows).toEqual([]);
    expect(offset.warnings?.[0]?.message).toMatch(/OFFSET/);
    expect(again.wire.requests).toHaveLength(3);
    await opened.disconnect();
    await expect(opened.query("SELECT * FROM sheet1")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(wire.closed.count).toBeGreaterThan(0);
  });

  test("uses a pasted token and the default clock", async () => {
    const pasted = {
      ...connection,
      user: undefined,
      database: undefined,
      password: "Bearer pasted-token-value",
    } as DatabaseConnection;
    const { opened, wire } = provider([{ body: sheets }, { body: grid }], undefined, pasted);
    await opened.connect();
    const star = await opened.query("SELECT * FROM sheet1");
    expect(star.rows).toHaveLength(3);
    expect(wire.requests[0]?.method).toBe("GET");
    expect(wire.options[0]?.headers.Authorization).toBe("Bearer pasted-token-value");
    expect(wire.requests.some((request) => request.url.includes("login.microsoftonline.com"))).toBe(false);
  });

  test("refuses a credential or a workbook path before a request", () => {
    const open = (config: Partial<DatabaseConnection>) =>
      new ExcelProvider({ ...connection, ...config } as DatabaseConnection, {}, scripted([]).createTransport);
    expect(() => open({ password: "" })).toThrow(DatabaseConfigError);
    expect(() => open({ password: "short\nsecret" })).toThrow(/single line/);
    expect(() => open({ password: "x".repeat(1025) })).toThrow(/larger than Studio/);
    expect(() => open({ user: "", database: "", password: `Bearer ${"x".repeat(8001)}` })).toThrow(
      /larger than Studio/,
    );
    expect(() => open({ user: "", database: "", password: "has space" })).toThrow(/single line/);
    expect(() => open({ user: "not-a-guid" })).toThrow(/GUIDs/);
    expect(() => open({ user: connection.user, database: "" })).toThrow(/both required/);
    expect(() => open({ schema: "" })).toThrow(/workbook path is required/i);
    expect(() => open({ schema: undefined })).toThrow(/workbook path is required/i);
    expect(() => open({ schema: "https://evil.example/drives/x" })).toThrow(/workbook path must be/i);
    expect(() => open({ schema: `${WORKBOOK}?token=secret` })).toThrow(/workbook path must be/i);
    expect(() => open({ user: undefined, database: "22222222-2222-4222-8222-222222222222" })).toThrow(/both required/);
  });

  test("refreshes an expired token and keeps a live one", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const local = { ...connection };
    const { opened, wire } = provider(
      [
        { body: { access_token: "first-token", expires_in: 0 } },
        { body: sheets },
        { body: { access_token: "second-token", expires_in: 120 } },
        { body: grid },
        { body: grid },
      ],
      clock,
      local,
    );
    await opened.connect();
    local.password = "rotated-secret";
    const first = await opened.query("SELECT * FROM sheet1");
    expect(first.rows).toHaveLength(3);
    expect(wire.requests[2]?.form?.client_secret).toBe("rotated-secret");
    now += 50_000;
    await opened.query("SELECT name FROM sheet1");
    expect(wire.requests.filter((request) => request.method === "POST")).toHaveLength(2);
    const missing = provider([{ body: { access_token: "plain-token" } }, { body: sheets }], clock);
    await missing.opened.connect();
    expect(missing.wire.options[1]?.headers.Authorization).toBe("Bearer plain-token");
  });

  test("maps token and graph failures without repeating the secret", async () => {
    const secret = "client-secret";
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
      { body: token, throw: new QueryError("keep", "excel") },
      { body: token, throw: new DatabaseConfigError("keep", "excel") },
      { body: token, throw: new AuthenticationError("keep", "excel") },
      { body: token, throw: new PermissionDeniedError("keep", "excel") },
      { body: token, throw: new ConnectionError("keep", "excel") },
    ];
    for (const page of failures) {
      const { opened } = provider([page]);
      await expect(opened.connect()).rejects.toThrow();
    }
    const graphFailures: ScriptedPage[] = [
      { status: 401, body: { error: { message: `nope ${secret} access-token-value` } } },
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
      { body: { value: "nope" } },
      { throw: new TransportError("unreachable", "late access-token-value") },
    ];
    for (const page of graphFailures) {
      const { opened } = provider([{ body: token }, page]);
      await expect(opened.connect()).rejects.toThrow();
    }
    const redacted = provider([
      { body: token },
      { status: 401, body: { error: { message: "nope client-secret access-token-value" } } },
    ]);
    await expect(redacted.opened.connect()).rejects.toThrow(/nope •••• ••••/);
    const described = provider([{ body: token }, { body: sheets }, { status: 400, body: { message: "range failed" } }]);
    await described.opened.connect();
    await expect(described.opened.describeObject(["workbook", "sheet1"], "table")).rejects.toThrow(/range failed/);
  });
});
