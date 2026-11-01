import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@/lib/auth";

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

const { GET, POST } = await import("@/app/api/marketplace/checkout/route");

const originalCatalog = process.env.MARKETPLACE_OFFERINGS;
const originalSecret = process.env.STRIPE_SECRET_KEY;
const originalTrust = process.env.TRUST_PROXY_HEADERS;
const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
const originalFetch = globalThis.fetch;

const OFFERING = {
  id: "acme-trades",
  name: "Acme Trades",
  description: "Tick history",
  priceId: "price_abc",
  priceLabel: "$49/month",
};

function post(body: string, origin: string | null = "https://studio.example"): Request {
  const headers = new Headers({ host: "studio.example", "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://studio.example/api/marketplace/checkout", { method: "POST", headers, body });
}

function get(sessionId: string | null): Request {
  const query = sessionId === null ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
  return new Request(`https://studio.example/api/marketplace/checkout${query}`);
}

beforeEach(() => {
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  process.env.MARKETPLACE_OFFERINGS = JSON.stringify([OFFERING]);
  process.env.STRIPE_SECRET_KEY = " sk_test_marketplace ";
  process.env.TRUST_PROXY_HEADERS = "false";
  delete process.env.NEXT_PUBLIC_BASE_PATH;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCatalog === undefined) delete process.env.MARKETPLACE_OFFERINGS;
  else process.env.MARKETPLACE_OFFERINGS = originalCatalog;
  if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalSecret;
  if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = originalTrust;
  if (originalBasePath === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
  else process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
});

describe("POST /api/marketplace/checkout", () => {
  test("answers 401 without a session and does not call Stripe", async () => {
    mockGetSession.mockResolvedValue(null);
    const fetchImpl = mock(async () => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "acme-trades" })));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["not-json", "null", "[1]", JSON.stringify({ id: 1 }), JSON.stringify({})])(
    "refuses a body that does not name an offering (%s)",
    async (body) => {
      const response = await POST(post(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request body" });
    },
  );

  test("a catalog that does not parse is a configuration error", async () => {
    process.env.MARKETPLACE_OFFERINGS = "{";

    const response = await POST(post(JSON.stringify({ id: "acme-trades" })));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The marketplace catalog is not valid" });
  });

  test("an id that is not in the catalog is not for sale", async () => {
    const response = await POST(post(JSON.stringify({ id: "missing" })));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That data is not in the marketplace" });
  });

  test.each([undefined, "   "])("answers 503 when Stripe is not configured (%j)", async (secret) => {
    if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = secret;

    const response = await POST(post(JSON.stringify({ id: "acme-trades" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe checkout is not configured" });
  });

  test("refuses to start checkout from a request that has no origin", async () => {
    const response = await POST(post(JSON.stringify({ id: "acme-trades" }), null));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Checkout has to start from the marketplace page" });
  });

  test("returns the Checkout URL and sends the catalog price, not the request's", async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_marketplace");
      const body = String(init?.body);
      expect(body).toContain("line_items%5B0%5D%5Bprice%5D=price_abc");
      expect(body).toContain(
        "https%3A%2F%2Fstudio.example%2Fstudio%2Fmarketplace%3Fcheckout%3Dsuccess%26session_id%3D{CHECKOUT_SESSION_ID}",
      );
      expect(body).toContain("https%3A%2F%2Fstudio.example%2Fstudio%2Fmarketplace%3Fcheckout%3Dcancel");
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" }), { status: 200 });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "acme-trades", priceId: "price_from_the_browser" })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" });
    expect(JSON.stringify(payload)).not.toContain("sk_test_marketplace");
  });

  test("answers 502 when Stripe does not return a Checkout URL", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ url: "https://evil.example/pay" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "acme-trades" })));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Stripe could not start checkout" });
  });
});

describe("GET /api/marketplace/checkout", () => {
  test("answers 401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await GET(get("cs_test_abc"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
  });

  test.each([null, "nope"])("requires a Checkout session id (%j)", async (sessionId) => {
    const response = await GET(get(sessionId));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A Checkout session is required" });
  });

  test("a catalog that does not parse is a configuration error", async () => {
    process.env.MARKETPLACE_OFFERINGS = "{";

    const response = await GET(get("cs_test_abc"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The marketplace catalog is not valid" });
  });

  test("answers 503 when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const response = await GET(get("cs_test_abc"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe checkout is not configured" });
  });

  test("answers 502 when the session cannot be read", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const response = await GET(get("cs_test_abc"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The Checkout session could not be confirmed" });
  });

  test("reports complete only when Stripe says so and the offering is still listed", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ status: "complete", client_reference_id: "acme-trades" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const complete = await GET(get("cs_test_abc"));

    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ offeringId: "acme-trades", complete: true });

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "open", client_reference_id: "acme-trades" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const open = await GET(get("cs_test_abc"));
    expect(await open.json()).toEqual({ offeringId: "acme-trades", complete: false });

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "complete", client_reference_id: "other" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const unknown = await GET(get("cs_test_abc"));
    expect(await unknown.json()).toEqual({ offeringId: "other", complete: false });
  });
});
