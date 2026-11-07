import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { StripeProvider, stripeApiHost, type StripeFetch } from "@/lib/db/providers/sql/stripe";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "st",
  name: "st",
  type: "stripe",
  password: "sk_test_secret_value",
  createdAt: new Date(0),
} as DatabaseConnection;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === "" ? "" : JSON.stringify(body), { status });
}

function scripted(pages: { status?: number; body?: unknown; text?: string; throw?: unknown }[]): {
  fetchImpl: StripeFetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: StripeFetch = async (url, init) => {
    calls.push({ url, init });
    const next = pages.shift();
    if (next === undefined) throw new Error(`no response for ${url}`);
    if ("throw" in next) throw next.throw;
    if (next.text !== undefined) return new Response(next.text, { status: next.status ?? 200 });
    return jsonResponse(next.status ?? 200, next.body ?? {});
  };
  return { calls, fetchImpl };
}

function provider(fetchImpl: StripeFetch, extra: Partial<DatabaseConnection> = {}): StripeProvider {
  return new StripeProvider({ ...connection, ...extra }, {}, fetchImpl);
}

async function connected(fetchImpl: StripeFetch, extra: Partial<DatabaseConnection> = {}): Promise<StripeProvider> {
  const opened = provider(fetchImpl, extra);
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
  test("requires a secret key and keeps only a host under stripe.com", () => {
    expect(() => provider(async () => jsonResponse(200, {}), { password: "  " })).toThrow(DatabaseConfigError);
    expect(stripeApiHost(connection)).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: " https://api.stripe.com/v1 " })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "   " })).toBe("api.stripe.com");
    for (const host of [
      "evil.com",
      "api.stripe.com.evil.com",
      "https://sk_test_secret_value@evil.com",
      "api.stripe.com:8443",
      "https://",
    ]) {
      expect(() => provider(async () => jsonResponse(200, {}), { host })).toThrow(DatabaseConfigError);
      try {
        stripeApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("stripe.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("8443");
      }
    }
  });

  test("lists the account's objects and refuses a write", async () => {
    const { fetchImpl, calls } = scripted([{ body: { data: [], has_more: false } }]);
    const opened = await connected(fetchImpl);
    await opened.connect();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/customers?limit=1");
    expect(calls[0]?.init?.redirect).toBe("manual");
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
    const { fetchImpl, calls } = scripted([
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
    const opened = await connected(fetchImpl, { host: "api.stripe.com" });
    const listed = await opened.query(
      "SELECT email, created FROM customers WHERE email = 'a@b.c' AND created >= 10 ORDER BY created DESC LIMIT 1",
    );
    expect(listed.rows).toEqual([{ id: "cus_1", email: "a@b.c", created: "2023-11-14T22:13:20.000Z" }]);
    const listedUrl = new URL(calls[1]?.url ?? "");
    expect(listedUrl.pathname).toBe("/v1/customers");
    expect(listedUrl.searchParams.get("email")).toBe("a@b.c");
    expect(listedUrl.searchParams.get("created[gte]")).toBe("10");
    expect((calls[1]?.init?.headers as Record<string, string>)["Stripe-Version"]).toBe("2026-10-28.endive");

    const searched = await opened.query("SELECT name FROM customers WHERE name = 'Ada' LIMIT 5");
    expect(searched.rows[0]).toMatchObject({ id: "cus_1", name: "Ada" });
    expect(new URL(calls[2]?.url ?? "").pathname).toBe("/v1/customers/search");
    const stopped = await opened.query("SELECT name FROM customers WHERE name = 'Ada' LIMIT 5 OFFSET 1");
    expect(stopped.rows).toEqual([]);

    const one = await opened.query("SELECT * FROM customers WHERE id = 'cus_1'");
    expect(one.rows[0]).toMatchObject({
      id: "cus_1",
      email: "a@b.c",
      delinquent: false,
      description: null,
      livemode: false,
    });
    expect(one.rows[0]).not.toHaveProperty("metadata");
    expect(Object.hasOwn(one.rows[0] ?? {}, "object")).toBe(false);
    expect(new URL(calls[4]?.url ?? "").pathname).toBe("/v1/customers/cus_1");

    const counted = await opened.query("SELECT COUNT(*) FROM customers WHERE email = 'a@b.c'");
    expect(counted.rows).toEqual([{ row_count: 4 }]);
    expect(new URL(calls[5]?.url ?? "").searchParams.get("expand[]")).toBe("total_count");
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
    const { fetchImpl, calls } = scripted([
      { body: { data: [], has_more: false } },
      ...Array.from({ length: 10 }, (_, index) => listPage(index, true)),
    ]);
    const opened = await connected(fetchImpl);
    const capped = await opened.query("SELECT email FROM customers WHERE email = 'a@b.c'");
    expect(capped.rows).toHaveLength(1000);
    expect(capped.warnings?.[0]?.message).toContain("1000");
    expect(new URL(calls[2]?.url ?? "").searchParams.get("starting_after")).toBe("cus_0_99");

    const products = scripted([
      { body: { data: [], has_more: false } },
      { body: { data: [{ id: "prod_1", name: "Pro", active: true, created: 10 }], has_more: false } },
    ]);
    const productsOpened = await connected(products.fetchImpl);
    const active = await productsOpened.query("SELECT name FROM products WHERE active = FALSE");
    expect(active.rows).toEqual([{ id: "prod_1", name: "Pro" }]);
    expect(new URL(products.calls[1]?.url ?? "").searchParams.get("active")).toBe("false");
  });

  test("reports API failures without repeating the key", async () => {
    const token = "sk_test_secret_value";
    await expect(
      provider(scripted([{ status: 401, body: { error: { message: "nope" } } }]).fetchImpl).connect(),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      provider(scripted([{ status: 403, body: { error: { message: "nope" } } }]).fetchImpl).connect(),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(provider(scripted([{ status: 400, body: {} }]).fetchImpl).connect()).rejects.toThrow(/answered 400/);
    await expect(provider(scripted([{ status: 500, text: "down" }]).fetchImpl).connect()).rejects.toThrow("down");
    await expect(
      provider(scripted([{ throw: new Error(`offline ${token}`) }]).fetchImpl).connect(),
    ).rejects.toBeInstanceOf(ConnectionError);
    await expect(provider(scripted([{ throw: "offline" }]).fetchImpl).connect()).rejects.toThrow(
      /could not be reached/,
    );
    await expect(
      provider(scripted([{ status: 400, body: { error: { message: `bad ${token}` } } }]).fetchImpl).connect(),
    ).rejects.toThrow(/••••/);
    const redirected = scripted([{ status: 302, text: "go" }]);
    await expect(provider(redirected.fetchImpl).connect()).rejects.toThrow(/does not follow/);
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(provider(scripted([{ text: huge }]).fetchImpl).connect()).rejects.toThrow(/larger than 2 MB/);

    const shape = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: "nope" } }]).fetchImpl,
    );
    await expect(shape.query("SELECT * FROM customers LIMIT 1")).rejects.toThrow(/did not return records/);
    const nameless = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: [{ email: "a" }] } }]).fetchImpl,
    );
    await expect(nameless.query("SELECT * FROM customers LIMIT 1")).rejects.toThrow(/no id/);
    const uncounted = await connected(
      scripted([{ body: { data: [], has_more: false } }, { body: { data: [] } }]).fetchImpl,
    );
    await expect(uncounted.query("SELECT COUNT(*) FROM customers")).rejects.toThrow(/did not report a count/);

    const poisoned = JSON.parse('{"id":"cus_1","email":"a@b.c","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const { fetchImpl } = scripted([
      { body: { data: [], has_more: false } },
      { body: { data: [poisoned], has_more: false } },
    ]);
    const opened = await connected(fetchImpl);
    const listed = await opened.query("SELECT * FROM customers LIMIT 1");
    expect(Object.hasOwn(listed.rows[0] ?? {}, "__proto__")).toBe(false);

    const closed = provider(scripted([]).fetchImpl);
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
});
