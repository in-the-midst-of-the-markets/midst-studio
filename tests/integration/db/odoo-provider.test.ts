import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { OdooProvider, odooApiHost, odooApiKey } from "@/lib/db/providers/sql/odoo";
import type { DatabaseConnection } from "@/lib/types";

const KEY = "odoo-api-key-value";

const connection = {
  id: "odoo",
  name: "odoo",
  type: "odoo",
  host: "mycompany.odoo.com",
  password: KEY,
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
  requests: { url: string; method: string; body?: string; maxResponseBytes?: number }[];
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string; body?: string; maxResponseBytes?: number }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({
          url: request.url,
          method: request.method,
          body: request.body,
          maxResponseBytes: request.maxResponseBytes,
        });
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

const session = { body: { uid: 2 } };

const partnerRow = {
  id: 1,
  name: "Amy",
  is_company: false,
  partner_id: [7, "Amy"],
  tags: ["a", "b"],
  address: { city: "Paris", owner: [2, "Bo"] },
};

describe("OdooProvider", () => {
  test("requires an API key and a host under odoo.com", () => {
    expect(odooApiKey(connection)).toBe(KEY);
    expect(odooApiHost(connection)).toBe("mycompany.odoo.com");
    expect(odooApiHost({ ...connection, host: " https://MyCompany.Odoo.com/odoo " })).toBe("mycompany.odoo.com");
    expect(odooApiHost({ ...connection, host: "http://MYCOMPANY.ODOO.COM." })).toBe("mycompany.odoo.com");
    expect(odooApiHost({ ...connection, host: "www.odoo.com" })).toBe("www.odoo.com");
    expect(odooApiHost({ ...connection, host: "staging.mycompany.odoo.com" })).toBe("staging.mycompany.odoo.com");
    expect(() => new OdooProvider({ ...connection, host: "census.odoo.com", password: "census" })).not.toThrow();
    const injected = `${KEY}\r\nX-Injected: 1`;
    expect(() => odooApiKey({ ...connection, password: injected })).toThrow(/single line/);
    try {
      odooApiKey({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("X-Injected");
    }
    expect(() => odooApiKey({ ...connection, password: "" })).toThrow(/API key is required/);
    expect(() => odooApiKey({ ...connection, password: "x".repeat(4090) })).toThrow(/single line/);
    expect(() => odooApiHost({ ...connection, host: "" })).toThrow(/host is required/);
    expect(() => odooApiHost({ ...connection, host: "   " })).toThrow(/host is required/);
    const missed = scripted([]);
    expect(() => new OdooProvider({ ...connection, host: "erp.example.com" }, {}, missed.createTransport)).toThrow(
      /odoo\.com/,
    );
    expect(missed.requests).toHaveLength(0);
    for (const host of [
      "odoo.com",
      "notodoo.com",
      "evil.odoo.com.attacker.com",
      "odoo.com.evil.com",
      "erp.example.com",
      "https://odoo-api-key-value@erp.example.com",
      "mycompany.odoo.com:8443",
    ]) {
      try {
        odooApiHost({ ...connection, host });
        throw new Error(`accepted ${host}`);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        const message = error instanceof Error ? error.message : "";
        expect(message).toBe("The API host must be a host under odoo.com. The access token is sent only there.");
        expect(message).not.toContain(KEY);
        expect(message).not.toContain("attacker");
        expect(message).not.toContain("example.com");
      }
    }
  });

  test("probes the database and refuses a write before a request", async () => {
    const models = [
      { model: "res.partner", name: "Contact" },
      { model: "res.partner", name: "dup" },
      { model: "1bad", name: "nope" },
      "nope",
      { model: "sale.order", name: "" },
      { model: "account.move", name: 3 },
    ];
    const fields = [
      { name: "id", ttype: "integer", required: false },
      { name: "name", ttype: "char", required: true },
      { name: "email", ttype: "char" },
      { name: "active", ttype: "boolean", required: false },
      { name: "credit", ttype: "monetary" },
      { name: "rank", ttype: "float" },
      { name: "name", ttype: "char" },
      { name: "bad name", ttype: "char" },
      { name: "note" },
      "skip",
    ];
    const probe = scripted([
      session,
      { body: models },
      { body: fields },
      { body: [] },
      { body: { not: "fields" } },
      { body: fields },
    ]);
    const opened = new OdooProvider(connection, {}, probe.createTransport);
    await expect(opened.listContainers()).rejects.toThrow(/Not connected/);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://mycompany.odoo.com/json/2/res.users/context_get");
    expect(probe.requests[0]?.method).toBe("POST");
    expect(probe.requests[0]?.body).toBe("{}");
    expect(probe.requests[0]?.maxResponseBytes).toBe(API_ANSWER_LIMIT);
    expect(probe.options?.origin).toEqual({ scheme: "https", host: "mycompany.odoo.com", port: 443 });
    expect(probe.options?.tls).toEqual({ rejectUnauthorized: true, identity: "mycompany.odoo.com" });
    expect(probe.options?.refusesLinkLocal).toBe(true);
    expect(probe.options?.refusesUpgrade).toBe(true);
    expect(probe.options?.maxSockets).toBe(4);
    expect(probe.options?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(probe.options?.headers.Accept).toBe("application/json");
    expect(probe.options?.headers["User-Agent"]).toBe("KnowSQL");
    expect(JSON.stringify(probe.options?.headers).toLowerCase()).not.toContain("x-odoo-database");
    expect(await opened.listContainers()).toEqual([{ path: ["database"], name: "database", level: 0 }]);
    expect(await opened.listContainers([])).toEqual([{ path: ["database"], name: "database", level: 0 }]);
    expect(await opened.listContainers(["database"])).toEqual([]);
    const names = (await opened.listObjects(["database"], "table")).map((object) => object.name);
    expect(names).toEqual(["res.partner", "sale.order", "account.move"]);
    expect(await opened.listObjects(["database"], "table")).toHaveLength(3);
    expect(await opened.countObjects(["database"])).toEqual({ table: { count: 3 } });
    expect(probe.requests).toHaveLength(2);
    expect(probe.requests[1]?.url).toContain("/json/2/ir.model/search_read");
    expect(JSON.parse(probe.requests[1]?.body ?? "")).toMatchObject({
      domain: [["transient", "=", false]],
      limit: 200,
    });
    const detail = await opened.describeObject(["database", "res.partner"], "table");
    expect(detail.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "email",
      "active",
      "credit",
      "rank",
      "note",
    ]);
    expect(detail.columns[0]).toMatchObject({ name: "id", type: "integer", nullable: false, isPrimary: true });
    expect(detail.columns.find((column) => column.name === "name")).toMatchObject({
      type: "varchar",
      nullable: false,
      isPrimary: false,
    });
    expect(detail.columns.find((column) => column.name === "active")).toMatchObject({
      type: "boolean",
      nullable: true,
    });
    expect(detail.columns.find((column) => column.name === "credit")).toMatchObject({ type: "double" });
    expect(detail.columns.find((column) => column.name === "rank")).toMatchObject({ type: "double" });
    expect(detail.foreignKeys).toEqual([]);
    const empty = await opened.describeObject(["database", "sale.order"], "table");
    expect(empty.columns).toEqual([{ name: "id", type: "integer", nullable: false, isPrimary: true }]);
    await expect(opened.describeObject(["database", "account.move"], "table")).rejects.toThrow(/did not return fields/);
    await expect(opened.describeObject(["database", "has space"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObjects(["database"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObjects(["database"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    const bulk = await opened.describeObjects(["database"], "table", 1);
    expect(bulk.details).toHaveLength(1);
    await expect(opened.listObjects(["database"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.countObjects([])).rejects.toThrow(/container path/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsTransactions).toBe(false);
    expect(opened.getCapabilities().defaultPort).toBeNull();
    expect(opened.getCapabilities().identifierQuoting).toBe("double");
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({ version: "Odoo JSON-2 API", tableCount: 3 });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    const before = probe.requests.length;
    await expect(opened.query("INSERT INTO res.partner (name) VALUES ('Amy')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT id FROM res.partner", ["x"])).rejects.toThrow(/bind parameters/);
    expect(probe.requests).toHaveLength(before);
    await opened.disconnect();
    expect(probe.closed).toBe(1);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    await opened.disconnect();
  });

  test("flattens a page, counts, and warns when the page is full", async () => {
    const rowText =
      '[{"id":1,"name":"Amy","is_company":false,"partner_id":[7,"Amy"],"tags":["a","b"],"address":{"city":"Paris","owner":[2,"Bo"]},"__proto__":"nope","constructor":"no"},null]';
    const full = Array.from({ length: 200 }, (_, index) => ({ id: index, name: "A" }));
    const page = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    const probe = scripted([
      { text: "" },
      { text: rowText },
      { body: [partnerRow] },
      { body: [] },
      { body: 4 },
      { body: 4 },
      { body: full },
      { body: page },
      { body: [{ id: 1 }] },
    ]);
    const opened = new OdooProvider({ ...connection, host: "http://mycompany.odoo.com" }, {}, probe.createTransport);
    await opened.connect();
    const selected = await opened.query("SELECT Name, missing FROM res.partner", []);
    expect(selected.rows[0]).toEqual({ Name: "Amy", missing: null });
    expect(selected.fields).toEqual(["Name", "missing"]);
    expect(selected.rowCount).toBe(2);
    expect(typeof selected.executionTime).toBe("number");
    expect(Object.hasOwn(selected.rows[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(selected.rows[0] ?? {}, "constructor")).toBe(false);
    const star = await opened.query("SELECT * FROM res.partner");
    expect(star.rows[0]).toMatchObject({
      id: 1,
      is_company: false,
      partner_id: 7,
      "partner_id.name": "Amy",
      tags: null,
      "address.city": "Paris",
      "address.owner": 2,
      "address.owner.name": "Bo",
    });
    const empty = await opened.query("SELECT * FROM res.partner");
    expect(empty.fields).toEqual(["id"]);
    const counted = await opened.query("SELECT COUNT(*) AS total FROM res.partner WHERE is_company = true");
    expect(counted.rows).toEqual([{ total: 4 }]);
    expect(probe.requests.at(-1)?.url).toBe("https://mycompany.odoo.com/json/2/res.partner/search_count");
    expect(JSON.parse(probe.requests.at(-1)?.body ?? "")).toEqual({ domain: [["is_company", "=", true]] });
    const plain = await opened.query("SELECT COUNT(*) FROM res.partner");
    expect(plain.rows).toEqual([{ count: 4 }]);
    const capped = await opened.query("SELECT id FROM res.partner ORDER BY name DESC LIMIT 250 OFFSET 3");
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toContain("at most 200");
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toContain("this page only");
    const sent = JSON.parse(probe.requests.at(-1)?.body ?? "") as { limit: number; offset: number; order: string };
    expect(sent).toMatchObject({ limit: 200, offset: 3, order: "name desc", fields: ["id"] });
    const starBody = JSON.parse(probe.requests[2]?.body ?? "") as { fields?: unknown };
    expect(starBody).not.toHaveProperty("fields");
    const wide = await opened.query("SELECT id FROM res.partner");
    expect(wide.warnings?.map((warning) => warning.message).join(" ")).toContain("this page only");
    expect(wide.warnings?.map((warning) => warning.message).join(" ")).not.toContain("at most 200");
    const one = await opened.query("SELECT id FROM res.partner LIMIT 10");
    expect(one.warnings ?? []).toEqual([]);
    await opened.disconnect();
  });

  test("maps errors, redirects, and a secret in a transport error", async () => {
    const probe = scripted([
      { status: 401, body: { message: "", debug: "Traceback" } },
      { body: [] },
      session,
      { status: 401, body: { message: "Invalid apikey", debug: `Traceback ${KEY}` } },
      { status: 403, body: { message: "no access" } },
      { status: 400, body: { message: 1 } },
      { status: 100, body: [] },
      { status: 429, body: { message: `rejected ${KEY}` } },
      { status: 302, text: "https://evil.example" },
      { text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { status: 500, text: "not json" },
      { text: "not json" },
      { body: { id: 1 } },
      { body: { total: 1 } },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `dial failed for ${KEY}`) },
      { throw: new DatabaseConfigError("kept", "odoo") },
      { throw: "down" },
    ]);
    const opened = new OdooProvider(connection, {}, probe.createTransport);
    await expect(opened.connect()).rejects.toThrow(AuthenticationError);
    expect(probe.closed).toBe(1);
    await expect(opened.connect()).rejects.toThrow(/did not return a session/);
    expect(probe.closed).toBe(2);
    await opened.connect();
    try {
      await opened.query("SELECT id FROM res.partner");
      throw new Error("missing 401");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("Invalid apikey");
      expect(message).not.toContain("Traceback");
      expect(message).not.toContain(KEY);
    }
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/answered 400/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/answered 100/);
    try {
      await opened.query("SELECT id FROM res.partner");
      throw new Error("missing 429");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(KEY);
      expect(message).toContain("••••");
    }
    try {
      await opened.query("SELECT id FROM res.partner");
      throw new Error("missing redirect");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("redirect");
      expect(message).not.toContain("evil.example");
    }
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/2 MB/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/not json/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/did not return a query/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/did not return a query/);
    await expect(opened.query("SELECT COUNT(*) FROM res.partner")).rejects.toThrow(/did not return a count/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/redirect/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/2 MB/);
    try {
      await opened.query("SELECT id FROM res.partner");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error instanceof Error ? error.message : "").not.toContain(KEY);
    }
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/kept/);
    await expect(opened.query("SELECT id FROM res.partner")).rejects.toThrow(/could not be reached/);
  });

  test("reads the model list again after a bad page", async () => {
    const probe = scripted([
      session,
      { body: { message: "no" } },
      { body: [{ model: "res.partner", name: "Contact" }] },
      { body: [] },
    ]);
    const opened = new OdooProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await expect(opened.listObjects(["database"], "table")).rejects.toThrow(/model list/);
    const names = (await opened.listObjects(["database"], "table")).map((object) => object.name);
    expect(names).toEqual(["res.partner"]);
    const all = await opened.describeObjects(["database"], "table");
    expect(all.details).toHaveLength(1);
    await opened.disconnect();
  });
});
