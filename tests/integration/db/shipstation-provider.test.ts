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
import {
  ShipStationProvider,
  shipstationApiKey,
  shipstationApiSecret,
  shipstationAuthorization,
  shipstationHost,
} from "@/lib/db/providers/sql/shipstation";
import type { DatabaseConnection } from "@/lib/types";

const KEY = "shipstation-api-key";
const SECRET = "shipstation-api-secret";

const connection = {
  id: "shipstation",
  name: "shipstation",
  type: "shipstation",
  user: KEY,
  password: SECRET,
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
  requests: { url: string; method: string; headers: Record<string, string> }[];
  options: NodeTransportOptions[];
  closed: number;
} {
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  const state: { options: NodeTransportOptions[]; closed: number } = { options: [], closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options.push(options);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, headers: { ...request.headers } });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
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

const stores = [
  { storeId: 11, storeName: "Main", marketplaceName: "Shopify", active: true, companyName: "Ada Co" },
  { storeId: "12", storeName: "Spare" },
];

describe("ShipStationProvider", () => {
  test("sends the key and secret only to the V1 host", () => {
    expect(() => new ShipStationProvider(connection)).not.toThrow();
    expect(shipstationHost(connection)).toBe("ssapi.shipstation.com");
    expect(shipstationHost({ host: " https://SSAPI.SHIPSTATION.COM/orders " })).toBe("ssapi.shipstation.com");
    expect(shipstationApiKey(connection)).toBe(KEY);
    expect(shipstationApiSecret(connection)).toBe(SECRET);
    expect(shipstationAuthorization(connection)).toBe(
      `Basic ${Buffer.from(`${KEY}:${SECRET}`, "utf8").toString("base64")}`,
    );
    const refused = (config: DatabaseConnection, secret: string): string => {
      try {
        new ShipStationProvider(config);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(secret);
        return message;
      }
      throw new Error("expected a refusal");
    };
    expect(refused({ ...connection, host: "api.shipstation.com" }, "v2.shipstation.com")).toBe(
      "The API host must be ssapi.shipstation.com. The API secret is sent only there.",
    );
    const underShipStation = "The API host must be a host under shipstation.com. The access token is sent only there.";
    expect(refused({ ...connection, host: "evil.example" }, "evil.example")).toBe(underShipStation);
    expect(refused({ ...connection, host: "https://user:secret@ssapi.shipstation.com" }, "secret")).toBe(
      underShipStation,
    );
    expect(refused({ ...connection, user: "  " }, KEY)).toMatch(/required/);
    expect(refused({ ...connection, password: "" }, SECRET)).toMatch(/required/);
    expect(refused({ ...connection, user: "key:with-colon" }, "key:with-colon")).toMatch(/colon/);
    expect(refused({ ...connection, user: "has space" }, "has space")).toMatch(/printable/);
    expect(refused({ ...connection, password: "s".repeat(201) }, "s".repeat(201))).toMatch(/printable/);
  });

  test("connects, lists the account, and closes the transport", async () => {
    const pages = scripted([{ body: stores }]);
    const opened = new ShipStationProvider(connection, {}, pages.createTransport);
    await opened.connect();
    await opened.connect();
    expect(pages.requests).toHaveLength(1);
    expect(pages.requests[0]?.url).toContain("https://ssapi.shipstation.com/stores");
    expect(pages.options[0]?.headers.authorization).toBe(shipstationAuthorization(connection));
    expect(pages.options[0]?.refusesUpgrade).toBe(true);
    expect(opened.getCapabilities().supportsMaintenance).toBe(false);
    expect(opened.getLabels().entityNamePlural).toBe("Tables");
    expect(await opened.listContainers()).toEqual([{ path: ["shipping"], name: "shipping", level: 0 }]);
    expect(await opened.listContainers(["other"])).toEqual([]);
    expect(await opened.countObjects(["shipping"])).toEqual({ table: { count: 4 } });
    expect((await opened.listObjects(["shipping"], "table")).map((object) => object.name)).toEqual([
      "Order",
      "Shipment",
      "Product",
      "Store",
    ]);
    expect((await opened.describeObject(["shipping", "Store"], "table")).columns[0]?.name).toBe("StoreId");
    expect((await opened.describeObjects(["shipping"], "table", 2)).details).toHaveLength(2);
    expect((await opened.describeObjects(["shipping"], "table")).details).toHaveLength(4);
    expect(await opened.getOverview()).toMatchObject({ version: "ShipStation API V1", tableCount: 4 });
    expect(await opened.getHealth()).toMatchObject({ cacheHitRatio: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.describeObject(["shipping", "Missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObjects(["shipping"], "view")).rejects.toThrow(/object kind/);
    await expect(opened.describeObjects(["shipping"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.query("DELETE FROM Store")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT StoreId FROM Store", ["x"])).rejects.toThrow(/bind parameters/);
    await opened.disconnect();
    await expect(opened.query("SELECT StoreId FROM Store")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(pages.closed).toBe(1);
  });

  test("reads orders, shipments, products, stores and counts", async () => {
    const order = {
      orderId: 900,
      orderNumber: "100",
      orderDate: "2024-07-18",
      createDate: "2024-07-18",
      orderStatus: "awaiting_shipment",
      customerEmail: "ada@example.com",
      orderTotal: 19.5,
      amountPaid: 19.5,
      taxAmount: 1,
      shippingAmount: 2,
      storeId: 11,
      carrierCode: "ups",
      shipTo: { name: "Ada", city: "Austin", country: "US" },
    };
    const pages = scripted([
      { body: { stores } },
      { body: { orders: [order, null, "skip"], total: 2, page: 1, pages: 1 } },
      { body: { orders: [{ orderId: 901 }], total: 40, pages: 2 } },
      {
        body: {
          shipments: [
            {
              shipmentId: 3,
              orderId: 900,
              orderNumber: "100",
              shipDate: "2024-07-02",
              trackingNumber: "1Z",
              carrierCode: "ups",
              serviceCode: "ground",
              shipmentCost: 4.25,
              voided: false,
              shipTo: { name: "Ada", city: "Austin", country: "US" },
            },
          ],
          total: 1,
          pages: 1,
        },
      },
      {
        body: {
          products: [{ productId: 8, sku: "BEAU-000", name: "Beau", price: 12, active: true }],
          total: 1,
          pages: 1,
        },
      },
      { body: stores },
      { body: { stores } },
      { body: { stores: null } },
      { body: { total: 42 } },
      { body: { orders: [] } },
      { body: { total: Number.POSITIVE_INFINITY } },
      { body: stores },
      { body: 4 },
    ]);
    const opened = new ShipStationProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const listed = await opened.query(
      "SELECT OrderId, OrderNumber, OrderTotal, ShipToName, ShipToCity FROM \"Order\" WHERE OrderStatus = 'awaiting_shipment' LIMIT 900",
    );
    expect(listed.rows[0]).toEqual({
      OrderId: "900",
      OrderNumber: "100",
      OrderTotal: 19.5,
      ShipToName: "Ada",
      ShipToCity: "Austin",
    });
    expect(listed.rows).toHaveLength(1);
    expect(listed.warnings?.map((warning) => warning.message).join(" ")).toMatch(/at most 500/);
    expect(pages.requests[1]?.url).toContain("/orders?");
    expect(pages.requests[1]?.url).toContain("orderStatus=awaiting_shipment");
    expect(pages.requests[1]?.url).toContain("page=1");
    expect(pages.requests[1]?.url).toContain("pageSize=500");
    const later = await opened.query('SELECT OrderId FROM "Order" LIMIT 1 OFFSET 1');
    expect(later.rows).toEqual([{ OrderId: "901" }]);
    expect(pages.requests[2]?.url).toContain("page=2");
    expect(later.warnings?.[0]?.message).toMatch(/next page/);
    const shipment = await opened.query(
      "SELECT ShipmentId, TrackingNumber, ShipmentCost, Voided, ShipToCountry FROM Shipment WHERE ShipDateStart = '2024-07-01'",
    );
    expect(shipment.rows).toEqual([
      { ShipmentId: "3", TrackingNumber: "1Z", ShipmentCost: 4.25, Voided: "false", ShipToCountry: "US" },
    ]);
    expect(shipment.warnings).toBeUndefined();
    const product = await opened.query("SELECT * FROM Product WHERE SKU = 'BEAU-000' LIMIT 10");
    expect(product.rows[0]).toMatchObject({ ProductId: "8", Sku: "BEAU-000", Active: "true", Price: 12 });
    const sliced = await opened.query("SELECT StoreId, StoreName, Active FROM Store LIMIT 1");
    expect(sliced.rows).toEqual([{ StoreId: "11", StoreName: "Main", Active: "true" }]);
    expect(sliced.warnings?.[0]?.message).toMatch(/next page/);
    const wrapped = await opened.query("SELECT StoreId, CompanyName FROM Store OFFSET 1");
    expect(wrapped.rows).toEqual([{ StoreId: "12", CompanyName: null }]);
    const none = await opened.query("SELECT StoreId FROM Store");
    expect(none.rows).toEqual([]);
    const counted = await opened.query("SELECT COUNT(*) AS total FROM \"Order\" WHERE OrderStatus = 'shipped'");
    expect(counted.rows).toEqual([{ total: 42 }]);
    expect(pages.requests[8]?.url).toContain("pageSize=1");
    const missing = await opened.query("SELECT COUNT(*) FROM Shipment");
    expect(missing.rows).toEqual([{ totalCount: 0 }]);
    const infinite = await opened.query("SELECT COUNT(*) AS n FROM Product");
    expect(infinite.rows).toEqual([{ n: 0 }]);
    const storesCounted = await opened.query("SELECT COUNT(*) AS stores FROM Store");
    expect(storesCounted.rows).toEqual([{ stores: 2 }]);
    await expect(opened.query("SELECT Sku FROM Product")).rejects.toThrow(/not a JSON object/);
    await opened.disconnect();
  });

  test("maps API failures and keeps the secret out of the message", async () => {
    const connectCases: { pages: ScriptedPage[]; error: unknown; message: RegExp }[] = [
      { pages: [{ status: 401, text: "no" }], error: AuthenticationError, message: /API key/ },
      { pages: [{ status: 403, text: "no" }], error: PermissionDeniedError, message: /refused/ },
      { pages: [{ status: 429, text: "slow" }], error: ConnectionError, message: /slow down/ },
      { pages: [{ status: 302, text: "away" }], error: ConnectionError, message: /redirect/ },
      { pages: [{ status: 500, text: `boom ${SECRET}` }], error: ConnectionError, message: /••••/ },
      { pages: [{ text: "" }], error: ConnectionError, message: /not JSON/ },
      { pages: [{ text: "not-json" }], error: ConnectionError, message: /not JSON/ },
      {
        pages: [{ throw: new TransportError("redirect", "https://evil.example") }],
        error: ConnectionError,
        message: /redirect/,
      },
      { pages: [{ throw: new TransportError("too-large", "big") }], error: QueryError, message: /2 MB/ },
      { pages: [{ throw: new TransportError("network", `down ${SECRET}`) }], error: ConnectionError, message: /••••/ },
      {
        pages: [{ throw: new DatabaseConfigError("kept", "shipstation") }],
        error: DatabaseConfigError,
        message: /kept/,
      },
      { pages: [{ throw: new Error(`socket ${SECRET}`) }], error: ConnectionError, message: /••••/ },
      { pages: [{ throw: "down" }], error: ConnectionError, message: /could not be reached/ },
    ];
    for (const entry of connectCases) {
      const script = scripted(entry.pages);
      const provider = new ShipStationProvider(connection, {}, script.createTransport);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is a fresh connection, and the queue is one page deep.
        await provider.connect();
        throw new Error("expected connect to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(entry.error);
        const message = error instanceof Error ? error.message : "";
        expect(message).toMatch(entry.message);
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain(KEY);
      }
      expect(script.closed).toBe(1);
    }

    const pages = scripted([
      { body: stores },
      { status: 401, text: "no" },
      { status: 403, text: "no" },
      { status: 429, text: "slow" },
      { status: 302, text: "away" },
      { status: 500, text: `failed ${SECRET}` },
      { text: "" },
      { text: "not-json" },
      { text: "y".repeat(API_ANSWER_LIMIT + 1) },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("tls", `pin ${SECRET}`) },
      { throw: new DatabaseConfigError("kept", "shipstation") },
      { throw: new Error("reset") },
      { throw: "down" },
      { body: { products: "nope" } },
    ]);
    const opened = new ShipStationProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const sql = "SELECT Sku FROM Product";
    await expect(opened.query(sql)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query(sql)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query(sql)).rejects.toThrow(/slow down/);
    await expect(opened.query(sql)).rejects.toThrow(/redirect/);
    await expect(opened.query(sql)).rejects.toThrow(/••••/);
    await expect(opened.query(sql)).rejects.toThrow(/not JSON/);
    await expect(opened.query(sql)).rejects.toThrow(/not JSON/);
    await expect(opened.query(sql)).rejects.toThrow(/2 MB/);
    await expect(opened.query(sql)).rejects.toThrow(/redirect/);
    await expect(opened.query(sql)).rejects.toThrow(/2 MB/);
    await expect(opened.query(sql)).rejects.toThrow(/••••/);
    await expect(opened.query(sql)).rejects.toThrow(/kept/);
    await expect(opened.query(sql)).rejects.toThrow(/reset/);
    await expect(opened.query(sql)).rejects.toThrow(/could not be reached/);
    await expect(opened.query(sql)).rejects.toThrow(/not a list/);
    await opened.disconnect();
  });
});
