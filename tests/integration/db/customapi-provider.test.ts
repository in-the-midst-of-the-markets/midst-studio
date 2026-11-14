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
import { RestProvider } from "@/lib/db/providers/sql/customapi";
import { CUSTOMAPI_CONNECTION_STRING } from "@/lib/db/providers/sql/customapi/connection-string";
import { CUSTOMAPI_EXECUTION_UI } from "@/lib/db/providers/sql/customapi/execution-ui";
import { CUSTOMAPI_MIGRATION_DDL } from "@/lib/db/providers/sql/customapi/migration-ddl";
import { CUSTOMAPI_SQL_GRAMMAR } from "@/lib/db/providers/sql/customapi/sql-grammar";
import { CUSTOMAPI_SQL_WRITING } from "@/lib/db/providers/sql/customapi/sql-writing";
import type { DatabaseConnection } from "@/lib/types";

const SECRET = "super-secret-value";

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

function catalog(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth: "bearer",
    headerName: "X-API-Key",
    resources: [
      { name: "items", path: "/items", rows: "" },
      { name: "orders", path: "/v1/orders", rows: "data.items" },
    ],
    ...patch,
  });
}

function connection(patch: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "api",
    name: "Acme",
    type: "customapi",
    host: "api.example.com",
    password: SECRET,
    apiCatalog: catalog(),
    createdAt: new Date(0),
    ...patch,
  };
}

describe("RestProvider", () => {
  test("quotes a name the way the editor completes it", () => {
    const formatSegment = CUSTOMAPI_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = CUSTOMAPI_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (formatSegment == null || readQuoted == null) throw new Error("Custom API completion is missing a quoter");
    expect(formatSegment('a"b')).toBe('"a""b"');
    expect(readQuoted('"a""b".')).toBe('a"b');
    expect(readQuoted("items.")).toBeUndefined();
    expect(CUSTOMAPI_SQL_WRITING.placeholder).toBeNull();
    expect(CUSTOMAPI_CONNECTION_STRING.scheme).toBeNull();
    expect(CUSTOMAPI_EXECUTION_UI.consentDeadline).toBeNull();
    expect(CUSTOMAPI_MIGRATION_DDL.tableDdl).toBe("refused");
  });

  test("refuses a host, a secret, or a catalog that cannot be queried", () => {
    const open = (patch: Partial<DatabaseConnection>) =>
      new RestProvider(connection(patch), {}, scripted([]).createTransport);
    expect(() => open({ host: "http://api.example.com" })).toThrow(DatabaseConfigError);
    expect(() => open({ host: "10.1.2.3" })).toThrow(DatabaseConfigError);
    expect(() => open({ host: "localhost" })).toThrow(DatabaseConfigError);
    expect(() => open({ apiCatalog: undefined })).toThrow(DatabaseConfigError);
    expect(() => open({ password: "short" })).toThrow(DatabaseConfigError);
    expect(() => open({ password: "line\nsecret" })).toThrow(DatabaseConfigError);
    expect(() => open({ apiCatalog: catalog({ auth: "basic" }) })).toThrow(DatabaseConfigError);
    expect(() => open({ apiCatalog: catalog({ auth: "query" }) })).toThrow(DatabaseConfigError);
    expect(() => open({ apiCatalog: catalog({ auth: "header", headerName: "Authorization" }) })).toThrow(
      DatabaseConfigError,
    );
    expect(() =>
      open({
        apiCatalog: catalog({
          resources: [{ name: "items", path: "/a/../b", rows: "" }],
        }),
      }),
    ).toThrow(DatabaseConfigError);
    expect(() =>
      open({
        apiCatalog: catalog({
          resources: [{ name: "items", path: "/items?x=1", rows: "" }],
        }),
      }),
    ).toThrow(DatabaseConfigError);
    const many = Array.from({ length: 25 }, (_, index) => ({ name: `item${index}`, path: `/i${index}`, rows: "" }));
    expect(() => open({ apiCatalog: catalog({ resources: many }) })).toThrow(DatabaseConfigError);
    expect(() => open({ apiCatalog: "x".repeat(16_001) })).toThrow(DatabaseConfigError);
    expect(() =>
      open({
        apiCatalog: catalog({
          resources: [
            { name: "items", path: "/items", rows: "" },
            { name: "Items", path: "/other", rows: "" },
          ],
        }),
      }),
    ).toThrow(DatabaseConfigError);
  });

  test("reads a resource with the secret in a header and never in the URL", async () => {
    const wire = scripted([
      {
        body: [
          { id: "1", name: "Ada", "a-b": 2, "1bad": 3 },
          { id: "2", name: "Bea" },
        ],
      },
      { body: [{ id: "1", name: "Ada" }] },
      { body: { data: { items: [{ id: "9" }] } } },
    ]);
    const provider = new RestProvider(connection(), {}, wire.createTransport);
    await provider.connect();
    await provider.connect();
    expect(wire.requests).toHaveLength(0);
    expect(provider.getCapabilities()).toMatchObject({
      supportsExplain: false,
      supportsResultPagination: true,
      supportsConnectionString: false,
      identifierQuoting: "double",
    });
    expect(provider.getLabels().searchPlaceholder).toBe("Search resources...");

    const listed = await provider.query("SELECT * FROM items", []);
    expect(listed.fields).toEqual(["id", "name"]);
    expect(listed.rows).toEqual([
      { id: "1", name: "Ada" },
      { id: "2", name: "Bea" },
    ]);
    expect(listed.warnings).toBeUndefined();
    expect(wire.requests[0]).toEqual({ url: "https://api.example.com/items", method: "GET" });
    expect(wire.requests[0]?.url.includes(SECRET)).toBe(false);
    expect(wire.options[0]).toMatchObject({
      refusesLinkLocal: true,
      refusesPrivate: true,
      refusesUpgrade: true,
      maxSockets: 4,
      origin: { scheme: "https", host: "api.example.com", port: 443 },
      tls: { rejectUnauthorized: true, identity: "api.example.com" },
      headers: { Accept: "application/json", Authorization: `Bearer ${SECRET}` },
    });

    const filtered = await provider.query("SELECT id, missing FROM items WHERE id = '1'");
    expect(filtered.rows).toEqual([{ id: "1", missing: null }]);
    expect(wire.options).toHaveLength(1);

    const orders = new RestProvider(connection(), {}, wire.createTransport);
    await orders.connect();
    const page = await orders.query("SELECT id FROM orders");
    expect(page.rows).toEqual([{ id: "9" }]);
    expect(wire.requests[2]?.url).toBe("https://api.example.com/v1/orders");
  });

  test("sends a named header or basic authentication", async () => {
    const headerWire = scripted([{ body: { data: { items: [{ id: "9" }] } } }]);
    const header = new RestProvider(
      connection({ apiCatalog: catalog({ auth: "header", headerName: "X-API-Key" }) }),
      {},
      headerWire.createTransport,
    );
    await header.connect();
    expect((await header.query("SELECT id FROM orders")).rows).toEqual([{ id: "9" }]);
    expect(headerWire.options[0]?.headers).toEqual({ Accept: "application/json", "X-API-Key": SECRET });

    const token = Buffer.from(`account:${SECRET}`, "utf8").toString("base64");
    const basicWire = scripted([{ body: [{ id: "1" }] }]);
    const basic = new RestProvider(
      connection({ user: "account", apiCatalog: catalog({ auth: "basic" }) }),
      {},
      basicWire.createTransport,
    );
    await basic.connect();
    expect((await basic.query("SELECT id FROM items")).rows).toEqual([{ id: "1" }]);
    expect(basicWire.options[0]?.headers?.Authorization).toBe(`Basic ${token}`);
  });

  test("stops at the row cap and at an offset past it", async () => {
    const wire = scripted([
      { body: [{ id: "1" }] },
      { body: Array.from({ length: 200 }, (_, index) => ({ id: String(index) })) },
    ]);
    const provider = new RestProvider(connection(), {}, wire.createTransport);
    await provider.connect();
    const wide = await provider.query("SELECT id FROM items LIMIT 10000");
    expect(wide.warnings?.[0]?.message).toContain("200");
    const full = await provider.query("SELECT * FROM items");
    expect(full.rows).toHaveLength(100);
    expect(full.warnings?.[0]?.message).toContain("200");
    const star = await provider.query("SELECT * FROM items OFFSET 200");
    const named = await provider.query("SELECT id FROM items OFFSET 200");
    expect(star.rows).toEqual([]);
    expect(named.fields).toEqual(["id"]);
    expect(wire.requests).toHaveLength(2);
  });

  test("refuses a statement that is not one read of a named resource", async () => {
    const wire = scripted([]);
    const provider = new RestProvider(connection(), {}, wire.createTransport);
    await expect(provider.query("SELECT id FROM items", [1])).rejects.toThrow(QueryError);
    await provider.connect();
    await expect(provider.query("")).rejects.toThrow(QueryError);
    await expect(provider.query("INSERT INTO items (id) VALUES ('1')")).rejects.toThrow(QueryError);
    await expect(provider.query("SELECT id FROM missing")).rejects.toThrow("no resource");
    expect(wire.requests).toHaveLength(0);
  });

  test("names a bad answer, a refused status, and a failed request", async () => {
    const secretBody = { message: `no ${SECRET}` };
    const wire = scripted([
      { body: { data: { items: null } } },
      { body: { data: {} } },
      { body: { data: { items: { id: "1" } } } },
      { body: [] },
      { body: { id: "1" } },
      { body: [1, { id: "1" }] },
      { text: "" },
      { text: "not-json" },
      { status: 302, text: "away" },
      { status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { status: 401, body: secretBody },
      { status: 403, body: { error: "forbidden" } },
      { status: 429, body: { message: "slow" } },
      { status: 500, text: "" },
      { status: 500, text: "[]" },
      { status: 500, body: { error: { code: 1 } } },
      { status: 500, body: { message: "" } },
      { status: 500, body: { message: `bad ${SECRET}` } },
      { throw: new TransportError("unreachable", `down ${SECRET}`) },
      { throw: new QueryError("kept", "customapi") },
      { throw: new Error(`down ${SECRET}`) },
      { throw: "boom" },
    ]);
    const provider = new RestProvider(connection(), {}, wire.createTransport);
    await provider.connect();
    expect((await provider.query("SELECT id FROM orders")).rows).toEqual([]);
    await expect(provider.query("SELECT id FROM orders")).rejects.toThrow("did not contain a list");
    await expect(provider.query("SELECT id FROM orders")).rejects.toThrow("did not contain a list");
    await expect(provider.query("SELECT id FROM orders")).rejects.toThrow("did not contain a list");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("did not contain a list");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("was not a list");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("was not JSON");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("was not JSON");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow(ConnectionError);
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("larger than 2 MB");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow(AuthenticationError);
    const forbidden = await provider.query("SELECT id FROM items").then(
      () => null,
      (error: unknown) => error,
    );
    expect(forbidden).toBeInstanceOf(PermissionDeniedError);
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("limiting requests");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("The API answered 500.");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("[]");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("code");
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("message");
    const leaked = await provider.query("SELECT id FROM items").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(leaked).not.toContain(SECRET);
    expect(leaked).toContain("••••");
    const transport = await provider.query("SELECT id FROM items").then(
      () => null,
      (error: unknown) => error,
    );
    expect(transport).toBeInstanceOf(ConnectionError);
    expect(transport instanceof Error ? transport.message : "").not.toContain(SECRET);
    const kept = await provider.query("SELECT id FROM items").then(
      () => null,
      (error: unknown) => error,
    );
    expect(kept).toBeInstanceOf(QueryError);
    expect(kept instanceof Error ? kept.message : "").toBe("kept");
    const plain = await provider.query("SELECT id FROM items").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(plain).not.toContain(SECRET);
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("could not be reached");

    const token = Buffer.from(`account:${SECRET}`, "utf8").toString("base64");
    const basicWire = scripted([{ throw: new Error(`down ${token}`) }]);
    const basic = new RestProvider(
      connection({ user: "account", apiCatalog: catalog({ auth: "basic" }) }),
      {},
      basicWire.createTransport,
    );
    await basic.connect();
    const hidden = await basic.query("SELECT id FROM items").then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(hidden).not.toContain(token);
    expect(hidden).not.toContain(SECRET);
  });

  test("reuses one transport until the secret changes, then closes it", async () => {
    const config = connection();
    const wire = scripted([{ body: [{ id: "1" }] }, { body: [{ id: "2" }] }, { body: [{ id: "3" }] }]);
    const provider = new RestProvider(config, {}, wire.createTransport);
    await provider.connect();
    await provider.query("SELECT id FROM items");
    await provider.query("SELECT id FROM items");
    expect(wire.options).toHaveLength(1);
    expect(wire.closed.count).toBe(0);
    config.password = "another-secret-value";
    await provider.query("SELECT id FROM items");
    expect(wire.options).toHaveLength(2);
    expect(wire.options[1]?.headers?.Authorization).toBe("Bearer another-secret-value");
    expect(wire.closed.count).toBe(1);
    await provider.disconnect();
    expect(wire.closed.count).toBe(2);
    await expect(provider.query("SELECT id FROM items")).rejects.toThrow("Not connected");

    const idle = new RestProvider(connection(), {}, scripted([]).createTransport);
    await idle.disconnect();
  });

  test("lists the resources it was given and nothing else", async () => {
    const provider = new RestProvider(connection(), {}, scripted([]).createTransport);
    await expect(provider.getOverview()).rejects.toThrow("Not connected");
    await provider.connect();
    expect(await provider.listContainers()).toEqual([{ path: ["api"], name: "api", level: 0 }]);
    expect(await provider.listContainers([])).toEqual([{ path: ["api"], name: "api", level: 0 }]);
    expect(await provider.listContainers(["other"])).toEqual([]);
    expect(await provider.countObjects(["api"])).toEqual({ table: { count: 2 } });
    await expect(provider.countObjects(["api", "extra"])).rejects.toThrow();
    expect(await provider.listObjects(["api"], "table")).toEqual([
      { path: ["api", "items"], name: "items", kind: "table" },
      { path: ["api", "orders"], name: "orders", kind: "table" },
    ]);
    await expect(provider.listObjects(["api"], "view")).rejects.toThrow("no object kind");
    expect(await provider.describeObject(["api", "items"], "table")).toEqual({
      path: ["api", "items"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    await expect(provider.describeObject(["api", "missing"], "table")).rejects.toThrow("no table");
    await expect(provider.describeObjects(["api"], "table", 0)).rejects.toThrow("positive whole number");
    const one = await provider.describeObjects(["api"], "table", 1);
    expect(one.details).toHaveLength(1);
    const all = await provider.describeObjects(["api"], "table");
    expect(all.details).toHaveLength(2);
    expect(await provider.getOverview()).toMatchObject({ version: "Custom API", tableCount: 2 });
    expect(await provider.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await expect(provider.runMaintenance()).rejects.toThrow("no maintenance");
  });
});
