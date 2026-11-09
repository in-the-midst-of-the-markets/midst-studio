import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import { ShopifyProvider, shopifyAccessToken, shopifyApiHost } from "@/lib/db/providers/sql/shopify";
import { SHOPIFY_TABLES } from "@/lib/db/providers/sql/shopify/translate";
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

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = hasNextPage ? "cursor-1" : null) {
  return {
    data: {
      products: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage, endCursor },
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

  test("projects columns, flattens nested fields, and warns when a page is full", async () => {
    const transport = scripted([
      { body: shop },
      {
        body: page(
          [
            {
              id: "gid://shopify/Product/1",
              title: "Hat",
              vendor: "Acme",
              titleNull: null,
            },
            { Title: "Cap" },
          ],
          true,
          "cursor-1",
        ),
      },
      {
        text: JSON.stringify({
          data: {
            products: {
              edges: [{ node: { title: "Hat", tags: ["wool"], extra: { nested: true }, __proto__: "nope" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    const result = await provider.query("SELECT title, vendor FROM products LIMIT 2");
    expect(result.fields).toEqual(["title", "vendor"]);
    expect(result.rows[0]).toEqual({ title: "Hat", vendor: "Acme" });
    expect(result.rows[1]).toEqual({ title: "Cap", vendor: null });
    expect(result.warnings?.map((warning) => warning.message).join(" ")).toContain("this page only");
    expect(JSON.stringify(result.rows)).not.toContain("nope");
    const star = await provider.query("SELECT * FROM products");
    expect(star.rows[0]?.tags).toBe('["wool"]');
    expect(star.rows[0]?.extra).toBe('{"nested":true}');
  });

  test("walks a cursor for OFFSET and stops on an empty page", async () => {
    const transport = scripted([
      { body: shop },
      { body: page([{ id: "1", title: "Skip" }], true, "cursor-1") },
      { body: page([{ id: "2", title: "Keep" }], false, "cursor-2") },
      { body: page([{ id: "3", title: "Skip" }], true, "cursor-3") },
      { body: { data: { products: { edges: [], pageInfo: { hasNextPage: true, endCursor: "cursor-4" } } } } },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    const result = await provider.query("SELECT title FROM products OFFSET 1 LIMIT 1");
    expect(result.rows).toEqual([{ title: "Keep" }]);
    expect(result.warnings).toEqual([]);
    const emptyPage = await provider.query("SELECT title FROM products OFFSET 1 LIMIT 1");
    expect(emptyPage.rows).toEqual([]);
    expect(emptyPage.warnings).toEqual([]);
  });

  test("warns when a limit is capped and when the scan stops early", async () => {
    const full = Array.from({ length: 250 }, (_, index) => ({ id: String(index), title: "Row" }));
    const transport = scripted([
      { body: shop },
      { body: page(full, true, "c1") },
      { body: page(full, true, "c2") },
      { body: page(full, true, "c3") },
      { body: page(full, true, "c4") },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    const capped = await provider.query("SELECT id FROM products LIMIT 1001");
    expect(capped.rowCount).toBe(1000);
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toContain("1000");
  });

  test("counts, and reads orders, variants and collections into flat columns", async () => {
    const transport = scripted([
      { body: shop },
      { body: { data: { ordersCount: { count: 4 } } } },
      {
        body: {
          data: {
            orders: {
              edges: [
                null,
                { cursor: "only" },
                {
                  node: {
                    id: "o1",
                    totalPriceSet: { shopMoney: { amount: "12.00", currencyCode: "USD" } },
                  },
                },
                { node: { id: "o2", totalPriceSet: {} } },
                { node: { id: "o3", totalPriceSet: "nope" } },
                { node: "not-a-row" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        body: {
          data: {
            productVariants: {
              edges: [{ node: { id: "v1", product: { id: "p1", title: "Hat" } } }, { node: { id: "v2", product: {} } }],
              pageInfo: {},
            },
          },
        },
      },
      {
        body: {
          data: {
            collections: {
              edges: [{ node: { id: "c1", productsCount: { count: 3 } } }, { node: { id: "c2", productsCount: {} } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
      { body: page([]) },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    const counted = await provider.query("SELECT COUNT(*) AS orders FROM orders");
    expect(counted.rows).toEqual([{ orders: 4 }]);
    const orders = await provider.query("SELECT id, totalPrice, currencyCode FROM orders");
    expect(orders.rows[0]).toEqual({ id: "o1", totalPrice: "12.00", currencyCode: "USD" });
    expect(orders.rows[1]).toEqual({ id: "o2", totalPrice: null, currencyCode: null });
    expect(orders.rows[3]).toEqual({ id: null, totalPrice: null, currencyCode: null });
    const variants = await provider.query("SELECT productId, productTitle FROM variants");
    expect(variants.rows[0]).toEqual({ productId: "p1", productTitle: "Hat" });
    expect(variants.rows[1]).toEqual({ productId: null, productTitle: null });
    const collections = await provider.query("SELECT productsCount FROM collections");
    expect(collections.rows).toEqual([{ productsCount: 3 }, { productsCount: null }]);
    const empty = await provider.query("SELECT * FROM products");
    expect(empty.fields).toEqual(SHOPIFY_TABLES[0]?.columns.map((column) => column.name));
    expect(empty.rows).toEqual([]);
  });

  test("refuses parameters, a write, a bad cursor, and a query before connect", async () => {
    const transport = scripted([
      { body: shop },
      { body: page([{ id: "1" }], true, "bad cursor") },
      { body: page([{ id: "1" }], true, null) },
      { body: page([{ id: "2", title: "Ok" }]) },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/Not connected/);
    await expect(provider.query("SELECT id FROM products", [1])).rejects.toThrow(/does not bind/);
    await provider.connect();
    await expect(provider.query("DELETE FROM products")).rejects.toThrow(/read-only/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/cursor/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/cursor/);
    await expect(provider.query("SELECT id FROM products", [])).resolves.toMatchObject({ rows: [{ id: "2" }] });
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
    const transport = scripted([{ body: shop }, ...cases, { body: page([]) }]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    await expect(provider.query("SELECT id FROM products")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(provider.query("SELECT id FROM products")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/limiting requests/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/redirect/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/refused the query/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/not JSON/);
    try {
      await provider.query("SELECT id FROM products");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("Shopify refused the query");
    }
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/larger than 2 MB/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/redirect/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/larger than 2 MB/);
    try {
      await provider.query("SELECT id FROM products");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/kept/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/could not be reached/);
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

  test("lists the shop, describes tables, and refuses a bad bulk limit", async () => {
    const transport = scripted([{ body: shop }]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await expect(provider.listContainers()).rejects.toThrow(/Not connected/);
    await expect(provider.getOverview()).rejects.toThrow(/Not connected/);
    await provider.connect();
    expect(await provider.listContainers()).toEqual([{ path: ["shop"], name: "shop", level: 0 }]);
    expect(await provider.listContainers(["shop"])).toEqual([]);
    expect(await provider.listContainers([])).toEqual([{ path: ["shop"], name: "shop", level: 0 }]);
    expect(await provider.countObjects(["shop"])).toEqual({ table: { count: SHOPIFY_TABLES.length } });
    await expect(provider.countObjects([])).rejects.toThrow(QueryError);
    const objects = await provider.listObjects(["shop"], "table");
    expect(objects.map((object) => object.name)).toEqual(SHOPIFY_TABLES.map((table) => table.name));
    await expect(provider.listObjects(["shop"], "view")).rejects.toThrow(/object kind/);
    const described = await provider.describeObject(["shop", "products"], "table");
    expect(described.columns[0]).toMatchObject({ name: "id", nullable: false });
    expect(described.columns[1]?.nullable).toBe(true);
    await expect(provider.describeObject(["shop", "missing"], "table")).rejects.toThrow(/no table/);
    const batch = await provider.describeObjects(["shop"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(await provider.describeObjects(["shop"], "table")).toMatchObject({ details: expect.any(Array) });
    await expect(provider.describeObjects(["shop"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(provider.describeObjects(["shop"], "table", 1.5)).rejects.toThrow(/1\.5/);
    expect(await provider.getHealth()).toMatchObject({ databaseSize: "N/A" });
    await expect(provider.runMaintenance()).rejects.toThrow(/no maintenance/);
    expect(await provider.getOverview()).toMatchObject({ version: "Shopify Admin API 2025-10", tableCount: 5 });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("refuses a count and a page the answer did not shape", async () => {
    const transport = scripted([
      { body: shop },
      { body: { data: {} } },
      { body: { data: { productsCount: { count: "4" } } } },
      { body: { nope: true } },
      { body: { data: { products: { edges: "nope" } } } },
    ]);
    const provider = new ShopifyProvider(connection, {}, transport.createTransport);
    await provider.connect();
    await expect(provider.query("SELECT COUNT(*) FROM products")).rejects.toThrow(/did not return a count/);
    await expect(provider.query("SELECT COUNT(*) FROM products")).rejects.toThrow(/did not return a count/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/did not list rows/);
    await expect(provider.query("SELECT id FROM products")).rejects.toThrow(/did not list rows/);
  });
});
