import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { getBasePath } from "@/lib/config/base-path";
import { readMarketplaceCatalog } from "@/lib/marketplace/catalog";
import {
  checkoutReturnOrigin,
  createStripeCheckout,
  isCheckoutSessionId,
  readStripeCheckout,
} from "@/lib/marketplace/checkout";

export const dynamic = "force-dynamic";

function configuredSecret(name: "STRIPE_TEST_SECRET_KEY" | "STRIPE_SECRET_KEY"): string | null {
  const secret = process.env[name]?.trim();
  return secret ? secret : null;
}

/** The test secret wins when it is set, so a test key is what Checkout uses on this deployment. */
function stripeSecret(): string | null {
  return configuredSecret("STRIPE_TEST_SECRET_KEY") ?? configuredSecret("STRIPE_SECRET_KEY");
}

/**
 * POST /api/marketplace/checkout — start a Stripe subscription Checkout for one catalogued offering.
 *
 * The charge is $5 a month, from the offering's name. A price id on the request is ignored.
 * The return URLs are this request's own origin, so Checkout cannot be pointed at another host.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const id =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as { id?: unknown }).id === "string"
      ? (body as { id: string }).id
      : null;
  if (id === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const catalog = readMarketplaceCatalog();
  if (!catalog.ok) {
    return NextResponse.json({ error: "The marketplace catalog is not valid" }, { status: 500 });
  }
  const offering = catalog.offerings.find((item) => item.id === id);
  if (!offering) {
    return NextResponse.json({ error: "That data is not in the marketplace" }, { status: 404 });
  }
  const secret = stripeSecret();
  if (secret === null) {
    return NextResponse.json({ error: "Stripe checkout is not configured" }, { status: 503 });
  }
  const origin = checkoutReturnOrigin(request.headers);
  if (origin === null) {
    return NextResponse.json({ error: "Checkout has to start from the marketplace page" }, { status: 400 });
  }
  const successUrl = `${origin}${getBasePath()}/marketplace?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}${getBasePath()}/marketplace?checkout=cancel`;
  const created = await createStripeCheckout({
    secretKey: secret,
    productName: offering.name,
    successUrl,
    cancelUrl,
    offeringId: offering.id,
  });
  if (!created.ok) {
    return NextResponse.json({ error: "Stripe could not start checkout" }, { status: 502 });
  }
  return NextResponse.json({ url: created.url });
}

/**
 * GET /api/marketplace/checkout?session_id= — whether Stripe reports that Checkout session complete.
 *
 * Completion is shown only when the session names an offering still in this server's catalog.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (sessionId === null || !isCheckoutSessionId(sessionId)) {
    return NextResponse.json({ error: "A Checkout session is required" }, { status: 400 });
  }
  const catalog = readMarketplaceCatalog();
  if (!catalog.ok) {
    return NextResponse.json({ error: "The marketplace catalog is not valid" }, { status: 500 });
  }
  const secret = stripeSecret();
  if (secret === null) {
    return NextResponse.json({ error: "Stripe checkout is not configured" }, { status: 503 });
  }
  const read = await readStripeCheckout(secret, sessionId);
  if (!read.ok) {
    return NextResponse.json({ error: "The Checkout session could not be confirmed" }, { status: 502 });
  }
  const known = catalog.offerings.some((item) => item.id === read.offeringId);
  return NextResponse.json({ offeringId: read.offeringId, complete: read.complete && known });
}
