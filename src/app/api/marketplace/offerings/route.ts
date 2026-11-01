import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { publicMarketplaceOfferings, readMarketplaceCatalog } from "@/lib/marketplace/catalog";

export const dynamic = "force-dynamic";

/**
 * GET /api/marketplace/offerings — the third-party data this server offers for subscription.
 *
 * The Stripe price id stays on the server. An unset catalog is an empty list; a catalog that does
 * not parse is a configuration error, not an empty shop.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  const catalog = readMarketplaceCatalog();
  if (!catalog.ok) {
    return NextResponse.json({ error: "The marketplace catalog is not valid" }, { status: 500 });
  }
  return NextResponse.json({ offerings: publicMarketplaceOfferings(catalog.offerings) });
}
