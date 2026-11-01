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
const originalTestSecret = process.env.STRIPE_TEST_SECRET_KEY;
const originalTrust = process.env.TRUST_PROXY_HEADERS;
const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;
const originalFetch = globalThis.fetch;

const OFFERING = {
  id: "opensearch",
  name: "OpenSearch",
  description: "Search indexes",
  monthlyCents: 500,
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
  delete process.env.STRIPE_TEST_SECRET_KEY;
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
  if (originalTestSecret === undefined) delete process.env.STRIPE_TEST_SECRET_KEY;
  else process.env.STRIPE_TEST_SECRET_KEY = originalTestSecret;
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

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

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

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The marketplace catalog is not valid" });
  });

  test("an id that is not in the catalog is not for sale", async () => {
    const response = await POST(post(JSON.stringify({ id: "missing" })));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "That data is not in the marketplace" });
  });

  test("uses the test secret when it is set", async () => {
    process.env.STRIPE_TEST_SECRET_KEY = " sk_test_preferred ";
    process.env.STRIPE_SECRET_KEY = "sk_test_other";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_preferred");
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" }), { status: 200 });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" });
  });

  test("a blank test secret falls through to STRIPE_SECRET_KEY", async () => {
    process.env.STRIPE_TEST_SECRET_KEY = "   ";
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_marketplace");
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" }), { status: 200 });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(200);
  });

  test.each([undefined, "   "])("answers 503 when Stripe is not configured (%j)", async (secret) => {
    if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = secret;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Stripe checkout is not configured" });
  });

  test("refuses to start checkout from a request that has no origin", async () => {
    const response = await POST(post(JSON.stringify({ id: "opensearch" }), null));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Checkout has to start from the marketplace page" });
  });

  test("charges each database its own monthly price and ignores an amount on the request", async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/studio";
    process.env.MARKETPLACE_OFFERINGS = JSON.stringify([
      OFFERING,
      { id: "postgres", name: "PostgreSQL", description: "Tables", monthlyCents: 1200 },
    ]);
    const amounts: string[] = [];
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_marketplace");
      amounts.push(String(init?.body));
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" }), { status: 200 });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "opensearch", monthlyCents: 1 })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" });
    expect(JSON.stringify(payload)).not.toContain("sk_test_marketplace");
    const postgres = await POST(post(JSON.stringify({ id: "postgres", monthlyCents: 1 })));
    expect(postgres.status).toBe(200);

    const opensearchBody = amounts[0] ?? "";
    expect(opensearchBody).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500");
    expect(opensearchBody).toContain("line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month");
    expect(opensearchBody).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=OpenSearch");
    expect(opensearchBody).not.toContain("unit_amount%5D=1");
    expect(opensearchBody).toContain(
      "https%3A%2F%2Fstudio.example%2Fstudio%2Fmarketplace%3Fcheckout%3Dsuccess%26session_id%3D{CHECKOUT_SESSION_ID}",
    );
    expect(opensearchBody).toContain("https%3A%2F%2Fstudio.example%2Fstudio%2Fmarketplace%3Fcheckout%3Dcancel");
    expect(amounts[1]).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1200");
    expect(amounts[1]).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=PostgreSQL");
  });

  test("answers 502 when Stripe does not return a Checkout URL", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ url: "https://evil.example/pay" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const response = await POST(post(JSON.stringify({ id: "opensearch" })));

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
        new Response(JSON.stringify({ status: "complete", client_reference_id: "opensearch" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const complete = await GET(get("cs_test_abc"));

    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ offeringId: "opensearch", complete: true });

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "open", client_reference_id: "opensearch" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const open = await GET(get("cs_test_abc"));
    expect(await open.json()).toEqual({ offeringId: "opensearch", complete: false });

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "complete", client_reference_id: "other" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const unknown = await GET(get("cs_test_abc"));
    expect(await unknown.json()).toEqual({ offeringId: "other", complete: false });
  });
});
