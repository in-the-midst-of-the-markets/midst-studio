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

async function heldForAccount(
  secretKey: string,
  username: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ ok: true; subscriptions: HeldSubscription[] } | { ok: false }> {
  const subscriptions = await stripePages(secretKey, "/v1/subscriptions", "status=all&limit=100", fetchImpl);
  if (subscriptions === null) return { ok: false };
  const sessions = await stripePages(secretKey, "/v1/checkout/sessions", "limit=100", fetchImpl);
  if (sessions === null) return { ok: false };
  return { ok: true, subscriptions: heldSubscriptions(subscriptions, sessions, username, now) };
}

export async function listMarketplaceSubscriptions(
  secretKey: string,
  username: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: true; subscriptions: SubscriptionView[] } | { ok: false }> {
  const held = await heldForAccount(secretKey, username, fetchImpl, now);
  if (!held.ok) return { ok: false };
  return { ok: true, subscriptions: held.subscriptions.map(subscriptionView) };
}

/**
 * Schedules the offering's subscription to stop at the end of the paid period.
 * One that has already ended, or is already set to end, is returned as it stands.
 */
export async function cancelMarketplaceSubscription(
  secretKey: string,
  username: string,
  offeringId: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: true; subscription: SubscriptionView } | { ok: false; missing: boolean }> {
  const held = await heldForAccount(secretKey, username, fetchImpl, now);
  if (!held.ok) return { ok: false, missing: false };
  const match = held.subscriptions.find((row) => row.offeringId === offeringId);
  if (match === undefined) return { ok: false, missing: true };
  if (match.status !== "active") return { ok: true, subscription: subscriptionView(match) };
  const result = await stripeRequest(
    secretKey,
    `/v1/subscriptions/${match.subscriptionId}`,
    cancelSubscriptionBody(username, offeringId),
    fetchImpl,
  );
  if (!result.ok) return { ok: false, missing: false };
  const access = readSubscription(result.payload, now);
  if (access === null) return { ok: false, missing: false };
  return { ok: true, subscription: subscriptionView({ ...access, offeringId }) };
}
