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
import { XeroProvider, xeroApiHost, xeroTenantId, xeroToken } from "@/lib/db/providers/sql/xero";
import { XERO_ENTITIES, XERO_PAGE_SIZE } from "@/lib/db/providers/sql/xero/translate";
import type { DatabaseConnection } from "@/lib/types";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const connection = {
  id: "xe",
  name: "xe",
  type: "xero",
  password: "xero-token-value",
  database: TENANT,
  createdAt: new Date(0),
} as DatabaseConnection;

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: { url: string; method: string }[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: { url: string; method: string }[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method });
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

const organisation = { Organisations: [{ Name: "Northwind", OrganisationID: TENANT }] };

function invoice(number: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { InvoiceNumber: number, Total: 10, ...extra };
}

describe("XeroProvider", () => {
  test("requires a token and a pinned host, and keeps the organisation id out of construction", () => {
    expect(() => new XeroProvider(connection)).not.toThrow();
    expect(() => new XeroProvider({ ...connection, password: "census", database: "census" })).not.toThrow();
    expect(() => new XeroProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "xero-token-value\r\nX-Injected: 1";
    expect(() => new XeroProvider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      xeroToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("xero-token");
    }
    expect(() => xeroToken({ ...connection, password: "x".repeat(4090) })).toThrow(/single line/);
    expect(xeroApiHost(connection)).toBe("api.xero.com");
    expect(xeroApiHost({ ...connection, host: " https://api.xero.com/api.xro " })).toBe("api.xero.com");
    expect(xeroApiHost({ ...connection, host: "http://API.XERO.COM" })).toBe("api.xero.com");
    expect(xeroApiHost({ ...connection, host: "   " })).toBe("api.xero.com");
    expect(xeroApiHost({ ...connection, host: "api.xero.com:443" })).toBe("api.xero.com");
    expect(xeroTenantId(connection)).toBe(TENANT);
    expect(xeroTenantId({ ...connection, database: TENANT.toUpperCase() })).toBe(TENANT);
    expect(() => xeroTenantId({ ...connection, database: "census" })).toThrow(/organisation id/);
    for (const host of ["evil.example", "https://xero-token-value@evil.example", "identity.xero.com"]) {
      expect(() => new XeroProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        xeroApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("xero.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("identity.xero");
        expect(message).not.toContain("xero-token");
      }
    }
    expect(() => xeroApiHost({ ...connection, host: "files.xero.com" })).toThrow(/api\.xero\.com/);
  });

  test("probes the organisation and refuses a write before a request", async () => {
    const probe = scripted([{ body: organisation }]);
    const opened = new XeroProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://api.xero.com/api.xro/2.0/Organisation");
    expect(probe.requests[0]?.method).toBe("GET");
    expect(probe.options[0]?.origin).toEqual({ scheme: "https", host: "api.xero.com", port: 443 });
    expect(probe.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "api.xero.com" });
    expect(probe.options[0]?.refusesLinkLocal).toBe(true);
    expect(probe.options[0]?.refusesUpgrade).toBe(true);
    expect(probe.options[0]?.headers.Authorization).toBe("Bearer xero-token-value");
    expect(probe.options[0]?.headers.Accept).toBe("application/json");
    expect(probe.options[0]?.headers["Xero-Tenant-Id"]).toBe(TENANT);
    expect(await opened.listContainers()).toEqual([{ path: ["organisation"], name: "organisation", level: 0 }]);
    expect(await opened.listContainers(["organisation"])).toEqual([]);
    expect(await opened.countObjects(["organisation"])).toEqual({ table: { count: XERO_ENTITIES.length } });
    const names = (await opened.listObjects(["organisation"], "table")).map((object) => object.name);
    expect(names).toContain("Invoices");
    const detail = await opened.describeObject(["organisation", "Invoices"], "table");
    expect(detail.columns.find((column) => column.name === "InvoiceID")).toMatchObject({
      nullable: false,
      isPrimary: true,
      type: "varchar",
    });
    expect(detail.columns.find((column) => column.name === "Total")).toMatchObject({ type: "double" });
    expect(detail.columns.find((column) => column.name === "Date")).toMatchObject({ type: "date" });
    const contact = await opened.describeObject(["organisation", "Contacts"], "table");
    expect(contact.columns.find((column) => column.name === "IsCustomer")).toMatchObject({ type: "boolean" });
    const currencies = await opened.describeObject(["organisation", "Currencies"], "table");
    expect(currencies.columns[0]).toMatchObject({ name: "Code", isPrimary: true });
    expect(detail.foreignKeys).toEqual([]);
    expect((await opened.describeObjects(["organisation"], "table")).details).toHaveLength(XERO_ENTITIES.length);
    expect((await opened.describeObjects(["organisation"], "table", 1)).details).toHaveLength(1);
    await expect(opened.describeObjects(["organisation"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["organisation"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["organisation", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["organisation", "extra"], "table")).rejects.toThrow(QueryError);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({
      version: "Xero Accounting API",
      tableCount: XERO_ENTITIES.length,
    });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO Invoices (InvoiceNumber) VALUES ('INV-1')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT InvoiceNumber FROM Invoices", ["x"])).rejects.toThrow(/bind parameters/);
    const before = probe.requests.length;
    opened.config.database = "census";
    await expect(opened.query("SELECT InvoiceNumber FROM Invoices")).rejects.toThrow(/organisation id/);
    expect(probe.requests).toHaveLength(before);
    opened.config.database = OTHER;
    const moved = scripted([{ body: organisation }, { body: { Invoices: [] } }]);
    const switched = new XeroProvider({ ...connection, database: TENANT }, {}, moved.createTransport);
    await switched.connect();
    switched.config.database = OTHER;
    await switched.query("SELECT InvoiceNumber FROM Invoices");
    expect(moved.options[1]?.headers["Xero-Tenant-Id"]).toBe(OTHER);
    await opened.disconnect();
    expect(probe.closed.count).toBe(1);
    await expect(opened.query("SELECT InvoiceNumber FROM Invoices")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
  });

  test("flattens a page, pages, and counts", async () => {
    const row = JSON.parse(
      '{"InvoiceID":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","invoicenumber":"INV-1","Total":10,"Contact":{"Name":"Amy","Address":{"City":"Paris"}},"LineItems":[{"Description":"Work"}],"__proto__":"nope"}',
    ) as Record<string, unknown>;
    const page = Array.from({ length: XERO_PAGE_SIZE }, (_, index) => invoice(String(index)));
    const probe = scripted([
      { body: organisation },
      { body: { Invoices: [row, null] } },
      { body: { Invoices: [] } },
      { body: { Invoices: page, pagination: { page: 1, pageCount: 2 } } },
      { body: { Invoices: [invoice("tail")] } },
      { body: { Invoices: [], pagination: { itemCount: 42, pageCount: "many" } } },
      { body: { Accounts: [invoice("A"), invoice("B")] } },
      { body: { Accounts: [{ Code: "200", Name: "Sales" }, { Code: "400" }] } },
      { body: { Invoices: [invoice("cap")] } },
    ]);
    const opened = new XeroProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const selected = await opened.query(
      "SELECT InvoiceNumber, Reference, Total FROM Invoices WHERE Status = 'AUTHORISED' ORDER BY Date DESC LIMIT 2",
    );
    expect(selected.rows[0]).toMatchObject({ InvoiceNumber: "INV-1", Reference: null, Total: 10 });
    expect(selected.rows[1]).toEqual({ InvoiceNumber: null, Reference: null, Total: null });
    expect(JSON.stringify(selected.rows[0])).not.toContain("nope");
    expect(probe.requests[1]?.url).toContain("/Invoices?");
    expect(probe.requests[1]?.url).toContain("where=Status%3D%3D%22AUTHORISED%22");
    expect(probe.requests[1]?.url).toContain("order=Date+DESC");
    expect(probe.requests[1]?.url).toContain("page=1");
    const wide = await opened.query("SELECT * FROM Invoices LIMIT 1");
    expect(wide.fields).toContain("InvoiceID");
    expect(wide.rowCount).toBe(0);
    const paged = await opened.query("SELECT * FROM Invoices LIMIT 150");
    expect(paged.rows).toHaveLength(101);
    expect(paged.rows[0]?.InvoiceNumber).toBe("0");
    expect(probe.requests.filter((request) => request.url.includes("/Invoices"))).toHaveLength(4);
    const counted = await opened.query("SELECT COUNT(*) FROM Invoices");
    expect(counted.rows).toEqual([{ totalCount: 42 }]);
    const accounts = await opened.query("SELECT * FROM Accounts WHERE Name = 'Sales' ORDER BY Code LIMIT 1 OFFSET 1");
    expect(accounts.rows).toEqual([{ InvoiceNumber: "B", Total: 10 }]);
    expect(probe.requests.at(-1)?.url).toContain("/Accounts?");
    expect(probe.requests.at(-1)?.url).not.toContain("page=");
    const accountCount = await opened.query("SELECT COUNT(*) FROM Accounts");
    expect(accountCount.rows).toEqual([{ totalCount: 2 }]);
    const capped = await opened.query("SELECT InvoiceNumber FROM Invoices LIMIT 5000");
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toContain("1000");
    const beforePast = probe.requests.length;
    const past = await opened.query("SELECT InvoiceNumber FROM Invoices OFFSET 1000");
    expect(past.rows).toEqual([]);
    expect(past.warnings?.[0]?.message).toContain("OFFSET");
    expect(probe.requests).toHaveLength(beforePast);
  });

  test("walks a count when Xero sends no item count, and stops at the cap", async () => {
    const full = { Invoices: Array.from({ length: XERO_PAGE_SIZE }, () => invoice("A")) };
    const probe = scripted([
      { body: organisation },
      { body: { Invoices: Array.from({ length: XERO_PAGE_SIZE }, () => invoice("A")), pagination: { pageCount: 1 } } },
      { body: { ...full, pagination: { itemCount: "nope" } } },
      { body: { Invoices: [invoice("tail")], pagination: { pageCount: "many" } } },
      ...Array.from({ length: 10 }, () => ({ body: { ...full, pagination: { pageCount: 20 } } })),
    ]);
    const opened = new XeroProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const onePage = await opened.query("SELECT COUNT(*) FROM Invoices");
    expect(onePage.rows).toEqual([{ totalCount: XERO_PAGE_SIZE }]);
    expect(onePage.warnings).toEqual([]);
    const walked = await opened.query("SELECT COUNT(*) FROM Invoices");
    expect(walked.rows).toEqual([{ totalCount: XERO_PAGE_SIZE + 1 }]);
    const capped = await opened.query("SELECT COUNT(*) FROM Invoices");
    expect(capped.rows).toEqual([{ totalCount: 1000 }]);
    expect(capped.warnings?.[0]?.message).toContain("counted 1000");
  });

  test("turns a bad answer into a typed error and never repeats the token", async () => {
    const token = "xero-token-value";
    const cases: ScriptedPage[] = [
      { status: 401, body: { Detail: `expired ${token}` } },
      { status: 403, body: { Title: "forbidden" } },
      { status: 429, body: { Message: token } },
      { status: 500, text: "" },
      { status: 400, body: { Message: "" } },
      { status: 302, body: { Message: "away" } },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { text: "not-json" },
      { status: 400, text: `bad-json ${token}` },
      { body: { Invoices: { bad: true } } },
      { body: { Message: "no list" } },
      { throw: new TransportError("redirect", "moved") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${token}`) },
      { throw: new DatabaseConfigError("kept", "xero") },
      { throw: "boom" },
    ];
    const probe = scripted([{ body: organisation }, ...cases]);
    const opened = new XeroProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const run = () => opened.query("SELECT InvoiceNumber FROM Invoices");
    await expect(run()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(run()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(run()).rejects.toThrow(/limiting requests/);
    await expect(run()).rejects.toThrow(/answered 500/);
    await expect(run()).rejects.toThrow(/answered 400/);
    await expect(run()).rejects.toThrow(/redirect/);
    await expect(run()).rejects.toThrow(/2 MB/);
    await expect(run()).rejects.toThrow(/not a list/);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("bad-json");
      expect(message).not.toContain(token);
    }
    await expect(run()).rejects.toThrow(/not a list/);
    await expect(run()).rejects.toThrow(/not a list/);
    await expect(run()).rejects.toThrow(/redirect/);
    await expect(run()).rejects.toThrow(/2 MB/);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(token);
      expect(message).toContain("••••");
    }
    await expect(run()).rejects.toBeInstanceOf(DatabaseConfigError);
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toBe("Xero could not be reached.");
    }
    const failed = new XeroProvider(
      connection,
      {},
      scripted([{ status: 401, body: { Message: token } }]).createTransport,
    );
    await expect(failed.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });
});
