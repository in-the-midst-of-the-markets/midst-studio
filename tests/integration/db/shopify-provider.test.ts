import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import { ShopifyProvider, shopifyAccessToken, shopifyApiHost } from "@/lib/db/providers/sql/shopify";
import { SHOPIFYQL_SCHEMAS } from "@/lib/db/providers/sql/shopify/translate";
import type { DatabaseConnection } from "@/lib/types";

const TOKEN = "shpat_shopifytoken";

const connection = {
  id: "shop",
  name: "shop",
  type: "shopify",
  host: "your-store.myshopify.com",
  password: TOKEN,
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
  requests: { url: string; method: string; body: string }[];
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string; body: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, body: request.body ?? "" });
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

const shop = { data: { shop: { name: "Your Store", myshopifyDomain: "your-store.myshopify.com" } } };
const QUERY = "FROM sales SHOW total_sales";

function table(
  rows: unknown[],
  columns: unknown[] = [{ name: "total_sales", dataType: "MONEY", displayName: "Total sales" }],
) {
  return {
    data: {
      shopifyqlQuery: {
        tableData: { columns, rows },
        parseErrors: [],
      },
    },
  };
}

describe("ShopifyProvider", () => {
  test("requires a token and a shop host, and does not repeat either in a refusal", () => {
    expect(() => new ShopifyProvider(connection)).not.toThrow();
    expect(
      () => new ShopifyProvider({ ...connection, password: "census", host: "census.myshopify.com" }),
    ).not.toThrow();
    expect(() => new ShopifyProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    expect(() => new ShopifyProvider({ ...connection, host: "  " })).toThrow(/shop host is required/);
    const injected = `${TOKEN}\r\nX-Injected: 1`;
    try {
      shopifyAccessToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain(TOKEN);
    }
    expect(() => shopifyAccessToken({ ...connection, password: "x".repeat(4097) })).toThrow(/single line/);
    expect(shopifyAccessToken({ ...connection, password: "x".repeat(4096) })).toHaveLength(4096);
    expect(shopifyApiHost(connection)).toBe("your-store.myshopify.com");
    expect(shopifyApiHost({ ...connection, host: " https://YOUR-STORE.myshopify.com/admin " })).toBe(
      "your-store.myshopify.com",
    );
    for (const host of [
      "evil.example",
      "https://user:secret@your-store.myshopify.com",
      "your-store.myshopify.com:443",
      "a.b.myshopify.com",
      "notmyshopify.com",
    ]) {
      expect(() => shopifyApiHost({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        shopifyApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain("secret");
      }
    }
  });

  test("connects with a shop query and sends the token only on that host", async () => {
    const transport = scripted([{ body: shop }]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    await provider.connect();
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.method).toBe("POST");
    expect(transport.requests[0]?.url).toBe("https://your-store.myshopify.com/admin/api/2025-10/graphql.json");
    expect(transport.requests[0]?.body).toContain("shop");
    expect(transport.options?.headers?.["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(transport.options?.tls).toEqual({ rejectUnauthorized: true, identity: "your-store.myshopify.com" });
    expect(transport.options?.refusesLinkLocal).toBe(true);
    expect(transport.options?.refusesUpgrade).toBe(true);
    expect(provider.getLabels().entityName).toBe("Table");
    expect(provider.getLabels().entityNamePlural).toBe("Tables");
    await provider.disconnect();
    expect(transport.closed).toBe(1);
    await provider.disconnect();
  });

  test("sends the ShopifyQL text and reads the table by column name", async () => {
    const transport = scripted([
      { body: shop },
      {
        body: table(
          [
            { month: "2026-01-01", total_sales: "10000.00", orders: "25", extra: { nested: true }, tags: ["wool"] },
            { Month: "2026-02-01", total_sales: null, orders: 7 },
            "not-a-row",
          ],
          [
            { name: "month", dataType: "MONTH_TIMESTAMP", displayName: "Month" },
            { name: "total_sales", dataType: "MONEY", displayName: "Total sales" },
            { name: "orders", dataType: "INTEGER", displayName: "Orders" },
            { name: "extra", dataType: "STRING", displayName: "Extra" },
            { name: "tags", dataType: "STRING", displayName: "Tags" },
            { name: "", dataType: "STRING" },
            { name: "__proto__", dataType: "STRING" },
            { dataType: "MONEY" },
            "nope",
            { name: "total_sales", dataType: "MONEY" },
          ],
        ),
      },
      {
        body: {
          data: {
            shopifyqlQuery: {
              tableData: { columns: [], rows: [JSON.parse('{"total_sales":"1","__proto__":{"admin":true}}')] },
            },
          },
        },
      },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    const result = await provider.query(`-- note\n${QUERY} WHERE sales_channel = 'Online Store';`);
    expect(transport.requests[1]?.body).toContain("shopifyqlQuery");
    expect(transport.requests[1]?.body).toContain("FROM sales SHOW total_sales WHERE sales_channel = 'Online Store'");
    expect(transport.requests[1]?.body).not.toContain("-- note");
    expect(result.fields).toEqual(["month", "total_sales", "orders", "extra", "tags", "total_sales (2)"]);
    expect(result.rows[0]).toEqual({
      month: "2026-01-01",
      total_sales: "10000.00",
      orders: "25",
      extra: '{"nested":true}',
      tags: '["wool"]',
      "total_sales (2)": null,
    });
    expect(result.rows[1]).toEqual({
      month: "2026-02-01",
      total_sales: null,
      orders: 7,
      extra: null,
      tags: null,
      "total_sales (2)": null,
    });
    expect(result.rows[2]).toEqual({
      month: null,
      total_sales: null,
      orders: null,
      extra: null,
      tags: null,
      "total_sales (2)": null,
    });
    expect(JSON.stringify(result.rows)).not.toContain("admin");
    expect(result.warnings).toEqual([]);
    const bare = await provider.query(QUERY);
    expect(bare.fields).toEqual(["total_sales"]);
    expect(bare.rows).toEqual([{ total_sales: "1" }]);
  });

  test("refuses parameters, SQL, and a query before connect", async () => {
    const transport = scripted([
      { body: shop },
      {
        body: {
          data: {
            shopifyqlQuery: {
              tableData: null,
              parseErrors: [`bad ${TOKEN}`, "", 1],
            },
          },
        },
      },
      { body: table([{ total_sales: "2" }]) },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await expect(provider.query(QUERY)).rejects.toThrow(/Not connected/);
    await expect(provider.query(QUERY, [1])).rejects.toThrow(/does not bind/);
    await provider.connect();
    await expect(provider.query("DELETE FROM sales")).rejects.toThrow(/read-only/);
    try {
      await provider.query(QUERY);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("Shopify refused the query");
    }
    await expect(provider.query(QUERY, [])).resolves.toMatchObject({ rows: [{ total_sales: "2" }] });
  });

  test("maps HTTP failures, GraphQL errors and transport failures without leaking the token", async () => {
    const cases: ScriptedPage[] = [
      { status: 401, body: { errors: [{ message: `bad ${TOKEN}` }] } },
      { status: 403 },
      { status: 429 },
      { status: 302, text: "" },
      { status: 500, text: "" },
      { status: 200, text: "not-json" },
      { status: 200, body: { errors: [{ message: `no ${TOKEN}` }, "nope"] } },
      { status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { throw: new TransportError("redirect", "redirected") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${TOKEN}`) },
      { throw: new DatabaseConfigError("kept", "shopify") },
      { throw: "offline" },
    ];
    const transport = scripted([{ body: shop }, ...cases]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    await expect(provider.query(QUERY)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(provider.query(QUERY)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(provider.query(QUERY)).rejects.toThrow(/limiting requests/);
    await expect(provider.query(QUERY)).rejects.toThrow(/redirect/);
    await expect(provider.query(QUERY)).rejects.toThrow(/refused the query/);
    await expect(provider.query(QUERY)).rejects.toThrow(/not JSON/);
    try {
      await provider.query(QUERY);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("Shopify refused the query");
    }
    await expect(provider.query(QUERY)).rejects.toThrow(/larger than 2 MB/);
    await expect(provider.query(QUERY)).rejects.toThrow(/redirect/);
    await expect(provider.query(QUERY)).rejects.toThrow(/larger than 2 MB/);
    try {
      await provider.query(QUERY);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }
    await expect(provider.query(QUERY)).rejects.toThrow(/kept/);
    await expect(provider.query(QUERY)).rejects.toThrow(/could not be reached/);
  });

  test("closes the transport when connect is refused", async () => {
    const missing = scripted([{ body: { data: {} } }]);
    const provider = new ShopifyProvider(connection, {}, missing.createTransport);
    await expect(provider.connect()).rejects.toThrow(/did not name/);
    expect(missing.closed).toBe(1);
    const unnamed = scripted([{ body: { data: { shop: { name: "" } } } }]);
    await expect(new ShopifyProvider(connection, {}, unnamed.createTransport).connect()).rejects.toThrow(
      /did not name/,
    );
    const broken = scripted([{ body: { data: { shop: "nope" } } }]);
    await expect(new ShopifyProvider(connection, {}, broken.createTransport).connect()).rejects.toThrow(/did not name/);
  });

  test("lists the shop, describes schemas, and refuses a bad bulk limit", async () => {
    const transport = scripted([{ body: shop }]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await expect(provider.listContainers()).rejects.toThrow(/Not connected/);
    await expect(provider.getOverview()).rejects.toThrow(/Not connected/);
    await provider.connect();
    expect(await provider.listContainers()).toEqual([{ path: ["shop"], name: "shop", level: 0 }]);
    expect(await provider.listContainers(["shop"])).toEqual([]);
    expect(await provider.listContainers([])).toEqual([{ path: ["shop"], name: "shop", level: 0 }]);
    expect(await provider.countObjects(["shop"])).toEqual({ table: { count: SHOPIFYQL_SCHEMAS.length } });
    await expect(provider.countObjects([])).rejects.toThrow(QueryError);
    const objects = await provider.listObjects(["shop"], "table");
    expect(objects.map((object) => object.name)).toEqual(SHOPIFYQL_SCHEMAS.map((schema) => schema.name));
    await expect(provider.listObjects(["shop"], "view")).rejects.toThrow(/object kind/);
    const described = await provider.describeObject(["shop", "sales"], "table");
    expect(described.columns).toEqual([]);
    await expect(provider.describeObject(["shop", "missing"], "table")).rejects.toThrow(/no table/);
    const batch = await provider.describeObjects(["shop"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(await provider.describeObjects(["shop"], "table")).toMatchObject({ details: expect.any(Array) });
    await expect(provider.describeObjects(["shop"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(provider.describeObjects(["shop"], "table", 1.5)).rejects.toThrow(/1\.5/);
    expect(await provider.getHealth()).toMatchObject({ databaseSize: "N/A" });
    await expect(provider.runMaintenance()).rejects.toThrow(/no maintenance/);
    expect(await provider.getOverview()).toMatchObject({
      version: "ShopifyQL 2025-10",
      tableCount: SHOPIFYQL_SCHEMAS.length,
    });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("refuses a ShopifyQL answer that is not a table", async () => {
    const transport = scripted([
      { body: shop },
      { body: { data: {} } },
      { body: { data: { shopifyqlQuery: { tableData: null, parseErrors: null } } } },
      { body: { data: { shopifyqlQuery: { tableData: { columns: {}, rows: [] }, parseErrors: [] } } } },
      { body: { data: { shopifyqlQuery: { tableData: { columns: [], rows: "nope" }, parseErrors: [] } } } },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    await expect(provider.query(QUERY)).rejects.toThrow(/did not return a table/);
    await expect(provider.query(QUERY)).rejects.toThrow(/did not return a table/);
    await expect(provider.query(QUERY)).rejects.toThrow(/did not return a table/);
    await expect(provider.query(QUERY)).rejects.toThrow(/did not return a table/);
  });
});
