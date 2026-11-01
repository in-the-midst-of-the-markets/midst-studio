import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  checkoutReturnOrigin,
  checkoutSessionBody,
  checkoutUrl,
  createStripeCheckout,
  isCheckoutSessionId,
  readStripeCheckout,
  sessionOutcome,
} from "@/lib/marketplace/checkout";

const originalTrust = process.env.TRUST_PROXY_HEADERS;
const originalAllowed = process.env.ALLOWED_ORIGINS;

function headers(origin: string | null, host = "studio.example"): Headers {
  const value = new Headers({ host });
  if (origin !== null) value.set("origin", origin);
  return value;
}

afterEach(() => {
  if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = originalTrust;
  if (originalAllowed === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalAllowed;
});

describe("isCheckoutSessionId", () => {
  test("accepts a test or live Checkout session id", () => {
    expect(isCheckoutSessionId("cs_test_abc")).toBe(true);
    expect(isCheckoutSessionId("cs_live_abc")).toBe(true);
  });

  test("refuses a missing prefix, an empty tail, and an over-long id", () => {
    expect(isCheckoutSessionId("sess_abc")).toBe(false);
    expect(isCheckoutSessionId("cs_test_")).toBe(false);
    expect(isCheckoutSessionId(`cs_test_${"a".repeat(300)}`)).toBe(false);
  });
});

describe("checkoutReturnOrigin", () => {
  test("refuses a missing, empty, or unparseable origin", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    expect(checkoutReturnOrigin(headers(null))).toBeNull();
    expect(checkoutReturnOrigin(new Headers({ host: "studio.example", origin: "" }))).toBeNull();
    expect(checkoutReturnOrigin(headers("not a url"))).toBeNull();
  });

  test("refuses a non-http origin and an origin that is not itself the origin", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    expect(checkoutReturnOrigin(headers("ftp://studio.example"))).toBeNull();
    expect(checkoutReturnOrigin(headers("https://studio.example/marketplace"))).toBeNull();
    expect(checkoutReturnOrigin(headers("https://user@studio.example"))).toBeNull();
  });

  test("refuses an origin whose host is not this deployment", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    delete process.env.ALLOWED_ORIGINS;

    expect(checkoutReturnOrigin(headers("https://evil.example"))).toBeNull();
  });

  test("accepts the request's own http or https origin", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    expect(checkoutReturnOrigin(headers("https://studio.example"))).toBe("https://studio.example");
    expect(checkoutReturnOrigin(headers("http://studio.example"))).toBe("http://studio.example");
  });
});

describe("checkoutSessionBody", () => {
  test("asks for a subscription and leaves the session-id template for Stripe", () => {
    const body = checkoutSessionBody({
      productName: "OpenSearch",
      unitAmount: "500",
      successUrl: "https://studio.example/marketplace?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://studio.example/marketplace?checkout=cancel",
      offeringId: "opensearch",
    });
    const other = checkoutSessionBody({
      productName: "PostgreSQL",
      unitAmount: "1200",
      successUrl: "https://studio.example/marketplace?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://studio.example/marketplace?checkout=cancel",
      offeringId: "postgres",
    });

    expect(body).toContain("mode=subscription");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500");
    expect(other).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1200");
    expect(other).not.toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=OpenSearch");
    expect(body).toContain("line_items%5B0%5D%5Bquantity%5D=1");
    expect(body).toContain("client_reference_id=opensearch");
    expect(body).toContain("session_id%3D{CHECKOUT_SESSION_ID}");
    expect(body).not.toContain("%7BCHECKOUT_SESSION_ID%7D");
  });
});

describe("checkoutUrl", () => {
  test("accepts only an https URL on checkout.stripe.com", () => {
    expect(checkoutUrl({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" })).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_abc",
    );
  });

  test.each([
    [null],
    [["https://checkout.stripe.com/c/pay/cs_test_abc"]],
    [{}],
    [{ url: 1 }],
    [{ url: "not a url" }],
    [{ url: "http://checkout.stripe.com/c/pay/cs_test_abc" }],
    [{ url: "https://evil.example/c/pay/cs_test_abc" }],
  ])("refuses %j", (payload) => {
    expect(checkoutUrl(payload)).toBeNull();
  });
});

describe("sessionOutcome", () => {
  test("reads a complete, open, or expired session", () => {
    expect(sessionOutcome({ status: "complete", client_reference_id: "acme-trades" })).toEqual({
      offeringId: "acme-trades",
      complete: true,
    });
    expect(sessionOutcome({ status: "open", client_reference_id: "acme-trades" })).toEqual({
      offeringId: "acme-trades",
      complete: false,
    });
    expect(sessionOutcome({ status: "expired", client_reference_id: "acme-trades" })).toEqual({
      offeringId: "acme-trades",
      complete: false,
    });
  });

  test.each([
    [null],
    [[]],
    [{}],
    [{ status: "complete", client_reference_id: "" }],
    [{ status: "complete", client_reference_id: 1 }],
    [{ status: "paid", client_reference_id: "acme-trades" }],
  ])("refuses %j", (payload) => {
    expect(sessionOutcome(payload)).toBeNull();
  });
});

describe("createStripeCheckout", () => {
  const input = {
    secretKey: "sk_test_marketplace",
    productName: "OpenSearch",
    unitAmount: "500",
    successUrl: "https://studio.example/marketplace?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://studio.example/marketplace?checkout=cancel",
    offeringId: "acme-trades",
  };

  test("posts the subscription and returns the Checkout URL", async () => {
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_marketplace");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(String(init?.body)).toContain("{CHECKOUT_SESSION_ID}");
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_abc" }), { status: 200 });
    });

    const created = await createStripeCheckout(input, fetchImpl as unknown as typeof fetch);

    expect(created).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_abc" });
  });

  test("refuses a network failure, a body that is not JSON, a Stripe error, and a URL off Stripe", async () => {
    const down = mock(async () => {
      throw new Error("offline");
    });
    const notJson = mock(async () => new Response("nope", { status: 200 }));
    const rejected = mock(async () => new Response(JSON.stringify({ error: "no" }), { status: 400 }));
    const foreign = mock(
      async () => new Response(JSON.stringify({ url: "https://evil.example/pay" }), { status: 200 }),
    );

    expect(await createStripeCheckout(input, down as unknown as typeof fetch)).toEqual({ ok: false });
    expect(await createStripeCheckout(input, notJson as unknown as typeof fetch)).toEqual({ ok: false });
    expect(await createStripeCheckout(input, rejected as unknown as typeof fetch)).toEqual({ ok: false });
    expect(await createStripeCheckout(input, foreign as unknown as typeof fetch)).toEqual({ ok: false });
  });
});

describe("readStripeCheckout", () => {
  test("does not call Stripe for an id that is not a Checkout session", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("should not be called");
    });

    expect(await readStripeCheckout("sk_test_marketplace", "nope", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("gets the session with the secret and no form body", async () => {
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_abc");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk_test_marketplace");
      expect(new Headers(init?.headers).get("content-type")).toBeNull();
      return new Response(JSON.stringify({ status: "complete", client_reference_id: "acme-trades" }), { status: 200 });
    });

    expect(
      await readStripeCheckout("sk_test_marketplace", "cs_test_abc", fetchImpl as unknown as typeof fetch),
    ).toEqual({ ok: true, offeringId: "acme-trades", complete: true });
  });

  test("refuses a Stripe error and a session Stripe did not describe", async () => {
    const rejected = mock(async () => new Response(JSON.stringify({ error: "no" }), { status: 404 }));
    const shapeless = mock(async () => new Response(JSON.stringify({ id: "cs_test_abc" }), { status: 200 }));

    expect(await readStripeCheckout("sk_test_marketplace", "cs_test_abc", rejected as unknown as typeof fetch)).toEqual(
      {
        ok: false,
      },
    );
    expect(
      await readStripeCheckout("sk_test_marketplace", "cs_test_abc", shapeless as unknown as typeof fetch),
    ).toEqual({ ok: false });
  });
});
