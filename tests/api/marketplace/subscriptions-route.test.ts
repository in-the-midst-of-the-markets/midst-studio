import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@/lib/auth";
import type { ServerStorageProvider } from "@/lib/storage/types";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "user",
    username: "ada",
  }),
);

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => {
    const session = await mockGetSession();
    return session ? { kind: "authenticated", session } : { kind: "anonymous" };
  }),
}));

const collections = new Map<string, unknown>();
const getStorageProvider = mock(async (): Promise<ServerStorageProvider | null> => null);

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider,
}));

const { GET, POST } = await import("@/app/api/marketplace/subscriptions/route");

const originalSecret = process.env.STRIPE_SECRET_KEY;
const originalTestSecret = process.env.STRIPE_TEST_SECRET_KEY;
const originalFetch = globalThis.fetch;

const FUTURE = Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1000);
const FUTURE_ISO = new Date(FUTURE * 1000).toISOString();

const ada = {
  id: "sub_abc",
  status: "active",
  cancel_at_period_end: false,
  current_period_end: FUTURE,
  metadata: { offering_id: "opensearch", subscriber: "ada" },
};

let subscriptionRows: unknown[] = [ada];
let sessionRows: unknown[] = [];
let cancelPayload: unknown = { ...ada, cancel_at_period_end: true };
let cancelStatus = 200;
let failList = false;
const posted: string[] = [];

function provider(): ServerStorageProvider {
  return {
    getCollection: async (_userId: string, collection: string) => (collections.get(collection) ?? null) as never,
    setCollection: async (_userId: string, collection: string, data: unknown) => {
      collections.set(collection, data);
    },
  } as unknown as ServerStorageProvider;
}

function post(body: string): Request {
  return new Request("https://studio.example/api/marketplace/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  process.env.STRIPE_SECRET_KEY = "sk_test_marketplace";
  delete process.env.STRIPE_TEST_SECRET_KEY;
  collections.clear();
  getStorageProvider.mockReset();
  getStorageProvider.mockResolvedValue(null);
  subscriptionRows = [ada];
  sessionRows = [];
  cancelPayload = { ...ada, cancel_at_period_end: true };
  cancelStatus = 200;
  failList = false;
  posted.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (failList && init?.body === undefined) throw new Error("offline");
    const href = String(url);
    if (init?.body !== undefined) {
      posted.push(`${href} ${String(init.body)}`);
      return new Response(JSON.stringify(cancelPayload), { status: cancelStatus });
    }
    if (href.includes("/v1/checkout/sessions")) {
      return new Response(JSON.stringify({ data: sessionRows, has_more: false }), { status: 200 });
    }
    if (!href.includes("status=all")) return new Response(JSON.stringify({ error: "status" }), { status: 400 });
    return new Response(JSON.stringify({ data: subscriptionRows, has_more: false }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalSecret;
  if (originalTestSecret === undefined) delete process.env.STRIPE_TEST_SECRET_KEY;
  else process.env.STRIPE_TEST_SECRET_KEY = originalTestSecret;
});

describe("GET /api/marketplace/subscriptions", () => {
  test("answers 401 without a session and does not call Stripe", async () => {
    mockGetSession.mockResolvedValue(null);
    const fetchImpl = mock(async () => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([undefined, "   "])("answers 503 when Stripe is not configured (%j)", async (secret) => {
    if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = secret;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe checkout is not configured" });
  });

  test("answers 502 when Stripe does not answer", async () => {
    failList = true;

    const response = await GET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Subscriptions could not be read" });
  });

  test("returns this account's subscriptions and not the Stripe id", async () => {
    subscriptionRows = [ada, { ...ada, id: "sub_bob", metadata: { offering_id: "postgres", subscriber: "bob" } }];

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      subscriptions: [{ offeringId: "opensearch", status: "active", accessUntil: FUTURE_ISO }],
    });
    expect(JSON.stringify(body)).not.toContain("sub_");
    expect(JSON.stringify(body)).not.toContain("sk_test_marketplace");
  });

  test("removes a database whose subscription has ended", async () => {
    getStorageProvider.mockResolvedValue(provider());
    const ended = { ...ada, status: "canceled" };
    const bob = { ...ada, id: "sub_bob", status: "canceled", metadata: { offering_id: "postgres", subscriber: "bob" } };
    subscriptionRows = [ended, bob];
    collections.set("connections", [
      { id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" },
      { id: "marketplace-postgres", name: "PostgreSQL", type: "postgres" },
    ]);
    collections.set("active_connection_id", "marketplace-opensearch");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subscriptions: [{ offeringId: "opensearch", status: "ended", accessUntil: FUTURE_ISO }],
    });
    expect(collections.get("connections")).toEqual([
      { id: "marketplace-postgres", name: "PostgreSQL", type: "postgres" },
    ]);
    expect(collections.get("active_connection_id")).toBeNull();
  });

  test("keeps the database while the subscription is still open", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [{ id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" }]);
    collections.set("active_connection_id", "marketplace-opensearch");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(collections.get("connections")).toEqual([
      { id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" },
    ]);
    expect(collections.get("active_connection_id")).toBe("marketplace-opensearch");
  });
});

describe("POST /api/marketplace/subscriptions", () => {
  test("answers 401 without a session and does not call Stripe", async () => {
    mockGetSession.mockResolvedValue(null);
    const fetchImpl = mock(async () => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["not-json", "null", "[1]", JSON.stringify({ id: 1 }), JSON.stringify({}), JSON.stringify({ id: "Bad" })])(
    "refuses a body that does not name an offering (%s)",
    async (body) => {
      const fetchImpl = mock(async () => {
        throw new Error("should not be called");
      });
      globalThis.fetch = fetchImpl as unknown as typeof fetch;

      const response = await POST(post(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request body" });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("answers 503 when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe checkout is not configured" });
  });

  test("answers 404 when this account has no subscription for that database", async () => {
    subscriptionRows = [{ ...ada, metadata: { offering_id: "opensearch", subscriber: "bob" } }];

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "There is no subscription for that database" });
    expect(posted).toEqual([]);
  });

  test("answers 502 when Stripe cannot list or cancel", async () => {
    failList = true;
    const listed = await POST(post(JSON.stringify({ id: "opensearch" })));
    expect(listed.status).toBe(502);
    expect(await listed.json()).toEqual({ error: "Stripe could not cancel the subscription" });

    failList = false;
    cancelStatus = 400;
    const canceled = await POST(post(JSON.stringify({ id: "opensearch" })));
    expect(canceled.status).toBe(502);
    expect(await canceled.json()).toEqual({ error: "Stripe could not cancel the subscription" });
  });

  test("cancels at the period end and keeps the database", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [{ id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" }]);
    collections.set("active_connection_id", "marketplace-opensearch");
    subscriptionRows = [{ id: "sub_legacy", status: "active", current_period_end: FUTURE }];
    sessionRows = [{ status: "complete", subscription: "sub_legacy", client_reference_id: "opensearch" }];

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subscription: { offeringId: "opensearch", status: "canceling", accessUntil: FUTURE_ISO },
    });
    expect(posted[0]).toContain("https://api.stripe.com/v1/subscriptions/sub_legacy");
    expect(posted[0]).toContain("cancel_at_period_end=true");
    expect(posted[0]).toContain("metadata%5Bsubscriber%5D=ada");
    expect(collections.get("connections")).toEqual([
      { id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" },
    ]);
    expect(collections.get("active_connection_id")).toBe("marketplace-opensearch");
  });

  test("removes the database when the subscription has already ended", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [{ id: "marketplace-opensearch", name: "OpenSearch", type: "opensearch" }]);
    collections.set("active_connection_id", "marketplace-opensearch");
    subscriptionRows = [{ ...ada, status: "canceled" }];

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subscription: { offeringId: "opensearch", status: "ended", accessUntil: FUTURE_ISO },
    });
    expect(posted).toEqual([]);
    expect(collections.get("connections")).toEqual([]);
    expect(collections.get("active_connection_id")).toBeNull();
  });
});
