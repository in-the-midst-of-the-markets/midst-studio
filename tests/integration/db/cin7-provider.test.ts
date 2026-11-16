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
import { Cin7Provider, cin7AccountId, cin7ApiHost, cin7ApplicationKey } from "@/lib/db/providers/sql/cin7";
import { CIN7_RESOURCES } from "@/lib/db/providers/sql/cin7/translate";
import type { DatabaseConnection } from "@/lib/types";

const ACCOUNT = "704ef231-cd93-49c9-a201-26b4b5d0d35b";
const KEY = "cin7-application-key-value";

const connection = {
  id: "cin7",
  name: "cin7",
  type: "cin7",
  password: KEY,
  database: ACCOUNT,
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
  closed: number;
} {
  const requests: { url: string; method: string }[] = [];
  const state: { options: NodeTransportOptions[]; closed: number } = { options: [], closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options.push(options);
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
        state.closed += 1;
      },
    };
  };
  return {
    createTransport,
    requests,
    get options() {
      return state.options;
    },
    get closed() {
      return state.closed;
    },
  };
}

const me = { Company: "Northwind", Currency: "USD", TimeZone: "America/New_York" };

describe("Cin7Provider", () => {
  test("requires an application key and a pinned host, and keeps the account id out of construction", () => {
    expect(() => new Cin7Provider(connection)).not.toThrow();
    expect(() => new Cin7Provider({ ...connection, password: "secret", database: "cin7" })).not.toThrow();
    expect(() => new Cin7Provider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = `${KEY}\r\nX-Injected: 1`;
    expect(() => new Cin7Provider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      cin7ApplicationKey({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("cin7-application");
    }
    expect(() => cin7ApplicationKey({ ...connection, password: "x".repeat(4097) })).toThrow(/single line/);
    expect(cin7ApiHost(connection)).toBe("inventory.dearsystems.com");
    expect(cin7ApiHost({ ...connection, host: " https://inventory.dearsystems.com/ExternalApi/v2 " })).toBe(
      "inventory.dearsystems.com",
    );
    expect(cin7ApiHost({ ...connection, host: "http://INVENTORY.DEARSYSTEMS.COM" })).toBe("inventory.dearsystems.com");
    expect(cin7ApiHost({ ...connection, host: "   " })).toBe("inventory.dearsystems.com");
    expect(cin7AccountId(connection)).toBe(ACCOUNT);
    expect(() => cin7AccountId({ ...connection, database: "cin7" })).toThrow(/account id/);
    expect(() => cin7AccountId({ ...connection, database: "  " })).toThrow(/account id/);
    for (const host of ["evil.example", `https://${KEY}@evil.example`, "files.dearsystems.com"]) {
      expect(() => new Cin7Provider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        cin7ApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("dearsystems.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("cin7-application");
      }
    }
  });

  test("probes the account and refuses a write before a request", async () => {
    const probe = scripted([{ body: me }, { body: { Total: 0, Page: 1, Products: [] } }]);
    const opened = new Cin7Provider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://inventory.dearsystems.com/ExternalApi/v2/me");
    expect(probe.requests[0]?.method).toBe("GET");
    expect(probe.options[0]?.origin).toEqual({ scheme: "https", host: "inventory.dearsystems.com", port: 443 });
    expect(probe.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "inventory.dearsystems.com" });
    expect(probe.options[0]?.refusesLinkLocal).toBe(true);
    expect(probe.options[0]?.refusesUpgrade).toBe(true);
    expect(probe.options[0]?.headers["api-auth-accountid"]).toBe(ACCOUNT);
    expect(probe.options[0]?.headers["api-auth-applicationkey"]).toBe(KEY);
    expect(probe.options[0]?.headers.Accept).toBe("application/json");
    expect(await opened.listContainers()).toEqual([{ path: ["account"], name: "account", level: 0 }]);
    expect(await opened.listContainers(["account"])).toEqual([]);
    expect(await opened.countObjects(["account"])).toEqual({ table: { count: CIN7_RESOURCES.length } });
    const names = (await opened.listObjects(["account"], "table")).map((object) => object.name);
    expect(names).toContain("Product");
    expect(names).toContain("Stock");
    const detail = await opened.describeObject(["account", "Product"], "table");
    expect(detail.columns[0]).toMatchObject({ name: "ID", nullable: false, isPrimary: false });
    expect(detail.columns.find((column) => column.name === "SKU")).toMatchObject({ nullable: true });
    const sale = await opened.describeObject(["account", "sale"], "table");
    expect(sale.columns[0]).toMatchObject({ name: "SaleID", nullable: false });
    const account = await opened.describeObject(["account", "Account"], "table");
    expect(account.columns[0]).toMatchObject({ name: "Code", nullable: false });
    expect(detail.foreignKeys).toEqual([]);
    expect((await opened.describeObjects(["account"], "table")).details).toHaveLength(CIN7_RESOURCES.length);
    const bulk = await opened.describeObjects(["account"], "table", 1);
    expect(bulk.details).toHaveLength(1);
    await expect(opened.describeObjects(["account"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["account"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["account", "missing"], "table")).rejects.toThrow(/no table/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({
      version: "Cin7 Core External API v2",
      tableCount: CIN7_RESOURCES.length,
    });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO Product (SKU) VALUES ('A')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT SKU FROM Product", ["A"])).rejects.toThrow(/bind parameters/);
    await expect(opened.query("SELECT SKU FROM Product", [])).resolves.toBeDefined();
    const before = probe.requests.length;
    opened.config.database = "census";
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/account id/);
    expect(probe.requests).toHaveLength(before);
    opened.config.database = ACCOUNT;
    await opened.disconnect();
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(probe.closed).toBe(1);
  });

  test("flattens a page, counts Total, and warns when the page is full or capped", async () => {
    const pages = scripted([
      { body: me },
      { body: { Total: 1, Page: 1, Products: [{ ID: "1", SKU: "Bread", name: "Loaf" }] } },
      {
        body: {
          Total: 1,
          Page: 1,
          Products: [{ SKU: "Bread", PriceTiers: { PriceTier1: 4 }, Movements: ["a"], __proto__: "nope" }],
        },
      },
      { body: { Total: 0, Page: 1, Products: [null] } },
      {
        body: {
          Total: 1000,
          Page: 3,
          ProductAvailabilityList: Array.from({ length: 100 }, (_, index) => ({ SKU: `S${index}` })),
        },
      },
      { body: { Total: 2, Page: 1, Products: [{ SKU: "Bread" }] } },
      { body: { Total: 0, Page: 1, SaleList: [] } },
      { body: { Total: 1, Page: 1, Products: [{ SKU: "Bread" }] } },
    ]);
    const opened = new Cin7Provider(connection, {}, pages.createTransport);
    await opened.connect();
    const selected = await opened.query("SELECT SKU, Missing, Name FROM Product WHERE SKU = 'Bread'");
    expect(selected.fields).toEqual(["SKU", "Missing", "Name"]);
    expect(selected.rows).toEqual([{ SKU: "Bread", Missing: null, Name: "Loaf" }]);
    expect(Object.hasOwn(selected.rows[0] ?? {}, "__proto__")).toBe(false);
    expect(pages.requests[1]?.url).toContain("/ExternalApi/v2/product?");
    expect(pages.requests[1]?.url).toContain("Sku=Bread");
    expect(pages.requests[1]?.url).toContain("Page=1");
    expect(pages.requests[1]?.url).toContain("Limit=100");
    const star = await opened.query("SELECT * FROM Product");
    expect(star.fields).toContain("PriceTiers.PriceTier1");
    expect(star.rows[0]?.Movements).toBeNull();
    const blank = await opened.query("SELECT * FROM Product");
    expect(blank.fields).toEqual(["ID"]);
    expect(blank.rows).toEqual([{ ID: null }]);
    const stock = await opened.query("SELECT SKU FROM Stock LIMIT 100 OFFSET 200");
    expect(stock.warnings?.map((warning) => warning.message).join(" ")).toMatch(/this page only/);
    expect(pages.requests[4]?.url).toContain("Page=3");
    expect(pages.requests[4]?.url).toContain("Limit=100");
    const capped = await opened.query("SELECT SKU FROM Product LIMIT 5000");
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toMatch(/at most 1000/);
    expect(pages.requests[5]?.url).toContain("Limit=1000");
    const counted = await opened.query("SELECT COUNT(*) AS sales FROM Sale WHERE Status = 'ORDERED'");
    expect(counted.rows).toEqual([{ sales: 0 }]);
    expect(pages.requests[6]?.url).toContain("/saleList?");
    expect(pages.requests[6]?.url).toContain("Limit=1");
    expect(pages.requests[6]?.url).toContain("Status=ORDERED");
    opened.config.database = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const moved = await opened.query("SELECT SKU FROM Product");
    expect(moved.rows).toEqual([{ SKU: "Bread" }]);
    expect(pages.options.at(-1)?.headers["api-auth-accountid"]).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  test("reports faults, redirects, and a redacted secret", async () => {
    const secretBody = { Exception: `rejected ${KEY} for ${ACCOUNT}` };
    const cases: ScriptedPage[] = [
      { status: 401, body: secretBody },
      { status: 403, body: { ErrorMessage: `forbidden ${KEY}` } },
      { status: 400, body: { Message: "bad filter" } },
      { status: 429, body: {} },
      { status: 503, body: {} },
      { status: 302, body: {} },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { status: 500, text: `not json ${KEY}` },
      { text: "not-json" },
      { body: { Exception: "", Total: 1, Products: [] } },
      { body: { Products: [] } },
      { body: { Total: 1, Products: { SKU: "Bread" } } },
      { body: { Total: 1 } },
      { text: "[1]" },
      { body: { Exception: `boom ${KEY}` } },
      { body: { Company: "" } },
    ];
    const transport = scripted([{ body: me }, ...cases]);
    const opened = new Cin7Provider(connection, {}, transport.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/bad filter/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/answered 429/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/answered 503/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toBeInstanceOf(ConnectionError);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/2 MB/);
    try {
      await opened.query("SELECT SKU FROM Product");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(KEY);
      expect(message).toMatch(/not json/);
    }
    await expect(opened.query("SELECT * FROM Product")).rejects.toThrow(/did not return a list/);
    const blankException = await opened.query("SELECT SKU FROM Product");
    expect(blankException.rows).toEqual([]);
    await expect(opened.query("SELECT COUNT(*) FROM Product")).rejects.toThrow(/did not return a count/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/did not return a list/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/did not return a list/);
    await expect(opened.query("SELECT SKU FROM Product")).rejects.toThrow(/did not return a list/);
    try {
      await opened.query("SELECT SKU FROM Product");
      throw new Error("expected the exception body to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/boom/);
      expect(message).not.toContain(KEY);
    }

    const swapped = { ...connection, database: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    const rebuilt = new Cin7Provider(swapped, {}, transport.createTransport);
    await expect(rebuilt.connect()).rejects.toThrow(/did not return the account/);
    expect(transport.closed).toBeGreaterThan(0);
    const empty = scripted([{ text: "" }]);
    const bare = new Cin7Provider(connection, {}, empty.createTransport);
    await expect(bare.connect()).rejects.toThrow(/did not return the account/);

    const thrown = scripted([
      { throw: new TransportError("redirect", "moved") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${KEY}`) },
      { throw: new DatabaseConfigError("kept", "cin7") },
      { throw: "nope" },
    ]);
    const failing = new Cin7Provider(connection, {}, thrown.createTransport);
    await expect(failing.connect()).rejects.toThrow(/redirect/);
    await expect(failing.connect()).rejects.toThrow(/2 MB/);
    try {
      await failing.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error instanceof Error ? error.message : "").not.toContain(KEY);
    }
    await expect(failing.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(failing.connect()).rejects.toThrow(/could not be reached/);
  });
});
