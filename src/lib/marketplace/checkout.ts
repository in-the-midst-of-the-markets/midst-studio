/**
 * Stripe Checkout for a marketplace subscription.
 *
 * The secret key never leaves this module's requests. A Checkout URL is accepted only when it is
 * HTTPS on checkout.stripe.com, so a surprising response cannot send the browser somewhere else.
 */

import { checkOrigin } from "@/lib/api/origin-check";
import type { MarketplaceEnv } from "@/lib/marketplace/catalog";

const STRIPE_API = "https://api.stripe.com";
const CHECKOUT_HOST = "checkout.stripe.com";
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

export function isCheckoutSessionId(value: string): boolean {
  return value.length <= 255 && SESSION_ID.test(value);
}

/**
 * The browser origin Checkout may send the subscriber back to.
 *
 * It has to be the origin the request itself came from, and that origin has to pass the same host
 * check a state-changing request does. A missing or mismatched origin is refused rather than
 * replaced with a host header a caller can set.
 */
export function checkoutReturnOrigin(headers: Headers): string | null {
  const origin = headers.get("origin");
  if (origin === null || origin === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) return null;
  if (!checkOrigin({ method: "POST", headers }).allowed) return null;
  return parsed.origin;
}

/**
 * Form body for `POST /v1/checkout/sessions`. The session-id template is left unescaped for Stripe.
 * `unitAmount` is that database's monthly price in US cents. The browser does not choose it.
 */
export function checkoutSessionBody(input: {
  productName: string;
  unitAmount: string;
  successUrl: string;
  cancelUrl: string;
  offeringId: string;
  subscriber: string;
}): string {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("success_url", input.successUrl);
  body.set("cancel_url", input.cancelUrl);
  body.set("client_reference_id", input.offeringId);
  body.set("metadata[offering_id]", input.offeringId);
  body.set("metadata[subscriber]", input.subscriber);
  body.set("subscription_data[metadata][offering_id]", input.offeringId);
  body.set("subscription_data[metadata][subscriber]", input.subscriber);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "usd");
  body.set("line_items[0][price_data][unit_amount]", input.unitAmount);
  body.set("line_items[0][price_data][recurring][interval]", "month");
  body.set("line_items[0][price_data][product_data][name]", input.productName);
  return body.toString().replaceAll("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
}

export function checkoutUrl(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const url = (payload as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.host !== CHECKOUT_HOST) return null;
  return parsed.toString();
}

export function sessionOutcome(payload: unknown): { offeringId: string; complete: boolean } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as { client_reference_id?: unknown; status?: unknown };
  if (typeof row.client_reference_id !== "string" || row.client_reference_id === "") return null;
  if (row.status !== "complete" && row.status !== "open" && row.status !== "expired") return null;
  return { offeringId: row.client_reference_id, complete: row.status === "complete" };
}

/** The test secret wins when it is set, so a test key is what Checkout uses on this deployment. */
export function stripeSecret(env: MarketplaceEnv = process.env): string | null {
  const testKey = env.STRIPE_TEST_SECRET_KEY?.trim();
  if (testKey) return testKey;
  const liveKey = env.STRIPE_SECRET_KEY?.trim();
  return liveKey ? liveKey : null;
}

export async function stripeRequest(
  secretKey: string,
  path: string,
  body: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; payload: unknown } | { ok: false }> {
  let response: Response;
  try {
    response = await fetchImpl(`${STRIPE_API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? { Authorization: `Bearer ${secretKey}` }
          : { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return { ok: false };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  return { ok: true, payload };
}

export async function createStripeCheckout(
  input: {
    secretKey: string;
    productName: string;
    unitAmount: string;
    successUrl: string;
    cancelUrl: string;
    offeringId: string;
    subscriber: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false }> {
  const result = await stripeRequest(input.secretKey, "/v1/checkout/sessions", checkoutSessionBody(input), fetchImpl);
  if (!result.ok) return { ok: false };
  const url = checkoutUrl(result.payload);
  if (url === null) return { ok: false };
  return { ok: true, url };
}

export async function readStripeCheckout(
  secretKey: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; offeringId: string; complete: boolean } | { ok: false }> {
  if (!isCheckoutSessionId(sessionId)) return { ok: false };
  const result = await stripeRequest(secretKey, `/v1/checkout/sessions/${sessionId}`, undefined, fetchImpl);
  if (!result.ok) return { ok: false };
  const outcome = sessionOutcome(result.payload);
  if (outcome === null) return { ok: false };
  return { ok: true, offeringId: outcome.offeringId, complete: outcome.complete };
}
