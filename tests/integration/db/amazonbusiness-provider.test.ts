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
  AmazonBusinessProvider,
  amazonBusinessBuyerEmail,
  amazonBusinessClientId,
  amazonBusinessClientSecret,
  amazonBusinessHost,
  amazonBusinessRefreshToken,
} from "@/lib/db/providers/sql/amazonbusiness";
import { AMAZON_BUSINESS_RESOURCES } from "@/lib/db/providers/sql/amazonbusiness/translate";
import type { DatabaseConnection } from "@/lib/types";

const CLIENT = "amzn1.application-oa2-client.census";
const SECRET = "amazon-client-secret-value";
const REFRESH = "Atzr|amazon-refresh-token-value";
const EMAIL = "buyer@example.com";
const TOKEN = "Atza|amazon-access-token-value";

const connection = {
  id: "amazonbusiness",
  name: "amazonbusiness",
  type: "amazonbusiness",
  user: CLIENT,
  password: SECRET,
  database: REFRESH,
  schema: EMAIL,
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
  requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    form: Record<string, string> | undefined;
  }[];
  options: NodeTransportOptions[];
  closed: number;
} {
  const requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    form: Record<string, string> | undefined;
  }[] = [];
  const state: { options: NodeTransportOptions[]; closed: number } = { options: [], closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options.push(options);
    return {
      async request(request: NodeRequest) {
        requests.push({
          url: request.url,
          method: request.method,
          headers: { ...request.headers },
          form: request.form === undefined ? undefined : { ...request.form },
        });
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

const grant = { access_token: TOKEN, expires_in: 3600 };
const product = {
  asin: "B06XC9321S",
  title: "Paper",
  asinType: "STANDARD",
  includedDataTypes: {
    OFFERS: [
      {
        availability: "In Stock.",
        price: { value: { amount: 37.24, currencyCode: "USD" } },
        merchant: { name: "Amazon" },
        productCondition: "New",
        offerId: "offer-1",
      },
    ],
  },
};

describe("AmazonBusinessProvider", () => {
  test("requires printable credentials and one of the three regional hosts", () => {
    expect(() => new AmazonBusinessProvider(connection)).not.toThrow();
    expect(() => new AmazonBusinessProvider({ ...connection, schema: undefined })).not.toThrow();
    expect(amazonBusinessHost(connection)).toBe("na.business-api.amazon.com");
    expect(amazonBusinessHost({ ...connection, host: " https://EU.BUSINESS-API.AMAZON.COM/products " })).toBe(
      "eu.business-api.amazon.com",
    );
    expect(amazonBusinessHost({ ...connection, host: "   " })).toBe("na.business-api.amazon.com");
    expect(amazonBusinessClientId(connection)).toBe(CLIENT);
    expect(amazonBusinessClientSecret(connection)).toBe(SECRET);
    expect(amazonBusinessRefreshToken(connection)).toBe(REFRESH);
    expect(amazonBusinessBuyerEmail(connection)).toBe(EMAIL);
    expect(() => new AmazonBusinessProvider({ ...connection, user: "  " })).toThrow(/client id/);
    expect(() => new AmazonBusinessProvider({ ...connection, password: "" })).toThrow(/client secret/);
    expect(() => new AmazonBusinessProvider({ ...connection, database: "" })).toThrow(/refresh token/);
    expect(() => amazonBusinessBuyerEmail({ ...connection, schema: "" })).toThrow(/email/);
    const injected = `${SECRET}\r\nX-Injected: 1`;
    expect(() => amazonBusinessClientSecret({ ...connection, password: injected })).toThrow(/single line/);
    try {
      amazonBusinessClientId({ ...connection, user: `${CLIENT}\nX: 1` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain(CLIENT);
    }
    expect(() => amazonBusinessClientId({ ...connection, user: "x".repeat(257) })).toThrow(/single line/);
    expect(() => amazonBusinessRefreshToken({ ...connection, database: "x".repeat(4097) })).toThrow(/single line/);
    expect(() => amazonBusinessBuyerEmail({ ...connection, schema: "x".repeat(321) })).toThrow(/single line/);
    for (const host of ["evil.example", "files.business-api.amazon.com", `https://${SECRET}@evil.example`]) {
      expect(() => new AmazonBusinessProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        amazonBusinessHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("business-api.amazon.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain(SECRET);
      }
    }
  });

  test("exchanges the refresh token once and reads the buying lists", async () => {
    const probe = scripted([{ body: grant }]);
    const opened = new AmazonBusinessProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.method).toBe("POST");
    expect(probe.requests[0]?.url).toBe("https://api.amazon.com/auth/O2/token");
    expect(probe.requests[0]?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: CLIENT,
      client_secret: SECRET,
    });
    expect(probe.options[0]?.origin).toEqual({ scheme: "https", host: "api.amazon.com", port: 443 });
    expect(probe.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "api.amazon.com" });
    expect(probe.options[0]?.refusesLinkLocal).toBe(true);
    expect(probe.options[0]?.refusesUpgrade).toBe(true);
    expect(await opened.listContainers()).toEqual([{ path: ["buying"], name: "buying", level: 0 }]);
    expect(await opened.listContainers(["buying"])).toEqual([]);
    expect(await opened.countObjects(["buying"])).toEqual({ table: { count: AMAZON_BUSINESS_RESOURCES.length } });
    const names = (await opened.listObjects(["buying"], "table")).map((object) => object.name);
    expect(names).toEqual(["Product", "Order", "LineItem", "Transaction"]);
    const detail = await opened.describeObject(["buying", "product"], "table");
    expect(detail.columns[0]).toMatchObject({ name: "ASIN", nullable: true, isPrimary: false });
    expect(detail.foreignKeys).toEqual([]);
    expect((await opened.describeObjects(["buying"], "table")).details).toHaveLength(AMAZON_BUSINESS_RESOURCES.length);
    expect((await opened.describeObjects(["buying"], "table", 1)).details).toHaveLength(1);
    await expect(opened.describeObjects(["buying"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["buying"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["buying", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObject(["other"], "table")).rejects.toThrow();
    await expect(opened.countObjects(["other", "extra"])).rejects.toThrow();
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getCapabilities().containerPathShapes).toBe("exact");
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({ version: "Amazon Business API", tableCount: 4 });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO Product (ASIN) VALUES ('A')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT ASIN FROM Product WHERE Keywords = 'paper'", ["paper"])).rejects.toThrow(
      /bind parameters/,
    );
    await opened.disconnect();
    await expect(opened.query("SELECT ASIN FROM Product WHERE Keywords = 'paper'")).rejects.toThrow(/Not connected/);
    await expect(opened.listContainers()).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(probe.closed).toBe(1);
  });

  test("searches products, reads one ASIN, and counts the match", async () => {
    const pages = scripted([
      { body: grant },
      { body: { products: [product, { asin: "B2", title: "Spare" }], matchingProductCount: 306, numberOfPages: 13 } },
      { body: product },
      { body: { matchingProductCount: 4 } },
      { status: 404, body: { message: "missing" } },
      { body: { products: "nope", numberOfPages: 1 } },
    ]);
    const opened = new AmazonBusinessProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const search = await opened.query(
      "SELECT ASIN, Title, Price, Currency, Merchant FROM Product WHERE Keywords = 'paper' LIMIT 2",
    );
    expect(search.rows[0]).toEqual({
      ASIN: "B06XC9321S",
      Title: "Paper",
      Price: 37.24,
      Currency: "USD",
      Merchant: "Amazon",
    });
    expect(search.fields).toEqual(["ASIN", "Title", "Price", "Currency", "Merchant"]);
    expect(search.warnings?.map((warning) => warning.message).join(" ")).toMatch(/Raise OFFSET/);
    const listed = pages.requests[1];
    expect(listed?.url).toContain("https://na.business-api.amazon.com/products/2020-08-26/products?");
    expect(listed?.url).toContain("keywords=paper");
    expect(listed?.url).toContain("productRegion=US");
    expect(listed?.url).toContain("locale=en_US");
    expect(listed?.url).toContain("facets=OFFERS");
    expect(listed?.url).toContain("pageNumber=0");
    expect(listed?.url).toContain("pageSize=2");
    expect(listed?.headers["x-amz-user-email"]).toBe(EMAIL);
    expect(pages.options[1]?.headers["x-amz-access-token"]).toBe(TOKEN);
    const one = await opened.query("SELECT * FROM Product WHERE ASIN = 'B06XC9321S'");
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]?.Condition).toBe("New");
    expect(one.rows[0]?.OfferId).toBe("offer-1");
    expect(one.warnings).toBeUndefined();
    const counted = await opened.query("SELECT COUNT(*) AS total FROM Product WHERE Keywords = 'paper'");
    expect(counted.rows).toEqual([{ total: 4 }]);
    const missing = await opened.query("SELECT ASIN FROM Product WHERE ASIN = 'MISSING'");
    expect(missing.rows).toEqual([]);
    const empty = await opened.query("SELECT COUNT(*) FROM Product WHERE Keywords = 'none'");
    expect(empty.rows).toEqual([{ totalCount: 0 }]);
    await opened.disconnect();
  });

  test("pages orders, flattens lines, and walks a transaction token", async () => {
    const order = {
      orderId: "113-1",
      orderDate: "2024-07-18T01:00:00Z",
      purchaseOrderNumber: "PO-1",
      orderStatus: "CANCELLED",
      orderQuantity: 2,
      buyingCustomer: { name: "Ada", email: "ada@example.com" },
      buyerGroupName: "Facilities",
      orderSubTotal: { amount: 10, currencyCode: "USD" },
      orderShippingAndHandling: { amount: 1, currencyCode: "USD" },
      orderTax: { amount: 0.5, currencyCode: "USD" },
      orderNetTotal: { amount: 11.5, currencyCode: "USD" },
      lineItems: [
        {
          asin: "B0006BAHO2",
          title: "Tape",
          brandName: "3M",
          itemQuantity: 2,
          purchasedPricePerUnit: { value: { amount: 5, currencyCode: "USD" } },
          itemNetTotal: { amount: 10, currencyCode: "USD" },
          seller: { sellerName: "Amazon" },
          productCategory: "Office",
          productCondition: "New",
        },
      ],
    };
    const pages = scripted([
      { body: grant },
      { body: { orders: [order, { orderId: "113-2" }], nextPageToken: "page-2" } },
      { body: { orders: [order], nextPageToken: "line-2" } },
      { body: { orders: [order, { orderId: "bare" }], nextPageToken: "" } },
      { body: { orders: [{ orderId: "113-3" }], nextPageToken: "" } },
      { body: { orders: [{ orderId: "113-4", lineItems: [], orderQuantity: "2" }], nextPageToken: "more" } },
      {
        body: {
          transactions: [
            {
              transactionId: "T1",
              amount: { amount: 11.5, currencyCode: "USD" },
              buyer: { name: "Ada", email: "ada@example.com" },
              paymentInstrumentType: "Visa",
              paymentInstrumentLast4Digits: "4242",
            },
          ],
          nextPageToken: "tx-2",
        },
      },
      { body: { transactions: [{ transactionId: "T0" }], nextPageToken: "tx-2" } },
      { body: { transactions: [] } },
      { body: { transactions: "nope" } },
    ]);
    const opened = new AmazonBusinessProvider({ ...connection, schema: undefined }, {}, pages.createTransport);
    await opened.connect();
    const day = "StartDate = '2024-07-18T00:00:00Z' AND EndDate = '2024-07-18T23:59:59Z'";
    const orders = await opened.query(
      `SELECT OrderId, BuyerName, NetTotal, Currency FROM "Order" WHERE ${day} LIMIT 500`,
    );
    expect(orders.rows[0]).toEqual({ OrderId: "113-1", BuyerName: "Ada", NetTotal: 11.5, Currency: "USD" });
    expect(orders.rows).toHaveLength(2);
    expect(orders.warnings?.some((warning) => warning.message.includes("at most 100"))).toBe(true);
    expect(pages.requests[1]?.url).toContain("/reports/2021-01-08/orders?");
    expect(pages.requests[1]?.headers["x-amz-user-email"]).toBeUndefined();
    const lines = await opened.query(
      `SELECT OrderId, ASIN, Title, Quantity, Price, Seller FROM LineItem WHERE ${day} OFFSET 100`,
    );
    expect(lines.rows[0]).toMatchObject({
      OrderId: "113-1",
      ASIN: "B0006BAHO2",
      Quantity: 2,
      Price: 5,
      Seller: "Amazon",
    });
    expect(pages.requests[2]?.url).toContain("includeLineItems=true");
    expect(pages.requests[3]?.url).toContain("nextPageToken=line-2");
    const later = await opened.query(`SELECT OrderId FROM "Order" WHERE ${day} OFFSET 100`);
    expect(later.rows).toEqual([]);
    const bare = await opened.query(`SELECT OrderId, BuyerName FROM "Order" WHERE ${day}`);
    expect(bare.rows[0]).toEqual({ OrderId: "113-4", BuyerName: null });
    const feed = "FeedStartDate = '2024-07-01T00:00:00Z' AND FeedEndDate = '2024-07-31T23:59:59Z'";
    const transactions = await opened.query(
      `SELECT TransactionId, Amount, Currency, BuyerName, Last4 FROM Transaction WHERE ${feed}`,
    );
    expect(transactions.rows[0]).toEqual({
      TransactionId: "T1",
      Amount: 11.5,
      Currency: "USD",
      BuyerName: "Ada",
      Last4: "4242",
    });
    expect(transactions.warnings?.[0]?.message).toMatch(/next page/);
    const second = await opened.query(`SELECT TransactionId FROM Transaction WHERE ${feed} OFFSET 100`);
    expect(second.rows).toEqual([]);
    const shaped = await opened.query(`SELECT TransactionId FROM Transaction WHERE ${feed}`);
    expect(shaped.rows).toEqual([]);
    await opened.disconnect();
    expect(pages.closed).toBe(2);
  });

  test("refreshes a short-lived token and refuses a bad token answer", async () => {
    const short = scripted([
      { body: { access_token: TOKEN, expires_in: 30 } },
      { body: { access_token: `${TOKEN}-2`, expires_in: 3600 } },
      { body: { products: [] } },
    ]);
    const opened = new AmazonBusinessProvider(connection, {}, short.createTransport);
    await opened.connect();
    await opened.query("SELECT ASIN FROM Product WHERE Keywords = 'paper'");
    expect(short.requests.filter((request) => request.method === "POST")).toHaveLength(2);
    expect(short.options.at(-1)?.headers["x-amz-access-token"]).toBe(`${TOKEN}-2`);
    await opened.disconnect();

    const cases: { pages: ScriptedPage[]; error: unknown; message: RegExp }[] = [
      {
        pages: [{ status: 401, body: { error: "invalid_grant" } }],
        error: AuthenticationError,
        message: /refresh token/,
      },
      { pages: [{ status: 400, text: "no" }], error: AuthenticationError, message: /refresh token/ },
      { pages: [{ status: 500, text: `boom ${SECRET}` }], error: ConnectionError, message: /••••/ },
      { pages: [{ status: 302, text: "away" }], error: ConnectionError, message: /redirect/ },
      { pages: [{ text: "not-json" }], error: ConnectionError, message: /not JSON/ },
      { pages: [{ body: ["nope"] }], error: ConnectionError, message: /not JSON/ },
      { pages: [{ body: { token_type: "bearer" } }], error: AuthenticationError, message: /did not return/ },
      { pages: [{ body: { access_token: "" } }], error: AuthenticationError, message: /did not return/ },
      { pages: [{ body: { access_token: "x".repeat(1025) } }], error: ConnectionError, message: /too long/ },
      { pages: [{ body: { access_token: "has space" } }], error: ConnectionError, message: /too long/ },
      {
        pages: [{ throw: new TransportError("redirect", "https://evil.example") }],
        error: ConnectionError,
        message: /redirect/,
      },
      { pages: [{ throw: new TransportError("too-large", "big") }], error: QueryError, message: /2 MB/ },
      { pages: [{ throw: new TransportError("network", `down ${SECRET}`) }], error: ConnectionError, message: /••••/ },
      {
        pages: [{ throw: new DatabaseConfigError("kept", "amazonbusiness") }],
        error: DatabaseConfigError,
        message: /kept/,
      },
      { pages: [{ throw: new Error(`socket ${REFRESH}`) }], error: ConnectionError, message: /••••/ },
      { pages: [{ throw: "down" }], error: ConnectionError, message: /could not be reached/ },
    ];
    for (const entry of cases) {
      const script = scripted(entry.pages);
      const provider = new AmazonBusinessProvider(connection, {}, script.createTransport);
      try {
        await provider.connect();
        throw new Error("expected the token exchange to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(entry.error);
        const message = error instanceof Error ? error.message : "";
        expect(message).toMatch(entry.message);
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain(REFRESH);
      }
    }
  });

  test("maps API failures and keeps the access token out of the message", async () => {
    const pages = scripted([
      { body: grant },
      { status: 401, text: "no" },
      { status: 403, text: "no" },
      { status: 429, text: "slow" },
      { status: 500, text: `failed ${TOKEN}` },
      { status: 302, text: "away" },
      { text: "not-json" },
      { body: ["nope"] },
      { status: 200, text: "" },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("tls", `pin ${TOKEN}`) },
      { throw: new Error("reset") },
    ]);
    const opened = new AmazonBusinessProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const sql = "SELECT ASIN FROM Product WHERE Keywords = 'paper'";
    await expect(opened.query(sql)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query(sql)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query(sql)).rejects.toThrow(/slow down/);
    await expect(opened.query(sql)).rejects.toThrow(/••••/);
    await expect(opened.query(sql)).rejects.toThrow(/redirect/);
    await expect(opened.query(sql)).rejects.toThrow(/not JSON/);
    await expect(opened.query(sql)).rejects.toThrow(/JSON object/);
    const blank = await opened.query("SELECT COUNT(*) FROM Product WHERE ASIN = 'B1'");
    expect(blank.rows).toEqual([{ totalCount: 0 }]);
    await expect(opened.query(sql)).rejects.toThrow(/redirect/);
    await expect(opened.query(sql)).rejects.toThrow(/2 MB/);
    await expect(opened.query(sql)).rejects.toThrow(/••••/);
    await expect(opened.query(sql)).rejects.toThrow(/reset/);
    opened.config.schema = "";
    await expect(opened.query(sql)).rejects.toThrow(/email/);
    opened.config.schema = EMAIL;
    await expect(
      opened.query("SELECT ASIN FROM Product WHERE ProductRegion = 'ZZ' AND Keywords = 'paper'"),
    ).rejects.toThrow(/ProductRegion/);
    pages.requests.length = 0;
    const europe = new AmazonBusinessProvider(
      { ...connection, host: "eu.business-api.amazon.com" },
      {},
      scripted([
        { body: grant },
        { body: { products: [{ asin: "B9", price: 4, includedDataTypes: { OFFERS: ["nope"] } }] } },
      ]).createTransport,
    );
    await europe.connect();
    const row = await europe.query(
      "SELECT ASIN, Price, Merchant FROM Product WHERE Keywords = 'paper' AND Locale = 'en_GB'",
    );
    expect(row.rows[0]).toEqual({ ASIN: "B9", Price: null, Merchant: null });
    await expect(
      europe.query("SELECT ASIN FROM Product WHERE Keywords = 'paper' AND Locale = 'en US'"),
    ).rejects.toThrow(/Locale/);
    const japan = new AmazonBusinessProvider(
      { ...connection, host: "jp.business-api.amazon.com" },
      {},
      scripted([{ body: { access_token: TOKEN } }, { body: { asin: "B8" } }]).createTransport,
    );
    await japan.connect();
    const found = await japan.query("SELECT AsinType FROM Product WHERE ASIN = 'B8'");
    expect(found.rows).toEqual([{ AsinType: null }]);
    await opened.disconnect();
  });
});
