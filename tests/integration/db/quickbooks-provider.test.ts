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
import {
  QuickBooksProvider,
  quickbooksApiHost,
  quickbooksCompanyId,
  quickbooksToken,
} from "@/lib/db/providers/sql/quickbooks";
import { QUICKBOOKS_ENTITIES } from "@/lib/db/providers/sql/quickbooks/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "qb",
  name: "qb",
  type: "quickbooks",
  password: "quickbooks-token-value",
  database: "9341450000000001",
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
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
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

const customer = {
  QueryResponse: {
    Customer: [
      {
        Id: "1",
        DisplayName: "Amy",
        Balance: 10,
        PrimaryEmailAddr: { Address: "amy@example.com" },
        Notes: ["a"],
        __proto__: "nope",
      },
    ],
    startPosition: 1,
    maxResults: 100,
  },
};

describe("QuickBooksProvider", () => {
  test("requires a token and a pinned host, and keeps the company id out of construction", () => {
    expect(() => new QuickBooksProvider(connection)).not.toThrow();
    expect(() => new QuickBooksProvider({ ...connection, password: "census", database: "census" })).not.toThrow();
    expect(() => new QuickBooksProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "quickbooks-token-value\r\nX-Injected: 1";
    expect(() => new QuickBooksProvider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      quickbooksToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("quickbooks-token");
    }
    expect(() => quickbooksToken({ ...connection, password: "x".repeat(4090) })).toThrow(/single line/);
    expect(quickbooksApiHost(connection)).toBe("quickbooks.api.intuit.com");
    expect(quickbooksApiHost({ ...connection, host: " https://quickbooks.api.intuit.com/v3 " })).toBe(
      "quickbooks.api.intuit.com",
    );
    expect(quickbooksApiHost({ ...connection, host: "http://QUICKBOOKS.API.INTUIT.COM" })).toBe(
      "quickbooks.api.intuit.com",
    );
    expect(quickbooksApiHost({ ...connection, host: "   " })).toBe("quickbooks.api.intuit.com");
    expect(quickbooksApiHost({ ...connection, host: "sandbox-quickbooks.api.intuit.com" })).toBe(
      "sandbox-quickbooks.api.intuit.com",
    );
    expect(quickbooksCompanyId(connection)).toBe("9341450000000001");
    expect(() => quickbooksCompanyId({ ...connection, database: "census" })).toThrow(/company id/);
    for (const host of ["evil.example", "https://quickbooks-token-value@evil.example", "oauth.platform.intuit.com"]) {
      expect(() => new QuickBooksProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        quickbooksApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("intuit.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("oauth.platform");
        expect(message).not.toContain("quickbooks-token");
      }
    }
    expect(() => quickbooksApiHost({ ...connection, host: "files.intuit.com" })).toThrow(
      /quickbooks\.api\.intuit\.com or sandbox-quickbooks\.api\.intuit\.com/,
    );
  });

  test("probes the company and refuses a write before a request", async () => {
    const probe = scripted([{ body: { QueryResponse: { CompanyInfo: [{ Id: "1" }] } } }]);
    const opened = new QuickBooksProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toContain("https://quickbooks.api.intuit.com/v3/company/9341450000000001/query?");
    expect(probe.requests[0]?.url).toContain("minorversion=75");
    expect(probe.requests[0]?.url).toContain("SELECT+Id+FROM+CompanyInfo+MAXRESULTS+1");
    expect(probe.requests[0]?.method).toBe("GET");
    expect(probe.options?.origin).toEqual({ scheme: "https", host: "quickbooks.api.intuit.com", port: 443 });
    expect(probe.options?.tls).toEqual({ rejectUnauthorized: true, identity: "quickbooks.api.intuit.com" });
    expect(probe.options?.refusesLinkLocal).toBe(true);
    expect(probe.options?.refusesUpgrade).toBe(true);
    expect(probe.options?.headers.Authorization).toBe("Bearer quickbooks-token-value");
    expect(probe.options?.headers.Accept).toBe("application/json");
    expect(await opened.listContainers()).toEqual([{ path: ["company"], name: "company", level: 0 }]);
    expect(await opened.listContainers(["company"])).toEqual([]);
    expect(await opened.countObjects(["company"])).toEqual({ table: { count: QUICKBOOKS_ENTITIES.length } });
    const names = (await opened.listObjects(["company"], "table")).map((object) => object.name);
    expect(names).toContain("Customer");
    const detail = await opened.describeObject(["company", "Customer"], "table");
    expect(detail.columns[0]).toMatchObject({ name: "Id", nullable: false, isPrimary: false });
    expect(detail.foreignKeys).toEqual([]);
    expect((await opened.describeObjects(["company"], "table")).details).toHaveLength(QUICKBOOKS_ENTITIES.length);
    const bulk = await opened.describeObjects(["company"], "table", 1);
    expect(bulk.details).toHaveLength(1);
    await expect(opened.describeObjects(["company"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["company"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["company", "missing"], "table")).rejects.toThrow(/no table/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({
      version: "QuickBooks Online Query API",
      tableCount: QUICKBOOKS_ENTITIES.length,
    });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO Customer (DisplayName) VALUES ('Amy')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT Id FROM Customer", ["x"])).rejects.toThrow(/bind parameters/);
    const before = probe.requests.length;
    const companyId = opened.config.database;
    opened.config.database = "census";
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/company id/);
    expect(probe.requests).toHaveLength(before);
    opened.config.database = companyId;
    await opened.disconnect();
    expect(probe.closed).toBe(1);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
  });

  test("flattens a page, counts, and warns when the page is full", async () => {
    const full = {
      QueryResponse: { Customer: Array.from({ length: 100 }, (_, index) => ({ Id: String(index), displayname: "A" })) },
    };
    const probe = scripted([
      { body: { QueryResponse: { CompanyInfo: [{ Id: "1" }] } } },
      { body: customer },
      { body: customer },
      { body: { QueryResponse: { totalCount: 4 } } },
      { body: full },
      { body: { QueryResponse: {} } },
      { body: { QueryResponse: { Customer: [{ Id: "2" }] } } },
    ]);
    const opened = new QuickBooksProvider(
      { ...connection, host: "http://quickbooks.api.intuit.com" },
      {},
      probe.createTransport,
    );
    await opened.connect();
    const selected = await opened.query("SELECT DisplayName, Missing FROM Customer");
    expect(selected.rows).toEqual([{ DisplayName: "Amy", Missing: null }]);
    expect(selected.fields).toEqual(["DisplayName", "Missing"]);
    expect(Object.hasOwn(selected.rows[0] ?? {}, "__proto__")).toBe(false);
    const star = await opened.query("SELECT * FROM Customer");
    expect(star.rows[0]).toMatchObject({ "PrimaryEmailAddr.Address": "amy@example.com", Notes: null });
    const counted = await opened.query("SELECT COUNT(*) FROM Customer");
    expect(counted.rows).toEqual([{ totalCount: 4 }]);
    const page = await opened.query("SELECT Id FROM Customer");
    expect(page.warnings?.map((warning) => warning.message).join(" ")).toContain("this page only");
    const empty = await opened.query("SELECT * FROM Customer");
    expect(empty.fields).toEqual(["Id"]);
    const one = await opened.query("SELECT Id FROM Customer LIMIT 2000 OFFSET 20");
    expect(one.warnings?.map((warning) => warning.message).join(" ")).toContain("at most 1000");
    expect(probe.requests.at(-1)?.url).toContain("STARTPOSITION+21");
    expect(probe.requests.at(-1)?.url).toContain("MAXRESULTS+1000");
    await opened.disconnect();
  });

  test("maps faults, redirects, and a secret in a transport error", async () => {
    const secret = "quickbooks-token-value";
    const probe = scripted([
      { status: 401, body: { message: "" } },
      { body: { QueryResponse: { CompanyInfo: [{ Id: "1" }] } } },
      { status: 403, body: { Fault: { Error: [{ Detail: "no access" }] } } },
      { status: 400, body: {} },
      { status: 429, body: { message: `rejected ${secret}` } },
      { status: 302, text: "" },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { status: 500, text: "not json" },
      { text: "not json" },
      { body: { Fault: { Error: [{}] } } },
      { body: { fault: {} } },
      { body: { QueryResponse: { totalCount: "4" } } },
      { body: { QueryResponse: { Customer: { Id: "1" } } } },
      { body: {} },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `dial failed for ${secret}`) },
      { throw: new DatabaseConfigError("kept", "quickbooks") },
      { throw: "down" },
    ]);
    const opened = new QuickBooksProvider(
      { ...connection, host: "sandbox-quickbooks.api.intuit.com" },
      {},
      probe.createTransport,
    );
    await expect(opened.connect()).rejects.toThrow(AuthenticationError);
    expect(probe.closed).toBe(1);
    expect(probe.requests[0]?.url).toContain("https://sandbox-quickbooks.api.intuit.com/");
    await opened.connect();
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/answered 400/);
    try {
      await opened.query("SELECT Id FROM Customer");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(secret);
    }
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/redirect/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/2 MB/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/not json/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/did not return a query/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/rejected the query/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/rejected the query/);
    await expect(opened.query("SELECT COUNT(*) FROM Customer")).rejects.toThrow(/did not return a count/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/did not return a query/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/did not return a query/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/redirect/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/2 MB/);
    try {
      await opened.query("SELECT Id FROM Customer");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/kept/);
    await expect(opened.query("SELECT Id FROM Customer")).rejects.toThrow(/could not be reached/);
    const missed = scripted([]);
    await expect(
      new QuickBooksProvider({ ...connection, database: "" }, {}, missed.createTransport).connect(),
    ).rejects.toThrow(/company id/);
    expect(missed.closed).toBe(0);
  });
});
