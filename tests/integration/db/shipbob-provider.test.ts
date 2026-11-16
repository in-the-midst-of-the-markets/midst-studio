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
import { ShipBobProvider, shipbobChannelId, shipbobHost, shipbobToken } from "@/lib/db/providers/sql/shipbob";
import type { DatabaseConnection } from "@/lib/types";

const TOKEN = "shipbob-personal-access-token";

const connection = {
  id: "shipbob",
  name: "shipbob",
  type: "shipbob",
  user: "census",
  password: TOKEN,
  database: "census",
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

const channels = { items: [{ id: 9, name: "Shop", application_name: "Custom" }, "skip"] };
const order = {
  id: 15,
  order_number: "SO-1",
  reference_id: "Ref 1",
  status: "Fulfilled",
  type: "DTC",
  created_date: "2024-07-18T00:00:00Z",
  purchase_date: "2024-07-17T00:00:00Z",
  shipping_method: "Ground",
  recipient: { name: "Ada", address: { city: "Austin", country: "US" } },
  channel: { id: 9 },
};

describe("ShipBobProvider", () => {
  test("sends the token only to the two ShipBob hosts", () => {
    expect(() => new ShipBobProvider(connection)).not.toThrow();
    expect(shipbobHost(connection)).toBe("api.shipbob.com");
    expect(shipbobHost({ host: " https://API.SHIPBOB.COM/2026-07 " })).toBe("api.shipbob.com");
    expect(shipbobHost({ host: "sandbox-api.shipbob.com" })).toBe("sandbox-api.shipbob.com");
    expect(shipbobToken(connection)).toBe(TOKEN);
    expect(shipbobToken({ password: "a".repeat(1017) })).toHaveLength(1017);
    expect(shipbobChannelId(connection)).toBeNull();
    expect(shipbobChannelId({ database: " 42 " })).toBe("42");
    expect(shipbobChannelId({ database: "0" })).toBeNull();
    expect(shipbobChannelId({ database: "01" })).toBeNull();
    expect(shipbobChannelId({ database: undefined })).toBeNull();
    const refused = (config: DatabaseConnection, secret: string): string => {
      try {
        new ShipBobProvider(config);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(secret);
        return message;
      }
      throw new Error("expected a refusal");
    };
    const underShipBob = "The API host must be a host under shipbob.com. The access token is sent only there.";
    expect(refused({ ...connection, host: "files.shipbob.com" }, "files.shipbob.com")).toBe(
      "The API host must be api.shipbob.com or sandbox-api.shipbob.com. The access token is sent only there.",
    );
    expect(refused({ ...connection, host: "evil.example" }, "evil.example")).toBe(underShipBob);
    expect(refused({ ...connection, host: "https://user:secret@api.shipbob.com" }, "secret")).toBe(underShipBob);
    expect(refused({ ...connection, host: "api.shipbob.com:8443" }, "8443")).toBe(underShipBob);
    expect(refused({ ...connection, password: "  " }, TOKEN)).toMatch(/required/);
    expect(refused({ ...connection, password: "has space" }, "has space")).toMatch(/printable/);
    expect(refused({ ...connection, password: "a".repeat(1025) }, "a".repeat(1025))).toMatch(/printable/);
    expect(refused({ ...connection, password: "b".repeat(1018) }, "b".repeat(1018))).toMatch(/too long/);
  });

  test("connects, lists the account, and closes the transport", async () => {
    const pages = scripted([{ body: channels }]);
    const opened = new ShipBobProvider({ ...connection, database: "42" }, {}, pages.createTransport);
    await opened.connect();
    await opened.connect();
    expect(pages.requests).toHaveLength(1);
    expect(pages.requests[0]?.method).toBe("GET");
    expect(pages.requests[0]?.url).toContain("https://api.shipbob.com/2026-07/channel");
    expect(pages.requests[0]?.headers.shipbob_channel_id).toBe("42");
    expect(pages.options[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(pages.options[0]?.requestHeaderNames).toEqual(["shipbob_channel_id"]);
    expect(pages.options[0]?.refusesLinkLocal).toBe(true);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.listContainers()).toEqual([{ path: ["fulfillment"], name: "fulfillment", level: 0 }]);
    expect(await opened.listContainers(["other"])).toEqual([]);
    expect(await opened.countObjects(["fulfillment"])).toEqual({ table: { count: 4 } });
    const objects = await opened.listObjects(["fulfillment"], "table");
    expect(objects.map((object) => object.name)).toEqual(["Order", "Product", "Inventory", "Channel"]);
    const described = await opened.describeObject(["fulfillment", "order"], "table");
    expect(described.columns[0]?.name).toBe("Id");
    const batch = await opened.describeObjects(["fulfillment"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect((await opened.describeObjects(["fulfillment"], "table")).details).toHaveLength(4);
    expect(await opened.getOverview()).toMatchObject({ version: "ShipBob API 2026-07", tableCount: 4 });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.describeObject(["fulfillment", "Missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["fulfillment"], "view")).rejects.toThrow(/object kind/);
    await expect(opened.describeObjects(["fulfillment"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.query("INSERT INTO Channel (Id) VALUES (1)")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT Id FROM Channel", [1])).rejects.toThrow(/bind parameters/);
    await opened.disconnect();
    await expect(opened.query("SELECT Id FROM Channel")).rejects.toThrow(/Not connected/);
    await expect(opened.listContainers()).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(pages.closed).toBe(1);
  });

  test("reads an order page and warns when the page is full", async () => {
    const pages = scripted([
      { body: channels },
      { body: [order, { id: "no-recipient" }, null, "skip"] },
      { body: [order] },
      { body: [order] },
    ]);
    const opened = new ShipBobProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const listed = await opened.query(
      "SELECT Id, OrderNumber, RecipientName, RecipientCity, ChannelId FROM \"Order\" WHERE Id = 15 AND SortOrder = 'Oldest' LIMIT 500",
    );
    expect(listed.rows[0]).toEqual({
      Id: "15",
      OrderNumber: "SO-1",
      RecipientName: "Ada",
      RecipientCity: "Austin",
      ChannelId: "9",
    });
    expect(listed.rows[1]).toEqual({
      Id: "no-recipient",
      OrderNumber: null,
      RecipientName: null,
      RecipientCity: null,
      ChannelId: null,
    });
    expect(listed.rows).toHaveLength(2);
    expect(listed.warnings?.map((warning) => warning.message).join(" ")).toMatch(/at most 100/);
    expect(pages.requests[1]?.url).toContain("Page=1");
    expect(pages.requests[1]?.url).toContain("Limit=100");
    expect(pages.requests[1]?.url).toContain("IDs=15");
    expect(pages.requests[1]?.url).toContain("SortOrder=Oldest");
    expect(pages.requests[1]?.headers.shipbob_channel_id).toBeUndefined();
    const short = await opened.query('SELECT Id FROM "Order" LIMIT 10');
    expect(short.rows).toHaveLength(1);
    expect(short.warnings).toBeUndefined();
    const later = await opened.query('SELECT Id FROM "Order" LIMIT 100 OFFSET 100');
    expect(pages.requests[3]?.url).toContain("Page=2");
    expect(later.rows).toHaveLength(1);
    expect(later.warnings).toBeUndefined();
    await opened.disconnect();
  });

  test("walks a product cursor and an inventory page", async () => {
    const host = "https://sandbox-api.shipbob.com/2026-07/product";
    const pages = scripted([
      { body: channels },
      {
        body: {
          items: [
            {
              id: 3,
              name: "Widget",
              type: "Good",
              created_on: "2024-07-01",
              variants: [{ id: 8, sku: "WIDGET", status: "Active" }],
            },
            { id: 4 },
          ],
          next: `${host}?cursor=page-2`,
        },
      },
      { body: { items: [{ id: 1 }], next: `${host}?cursor=page-2` } },
      { body: { items: [{ id: 5, name: "Spare", variants: [] }], next: "" } },
      { body: { items: [], next: "" } },
      {
        body: {
          items: [
            {
              inventory_id: 7,
              name: "Widget",
              sku: "WIDGET",
              total_fulfillable_quantity: 4,
              total_on_hand_quantity: "nope",
            },
          ],
        },
      },
      { body: [] },
    ]);
    const opened = new ShipBobProvider({ ...connection, host: "sandbox-api.shipbob.com" }, {}, pages.createTransport);
    await opened.connect();
    const products = await opened.query(
      "SELECT Id, Name, Sku, VariantStatus FROM Product WHERE SKU = 'WIDGET' LIMIT 2",
    );
    expect(products.rows[0]).toEqual({ Id: "3", Name: "Widget", Sku: "WIDGET", VariantStatus: "Active" });
    expect(products.rows[1]).toEqual({ Id: "4", Name: null, Sku: null, VariantStatus: null });
    expect(products.warnings?.[0]?.message).toMatch(/next page/);
    expect(pages.requests[1]?.url).toContain("https://sandbox-api.shipbob.com/2026-07/product?");
    expect(pages.requests[1]?.url).toContain("SKU=WIDGET");
    const second = await opened.query("SELECT Id, Name FROM Product LIMIT 2 OFFSET 2");
    expect(second.rows).toEqual([{ Id: "5", Name: "Spare" }]);
    expect(pages.requests[3]?.url).toContain("cursor=page-2");
    expect(second.warnings).toBeUndefined();
    const empty = await opened.query("SELECT Id FROM Product LIMIT 2 OFFSET 2");
    expect(empty.rows).toEqual([]);
    const stock = await opened.query("SELECT InventoryId, Fulfillable, OnHand FROM Inventory WHERE IsActive = true");
    expect(stock.rows).toEqual([{ InventoryId: "7", Fulfillable: 4, OnHand: null }]);
    await expect(opened.query("SELECT Id FROM Product")).rejects.toThrow(/not a JSON object/);
    await opened.disconnect();
  });

  test("slices channels, counts them, and refuses a foreign page link", async () => {
    const many = {
      items: [
        { id: 1, name: "One", application_name: "App" },
        { id: 2, name: "Two" },
      ],
    };
    const pages = scripted([
      { body: channels },
      { body: many },
      { body: many },
      { body: { items: many.items } },
      { body: { items: "nope" } },
      { body: { next: 4, items: [] } },
      { body: { next: "http://[", items: [] } },
      { body: { next: "https://user:pass@api.shipbob.com/2026-07/product", items: [] } },
      { body: { next: "http://api.shipbob.com/2026-07/product", items: [] } },
      { body: { next: "https://evil.example/2026-07/product", items: [] } },
      { body: { next: "https://api.shipbob.com/other", items: [] } },
      { body: { next: "https://api.shipbob.com/2026-07/product?bad-key=1", items: [] } },
      { body: { next: `https://api.shipbob.com/2026-07/product?cursor=${"c".repeat(501)}`, items: [] } },
      { body: { next: "https://api.shipbob.com/2026-07/product?cursor=%0A", items: [] } },
    ]);
    const opened = new ShipBobProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const listed = await opened.query("SELECT Id, Name, ApplicationName FROM Channel LIMIT 1 OFFSET 1");
    expect(listed.rows).toEqual([{ Id: "2", Name: "Two", ApplicationName: null }]);
    expect(listed.warnings?.[0]?.message).toMatch(/next page/);
    const counted = await opened.query("SELECT COUNT(*) AS channels FROM Channel");
    expect(counted.rows).toEqual([{ channels: 2 }]);
    const all = await opened.query("SELECT Id FROM Channel");
    expect(all.rows).toHaveLength(2);
    expect(all.warnings).toBeUndefined();
    await expect(opened.query("SELECT Id FROM Channel")).rejects.toThrow(/not a list/);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each link is a later page of the same scripted queue.
        await opened.query("SELECT Id FROM Product LIMIT 1 OFFSET 1");
        throw new Error("expected the page link to be refused");
      } catch (error) {
        expect(error).toBeInstanceOf(QueryError);
        const message = error instanceof Error ? error.message : "";
        expect(message).toMatch(/page link/);
        expect(message).not.toContain("evil.example");
        expect(message).not.toContain("user:pass");
      }
    }
    await opened.disconnect();
  });

  test("maps API failures and keeps the token out of the message", async () => {
    const connectCases: { pages: ScriptedPage[]; error: unknown; message: RegExp }[] = [
      { pages: [{ status: 401, text: "no" }], error: AuthenticationError, message: /access token/ },
      { pages: [{ status: 403, text: "no" }], error: PermissionDeniedError, message: /refused/ },
      { pages: [{ status: 429, text: "slow" }], error: ConnectionError, message: /slow down/ },
      { pages: [{ status: 302, text: "away" }], error: ConnectionError, message: /redirect/ },
      { pages: [{ status: 500, text: `boom ${TOKEN}` }], error: ConnectionError, message: /••••/ },
      { pages: [{ text: "" }], error: ConnectionError, message: /not JSON/ },
      { pages: [{ text: "not-json" }], error: ConnectionError, message: /not JSON/ },
      {
        pages: [{ throw: new TransportError("redirect", "https://evil.example") }],
        error: ConnectionError,
        message: /redirect/,
      },
      { pages: [{ throw: new TransportError("too-large", "big") }], error: QueryError, message: /2 MB/ },
      { pages: [{ throw: new TransportError("tls", `pin ${TOKEN}`) }], error: ConnectionError, message: /••••/ },
      { pages: [{ throw: new DatabaseConfigError("kept", "shipbob") }], error: DatabaseConfigError, message: /kept/ },
      { pages: [{ throw: new Error(`socket ${TOKEN}`) }], error: ConnectionError, message: /••••/ },
      { pages: [{ throw: "down" }], error: ConnectionError, message: /could not be reached/ },
    ];
    for (const entry of connectCases) {
      const script = scripted(entry.pages);
      const provider = new ShipBobProvider(connection, {}, script.createTransport);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is a fresh connection, and the queue is one page deep.
        await provider.connect();
        throw new Error("expected connect to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(entry.error);
        const message = error instanceof Error ? error.message : "";
        expect(message).toMatch(entry.message);
        expect(message).not.toContain(TOKEN);
      }
      expect(script.closed).toBe(1);
    }

    const pages = scripted([
      { body: channels },
      { status: 401, text: "no" },
      { status: 403, text: "no" },
      { status: 429, text: "slow" },
      { status: 302, text: "away" },
      { status: 500, text: `failed ${TOKEN}` },
      { text: "" },
      { text: "not-json" },
      { body: { items: [] }, text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${TOKEN}`) },
      { throw: new DatabaseConfigError("kept", "shipbob") },
      { throw: new Error("reset") },
      { throw: "down" },
      { body: "nope" },
    ]);
    const opened = new ShipBobProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const sql = 'SELECT Id FROM "Order"';
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
