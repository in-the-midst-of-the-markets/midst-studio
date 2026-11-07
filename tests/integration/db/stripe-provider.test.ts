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
import { StripeProvider, stripeApiHost } from "@/lib/db/providers/sql/stripe";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "st",
  name: "st",
  type: "stripe",
  password: "sk_test_secret_value",
  createdAt: new Date(0),
} as DatabaseConnection;

function scripted(pages: { status?: number; body?: unknown; text?: string; throw?: unknown }[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: { url: string }[];
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next) throw next.throw;
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

function provider(
  createTransport: (options: NodeTransportOptions) => NodeTransport,
  extra: Partial<DatabaseConnection> = {},
): StripeProvider {
  return new StripeProvider({ ...connection, ...extra }, {}, createTransport);
}

async function connected(
  createTransport: (options: NodeTransportOptions) => NodeTransport,
  extra: Partial<DatabaseConnection> = {},
): Promise<StripeProvider> {
  const opened = provider(createTransport, extra);
  await opened.connect();
  return opened;
}

const customer = {
  id: "cus_1",
  email: "a@b.c",
  name: "Ada",
  created: 1_700_000_000,
  delinquent: false,
  description: { note: "nested" },
  livemode: false,
  object: "customer",
  metadata: { plan: "pro" },
};

describe("StripeProvider", () => {
  test("requires a printable secret key and sends it only to api.stripe.com", () => {
    expect(() => new StripeProvider(connection)).not.toThrow();
    expect(() => new StripeProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "sk_test_secret_value\r\nX-Injected: 1";
    expect(() => new StripeProvider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      new StripeProvider({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("sk_test");
    }
    expect(() => new StripeProvider({ ...connection, password: "x".repeat(1024) })).toThrow(/single line/);
    expect(stripeApiHost(connection)).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: " https://api.stripe.com/v1 " })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "http://api.stripe.com" })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "   " })).toBe("api.stripe.com");
    for (const host of [
      "evil.com",
      "api.stripe.com.evil.com",
      "https://sk_test_secret_value@evil.com",
      "api.stripe.com:8443",
      "https://",
    ]) {
      expect(() => new StripeProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        stripeApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("stripe.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("8443");
        expect(message).not.toContain("sk_test");
      }
    }
    expect(() => stripeApiHost({ ...connection, host: "files.stripe.com" })).toThrow(
      "The API host must be api.stripe.com. The secret key is sent only there.",
    );
  });

  test("lists the account's objects and refuses a write", async () => {
    const probe = scripted([{ body: { data: [], has_more: false } }]);
    const opened = await connected(probe.createTransport);
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://api.stripe.com/v1/customers?limit=1");
    expect(probe.options?.origin).toEqual({ scheme: "https", host: "api.stripe.com", port: 443 });
    expect(probe.options?.tls).toEqual({ rejectUnauthorized: true, identity: "api.stripe.com" });
    expect(probe.options?.refusesLinkLocal).toBe(true);
    expect(probe.options?.refusesUpgrade).toBe(true);
    expect(probe.options?.headers.Authorization).toBe("Bearer sk_test_secret_value");
    expect(probe.options?.headers["Stripe-Version"]).toBe("2026-10-28.endive");
    expect(await opened.listContainers()).toEqual([{ path: ["account"], name: "account", level: 0 }]);
    expect(await opened.listContainers(["account"])).toEqual([]);
    expect(await opened.countObjects(["account"])).toEqual({ table: { count: 12 } });
    const objects = await opened.listObjects(["account"], "table");
    expect(objects.map((object) => object.name)).toContain("customers");
    expect(objects).toHaveLength(12);
    const detail = await opened.describeObject(["account", "customers"], "table");
    expect(detail.columns[0]).toMatchObject({ name: "id", isPrimary: true, nullable: false });
    expect(detail.foreignKeys).toEqual([]);
    const bulk = await opened.describeObjects(["account"], "table");
    expect(bulk.details).toHaveLength(12);
    const truncated = await opened.describeObjects(["account"], "table", 1);
    expect(truncated.details).toHaveLength(1);
    expect(truncated.truncated?.limit).toBe(1);
    await expect(opened.describeObjects(["account"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["account"], "view")).rejects.toThrow(/no object kind/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getLabels().entityName).toBe("Object");
    await expect(opened.query("INSERT INTO customers (email) VALUES ('a@b.c')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT email FROM customers", ["x"])).rejects.toThrow(/bind parameters/);
  });

  test("lists, searches, retrieves, and counts through the API", async () => {
    const page = { data: [customer], has_more: false };
    const { createTransport, requests } = scripted([
      { body: { data: [customer], has_more: false } },
      { body: page },
      { body: { data: [customer], has_more: false, next_page: "page_2" } },
      { body: { data: [customer], has_more: true } },
      { body: customer },
      { body: { data: [], has_more: false, total_count: 4 } },
      { body: { data: [], has_more: false, total_count: 10000 } },
      { body: customer },
      { body: { data: [], has_more: true } },
    ]);
    const opened = await connected(createTransport, { host: "http://api.stripe.com" });
    const listed = await opened.query(
      "SELECT email, created FROM customers WHERE email = 'a@b.c' AND created >= 10 ORDER BY created DESC LIMIT 1",
    );
    expect(listed.rows).toEqual([{ id: "cus_1", email: "a@b.c", created: "2023-11-14T22:13:20.000Z" }]);
    const listedUrl = new URL(requests[1]?.url ?? "");
    expect(listedUrl.pathname).toBe("/v1/customers");
    expect(listedUrl.searchParams.get("email")).toBe("a@b.c");
    expect(listedUrl.searchParams.get("created[gte]")).toBe("10");
    expect(listedUrl.protocol).toBe("https:");

    const searched = await opened.query("SELECT name FROM customers WHERE name = 'Ada' LIMIT 5");
    expect(searched.rows[0]).toMatchObject({ id: "cus_1", name: "Ada" });
    expect(new URL(requests[2]?.url ?? "").pathname).toBe("/v1/customers/search");
    const stopped = await opened.query("SELECT name FROM customers WHERE name = 'Ada' LIMIT 5 OFFSET 1");
    expect(stopped.rows).toEqual([]);

    const one = await opened.query("SELECT * FROM customers WHERE id = 'cus_1'");
    expect(one.rows[0]).toMatchObject({
      id: "cus_1",
      email: "a@b.c",
      delinquent: false,
      description: null,
    });
    expect(one.rows[0]).not.toHaveProperty("livemode");
    expect(one.rows[0]).not.toHaveProperty("metadata");
    expect(Object.hasOwn(one.rows[0] ?? {}, "object")).toBe(false);
    expect(new URL(requests[4]?.url ?? "").pathname).toBe("/v1/customers/cus_1");

    const counted = await opened.query("SELECT COUNT(*) FROM customers WHERE email = 'a@b.c'");
    expect(counted.rows).toEqual([{ row_count: 4 }]);
    expect(new URL(requests[5]?.url ?? "").searchParams.get("expand[]")).toBe("total_count");
    const capped = await opened.query("SELECT COUNT(*) FROM customers");
    expect(capped.warnings?.[0]?.message).toContain("10000");
    const byId = await opened.query("SELECT COUNT(*) FROM refunds WHERE id = 're_1'");
    expect(byId.rows).toEqual([{ row_count: 1 }]);

    expect(await opened.query("SELECT name FROM customers WHERE name = 'Bea' LIMIT 1")).toMatchObject({ rows: [] });
    expect(await opened.query("SELECT email FROM customers LIMIT 0")).toMatchObject({ rows: [] });
    await expect(opened.query("SELECT * FROM missing")).rejects.toThrow(/no object/);
    await expect(opened.query("SELECT nope FROM customers")).rejects.toThrow(/no field/);
    await expect(opened.query("SELECT * FROM customers WHERE id = 'cus_1' AND email = 'a'")).rejects.toThrow(
      /no other condition/,
    );
    await expect(opened.query("SELECT COUNT(*) FROM refunds")).rejects.toThrow(/does not report/);
    await expect(opened.query("SELECT * FROM customers OFFSET 1000")).rejects.toThrow(/at most 1000/);
  });

  test("pages a list until the row cap and a search until its cursor ends", async () => {
    const listPage = (id: number, more: boolean) => ({
      body: {
        data: Array.from({ length: 100 }, (_, index) => ({ id: `cus_${id}_${index}`, email: "a@b.c", created: 10 })),
        has_more: more,
      },
    });
    const { createTransport, requests } = scripted([
      { body: { data: [], has_more: false } },
      ...Array.from({ length: 10 }, (_, index) => listPage(index, true)),
    ]);
    const opened = await connected(createTransport);
    const capped = await opened.query("SELECT email FROM customers WHERE email = 'a@b.c'");
    expect(capped.rows).toHaveLength(1000);
    expect(capped.warnings?.[0]?.message).toContain("1000");
    expect(new URL(requests[2]?.url ?? "").searchParams.get("starting_after")).toBe("cus_0_99");

    const products = scripted([
      { body: { data: [], has_more: false } },
      { body: { data: [{ id: "prod_1", name: "Pro", active: true, created: 10 }], has_more: false } },
    ]);
    const productsOpened = await connected(products.createTransport);
    const active = await productsOpened.query("SELECT name FROM products WHERE active = FALSE");
    expect(active.rows).toEqual([{ id: "prod_1", name: "Pro" }]);
    expect(new URL(products.requests[1]?.url ?? "").searchParams.get("active")).toBe("false");
  });

  test("reports API failures without repeating the key", async () => {
    const token = "sk_test_secret_value";
    await expect(
      provider(scripted([{ status: 401, body: { error: { message: "nope" } } }]).createTransport).connect(),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      provider(scripted([{ status: 403, body: { error: { message: "nope" } } }]).createTransport).connect(),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(provider(scripted([{ status: 400, body: {} }]).createTransport).connect()).rejects.toThrow(
      /answered 400/,
    );
    await expect(provider(scripted([{ status: 500, text: "down" }]).createTransport).connect()).rejects.toThrow("down");
    await expect(
      provider(scripted([{ throw: new Error(`offline ${token}`) }]).createTransport).connect(),
    ).rejects.toBeInstanceOf(ConnectionError);
    await expect(provider(scripted([{ throw: "offline" }]).createTransport).connect()).rejects.toThrow(
      /could not be reached/,
    );
    await expect(
      provider(scripted([{ status: 400, body: { error: { message: `bad ${token}` } } }]).createTransport).connect(),
    ).rejects.toThrow(/••••/);
    const redirected = scripted([{ status: 302, text: "go" }]);
    await expect(provider(redirected.createTransport).connect()).rejects.toThrow(/does not follow/);
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(provider(scripted([{ text: huge }]).createTransport).connect()).rejects.toThrow(/larger than 2 MB/);

    const shape = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: "nope" } }]).createTransport,
    );
    await expect(shape.query("SELECT * FROM customers LIMIT 1")).rejects.toThrow(/did not return records/);
    const nameless = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: [{ email: "a" }] } }]).createTransport,
    );
    await expect(nameless.query("SELECT * FROM customers LIMIT 1")).rejects.toThrow(/no id/);
    const uncounted = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: [] } }]).createTransport,
    );
    await expect(uncounted.query("SELECT COUNT(*) FROM customers")).rejects.toThrow(/did not report a count/);

    const poisoned = JSON.parse('{"id":"cus_1","email":"a@b.c","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const { createTransport } = scripted([
      { body: { data: [], has_more: false } },
      { body: { data: [poisoned], has_more: false } },
    ]);
    const opened = await connected(createTransport);
    const listed = await opened.query("SELECT * FROM customers LIMIT 1");
    expect(Object.hasOwn(listed.rows[0] ?? {}, "__proto__")).toBe(false);

    const closed = provider(scripted([]).createTransport);
    await expect(closed.query("SELECT * FROM customers")).rejects.toThrow(/Not connected/);
    await expect(closed.listContainers()).rejects.toThrow(/Not connected/);
    await expect(opened.runMaintenance()).rejects.toBeInstanceOf(QueryError);
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getOverview()).toMatchObject({ version: "Stripe API", tableCount: 12 });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await opened.disconnect();
    await expect(opened.query("SELECT * FROM customers")).rejects.toThrow(/Not connected/);
  });

  test("does not follow a redirect, echo the key, or return a client secret", async () => {
    const stolen = "https://evil.example/steal";
    const redirected = scripted([{ throw: new TransportError("redirect", `Location: ${stolen}`) }]);
    await expect(provider(redirected.createTransport).connect()).rejects.toThrow(/does not follow/);
    expect(redirected.closed).toBe(1);
    try {
      await provider(
        scripted([{ throw: new TransportError("redirect", `Location: ${stolen}`) }]).createTransport,
      ).connect();
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("evil.example");
    }
    await expect(
      provider(scripted([{ throw: new TransportError("too-large", "body") }]).createTransport).connect(),
    ).rejects.toThrow(/larger than 2 MB/);
    const token = "sk_test_secret_value";
    await expect(
      provider(scripted([{ throw: new TransportError("network", `reset ${token}`) }]).createTransport).connect(),
    ).rejects.toThrow(/••••/);
    await expect(
      provider(scripted([{ throw: new DatabaseConfigError("blocked", "stripe") }]).createTransport).connect(),
    ).rejects.toThrow("blocked");

    const denied = scripted([{ status: 401, body: { error: { message: "nope" } } }]);
    await expect(provider(denied.createTransport).connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(denied.closed).toBe(1);

    const intent = {
      id: "pi_1",
      amount: 100,
      currency: "usd",
      status: "requires_payment_method",
      created: 10,
      client_secret: "pi_1_secret_value",
      object: "payment_intent",
    };
    const paid = scripted([{ body: { data: [], has_more: false } }, { body: intent }]);
    const opened = await connected(paid.createTransport);
    const rows = await opened.query("SELECT * FROM payment_intents WHERE id = 'pi_1'");
    expect(rows.rows[0]).toMatchObject({ id: "pi_1", amount: 100, currency: "usd" });
    expect(rows.rows[0]).not.toHaveProperty("client_secret");
    expect(JSON.stringify(rows)).not.toContain("pi_1_secret_value");
    expect(paid.requests[1]?.url).toBe("https://api.stripe.com/v1/payment_intents/pi_1");
    await expect(opened.query("SELECT * FROM customers WHERE id = '..'")).rejects.toThrow(/was not sent/);
    expect(paid.requests).toHaveLength(2);
    await opened.disconnect();
    expect(paid.closed).toBe(1);
    const idle = provider(scripted([]).createTransport);
    await idle.disconnect();
  });
});
