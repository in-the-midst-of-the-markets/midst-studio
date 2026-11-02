/**
 * Reads and cancels the Stripe subscriptions behind marketplace databases.
 *
 * Listing includes canceled subscriptions (`status=all`), because an ended one is what tells the
 * app to drop the database. Checkout sessions supply the offering for a subscription created
 * before that id was stamped on the subscription itself.
 */

import { stripeRequest } from "@/lib/marketplace/checkout";
import {
  cancelSubscriptionBody,
  heldSubscriptions,
  readSubscription,
  stripeListPage,
  subscriptionCandidates,
  subscriptionView,
  type HeldSubscription,
  type SubscriptionView,
} from "@/lib/marketplace/subscription-status";

const LIST_PAGES = 10;

async function stripePages(
  secretKey: string,
  path: string,
  query: string,
  fetchImpl: typeof fetch,
): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  let pageQuery = query;
  for (let page = 0; page < LIST_PAGES; page++) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the id of the page before it.
    const result = await stripeRequest(secretKey, `${path}?${pageQuery}`, undefined, fetchImpl);
    if (!result.ok) return null;
    const parsed = stripeListPage(result.payload);
    if (parsed === null) return null;
    rows.push(...parsed.rows);
    if (!parsed.hasMore || parsed.lastId === null) break;
    pageQuery = `${query}&starting_after=${encodeURIComponent(parsed.lastId)}`;
  }
  return rows;
}

const PHASE_RANK: Record<SubscriptionView["status"], number> = { active: 0, canceling: 1, ended: 2 };

async function stripeLists(
  secretKey: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; subscriptions: unknown[]; sessions: unknown[] } | { ok: false }> {
  const subscriptions = await stripePages(secretKey, "/v1/subscriptions", "status=all&limit=100", fetchImpl);
  if (subscriptions === null) return { ok: false };
  const sessions = await stripePages(secretKey, "/v1/checkout/sessions", "limit=100", fetchImpl);
  if (sessions === null) return { ok: false };
  return { ok: true, subscriptions, sessions };
}

/** The subscription that still grants the most access. An open one wins over one that is ending. */
function leadingSubscription(rows: readonly HeldSubscription[]): HeldSubscription {
  let best = rows[0] as HeldSubscription;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] as HeldSubscription;
    if (PHASE_RANK[row.status] < PHASE_RANK[best.status]) best = row;
  }
  return best;
}

export async function listMarketplaceSubscriptions(
  secretKey: string,
  username: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: true; subscriptions: SubscriptionView[] } | { ok: false }> {
  const loaded = await stripeLists(secretKey, fetchImpl);
  if (!loaded.ok) return { ok: false };
  return {
    ok: true,
    subscriptions: heldSubscriptions(loaded.subscriptions, loaded.sessions, username, now).map(subscriptionView),
  };
}

/**
 * Schedules every active subscription for this offering to stop at the end of its paid period.
 * One that has already ended, or is already set to end, is left as it stands. The view that
 * comes back is the one that still grants access, so a second open subscription cannot hide
 * a cancellation that was just scheduled.
 */
export async function cancelMarketplaceSubscription(
  secretKey: string,
  username: string,
  offeringId: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: true; subscription: SubscriptionView } | { ok: false; missing: boolean }> {
  const loaded = await stripeLists(secretKey, fetchImpl);
  if (!loaded.ok) return { ok: false, missing: false };
  const matches = subscriptionCandidates(loaded.subscriptions, loaded.sessions, username, now).filter(
    (row) => row.offeringId === offeringId,
  );
  if (matches.length === 0) return { ok: false, missing: true };
  const settled: HeldSubscription[] = matches.filter((row) => row.status !== "active");
  for (const match of matches.filter((row) => row.status === "active")) {
    // oxlint-disable-next-line no-await-in-loop -- each remaining subscription is canceled before the next is posted.
    const result = await stripeRequest(
      secretKey,
      `/v1/subscriptions/${match.subscriptionId}`,
      cancelSubscriptionBody(username, offeringId),
      fetchImpl,
    );
    if (!result.ok) return { ok: false, missing: false };
    const access = readSubscription(result.payload, now);
    if (access === null) return { ok: false, missing: false };
    settled.push({ ...access, offeringId });
  }
  return { ok: true, subscription: subscriptionView(leadingSubscription(settled)) };
}
