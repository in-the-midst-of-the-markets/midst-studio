/**
 * Drops a marketplace database once Stripe says the subscription has ended.
 * The browser holds the account's connections. This module never talks to Stripe itself.
 */

import { appFetch } from "@/lib/config/base-path";
import { subscriptionsFromBody, type SubscriptionView } from "@/lib/marketplace/subscription-status";
import { storage } from "@/lib/storage";

/**
 * Removes `marketplace-${offeringId}` when it is saved, and clears it as the selected connection.
 * The id matches `marketplaceConnectionId`. This file does not import that module: the browser
 * bundle would pull in server storage.
 */
export function dropEndedSubscription(offeringId: string): void {
  const id = `marketplace-${offeringId}`;
  if (storage.getConnections().some((connection) => connection.id === id)) storage.deleteConnection(id);
  if (storage.getActiveConnectionId() === id) storage.setActiveConnectionId(null);
}

type SubscriptionFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Reads this account's subscriptions and drops every database whose subscription has ended. */
export async function releaseEndedSubscriptions(fetchImpl: SubscriptionFetch = appFetch): Promise<SubscriptionView[]> {
  try {
    const response = await fetchImpl("/api/marketplace/subscriptions");
    if (!response.ok) return [];
    const views = subscriptionsFromBody(await response.json());
    for (const view of views) {
      if (view.status === "ended") dropEndedSubscription(view.offeringId);
    }
    return views;
  } catch {
    return [];
  }
}
