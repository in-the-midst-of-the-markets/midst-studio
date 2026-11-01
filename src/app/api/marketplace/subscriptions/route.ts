import { NextResponse } from "next/server";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { getSession } from "@/lib/auth";
import { isMarketplaceOfferingId } from "@/lib/marketplace/catalog";
import { stripeSecret } from "@/lib/marketplace/checkout";
import { cancelMarketplaceSubscription, listMarketplaceSubscriptions } from "@/lib/marketplace/subscription";
import { forgetMarketplaceConnection, marketplaceConnectionId } from "@/lib/marketplace/subscribed-connection";

export const dynamic = "force-dynamic";

/**
 * GET /api/marketplace/subscriptions — the Stripe subscriptions this account can manage.
 *
 * A subscription Stripe has already ended drops that database from this account's connections.
 * The Stripe subscription id stays on the server.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  const secret = stripeSecret();
  if (secret === null) {
    return NextResponse.json({ error: "Stripe checkout is not configured" }, { status: 503 });
  }
  const listed = await listMarketplaceSubscriptions(secret, session.username);
  if (!listed.ok) {
    return NextResponse.json({ error: "Subscriptions could not be read" }, { status: 502 });
  }
  await Promise.all(
    listed.subscriptions
      .filter((subscription) => subscription.status === "ended")
      .map((subscription) => forgetMarketplaceConnection(session, marketplaceConnectionId(subscription.offeringId))),
  );
  return NextResponse.json({ subscriptions: listed.subscriptions });
}

/**
 * POST /api/marketplace/subscriptions — stop one subscription when its paid period ends.
 *
 * The database stays in connections until that period is over. The body names the offering,
 * not a Stripe id, and the offering does not have to still be in the catalog.
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
  if (id === null || !isMarketplaceOfferingId(id)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const secret = stripeSecret();
  if (secret === null) {
    return NextResponse.json({ error: "Stripe checkout is not configured" }, { status: 503 });
  }
  const canceled = await cancelMarketplaceSubscription(secret, session.username, id);
  if (!canceled.ok) {
    if (canceled.missing) {
      return NextResponse.json({ error: "There is no subscription for that database" }, { status: 404 });
    }
    return NextResponse.json({ error: "Stripe could not cancel the subscription" }, { status: 502 });
  }
  if (canceled.subscription.status === "ended") {
    await forgetMarketplaceConnection(session, marketplaceConnectionId(canceled.subscription.offeringId));
  }
  return NextResponse.json({ subscription: canceled.subscription });
}
