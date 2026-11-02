"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { appFetch } from "@/lib/config/base-path";
import { acceptSubscribedConnection } from "@/lib/marketplace/accept-subscription";
import type { PublicMarketplaceOffering } from "@/lib/marketplace/catalog";
import { dropEndedSubscription, releaseEndedSubscriptions } from "@/lib/marketplace/release-subscription";
import { cancellationNotice, subscriptionFromBody, type SubscriptionView } from "@/lib/marketplace/subscription-status";
import { storage } from "@/lib/storage";

const NO_OFFERINGS: readonly PublicMarketplaceOffering[] = [];

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; offerings: readonly PublicMarketplaceOffering[] };

type Confirmation =
  | { kind: "idle" }
  | { kind: "incomplete" }
  | { kind: "complete"; offeringId: string; added: boolean };

function matches(offering: PublicMarketplaceOffering, query: string): boolean {
  const name = offering.name.toLowerCase();
  const description = offering.description.toLowerCase();
  return name.includes(query) || description.includes(query);
}

/** Checkout saved this database on this browser. Cancel belongs to that database only. */
function holdsMarketplaceDatabase(offeringId: string): boolean {
  return storage.getConnections().some((connection) => connection.id === `marketplace-${offeringId}`);
}

/**
 * Search over the third-party data this server lists, and the Stripe Checkout that subscribes to one.
 *
 * The catalog is whatever the operator configured. An empty list is a real empty shop, not sample
 * products. Paying happens on Stripe's Checkout page; this screen only starts that and reads the
 * session Stripe sends back. Canceling keeps the database until the paid period ends.
 */
export function Marketplace() {
  const searchParams = useSearchParams();
  const checkout = searchParams.get("checkout");
  const sessionId = searchParams.get("session_id");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<readonly SubscriptionView[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>({ kind: "idle" });

  useEffect(() => {
    let current = true;
    appFetch("/api/marketplace/offerings")
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return (await response.json()) as { offerings?: PublicMarketplaceOffering[] };
      })
      .then((body) => {
        if (!current) return;
        setLoad({ kind: "ready", offerings: Array.isArray(body.offerings) ? body.offerings : [] });
      })
      .catch(() => {
        if (current) setLoad({ kind: "failed" });
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void releaseEndedSubscriptions().then((views) => {
      if (current) setSubscriptions(views);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (checkout !== "success" || sessionId === null || sessionId === "") return;
    let current = true;
    appFetch(`/api/marketplace/checkout?session_id=${encodeURIComponent(sessionId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return (await response.json()) as { offeringId?: unknown; complete?: unknown; connection?: unknown };
      })
      .then((body) => {
        if (!current) return;
        if (body.complete === true && typeof body.offeringId === "string") {
          setConfirmation({
            kind: "complete",
            offeringId: body.offeringId,
            added: acceptSubscribedConnection(body.connection),
          });
        } else {
          setConfirmation({ kind: "incomplete" });
        }
      })
      .catch(() => {
        if (current) setConfirmation({ kind: "incomplete" });
      });
    return () => {
      current = false;
    };
  }, [checkout, sessionId]);

  const offerings = load.kind === "ready" ? load.offerings : NO_OFFERINGS;
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => (query === "" ? offerings : offerings.filter((offering) => matches(offering, query))),
    [offerings, query],
  );
  const subscribedName =
    confirmation.kind === "complete"
      ? offerings.find((offering) => offering.id === confirmation.offeringId)?.name
      : undefined;

  async function subscribe(id: string): Promise<void> {
    if (pendingId !== null) return;
    setPendingId(id);
    setSubscribeError(null);
    try {
      const response = await appFetch("/api/marketplace/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
      if (!response.ok || body === null || typeof body.url !== "string") {
        setSubscribeError(typeof body?.error === "string" ? body.error : "Stripe could not start checkout.");
        return;
      }
      window.location.assign(body.url);
    } catch {
      setSubscribeError("Stripe could not start checkout.");
    } finally {
      setPendingId(null);
    }
  }

  async function cancel(id: string): Promise<void> {
    if (pendingId !== null) return;
    setPendingId(id);
    setCancelError(null);
    try {
      const response = await appFetch("/api/marketplace/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json().catch(() => null)) as { subscription?: unknown; error?: unknown } | null;
      const subscription = subscriptionFromBody(body?.subscription);
      if (!response.ok || subscription === null) {
        setCancelError(typeof body?.error === "string" ? body.error : "Stripe could not cancel the subscription.");
        return;
      }
      setSubscriptions((current) => [
        ...current.filter((row) => row.offeringId !== subscription.offeringId),
        subscription,
      ]);
      if (subscription.status === "ended") dropEndedSubscription(subscription.offeringId);
    } catch {
      setCancelError("Stripe could not cancel the subscription.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <main className="pt-6">
      <h1 className="text-lg font-semibold tracking-tight text-fg">Marketplace</h1>
      <p className="mt-1 text-sm text-fg-secondary">
        Subscribe to third-party databases. Each database has its own monthly price. Payment is collected by Stripe.
      </p>

      {checkout === "cancel" && (
        <output className="mt-4 block rounded-lg border border-border px-3 py-2 text-sm text-fg-secondary">
          Checkout was canceled. Stripe did not take a payment.
        </output>
      )}
      {confirmation.kind === "complete" && (
        <output className="mt-4 block rounded-lg border border-border px-3 py-2 text-sm text-fg-secondary">
          {confirmation.added
            ? `Subscribed to ${subscribedName ?? "that database"}. That database is now in your connections.`
            : `${subscribedName === undefined ? "Subscribed." : `Subscribed to ${subscribedName}.`} Stripe has the payment.`}
        </output>
      )}
      {confirmation.kind === "incomplete" && (
        <p role="alert" className="mt-4 rounded-lg border border-border px-3 py-2 text-sm text-fg-secondary">
          Checkout returned from Stripe, but the subscription could not be confirmed.
        </p>
      )}
      {subscribeError !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {subscribeError}
        </p>
      )}
      {cancelError !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {cancelError}
        </p>
      )}

      {load.kind === "loading" && <p className="mt-6 text-sm text-fg-secondary">Reading the marketplace...</p>}
      {load.kind === "failed" && (
        <p className="mt-6 text-sm text-fg-secondary">
          The marketplace could not be read. Reload the page to try again.
        </p>
      )}
      {load.kind === "ready" && (
        <>
          <label className="mt-6 block text-xs font-medium text-fg-secondary" htmlFor="marketplace-search">
            Search marketplace
          </label>
          <input
            id="marketplace-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search third-party data"
            className="mt-1.5 h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-fg"
          />
          {offerings.length === 0 ? (
            <p className="mt-6 text-sm text-fg-secondary">
              No databases are listed yet. A connection you add in the editor is not listed here.
            </p>
          ) : visible.length === 0 ? (
            <p className="mt-6 text-sm text-fg-secondary">No data matches that search.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
              {visible.map((offering) => {
                const listed = subscriptions.find((row) => row.offeringId === offering.id);
                const held = listed !== undefined && holdsMarketplaceDatabase(offering.id) ? listed : undefined;
                return (
                  <li key={offering.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg">{offering.name}</p>
                      <p className="mt-0.5 text-xs text-fg-secondary">{offering.description}</p>
                      <p className="mt-1 text-xs text-fg-tertiary">{offering.priceLabel}</p>
                      {held?.status === "canceling" && (
                        <p className="mt-1 text-xs text-fg-secondary">{cancellationNotice(held.accessUntil)}</p>
                      )}
                    </div>
                    {held?.status === "active" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        disabled={pendingId === offering.id}
                        onClick={() => {
                          void cancel(offering.id);
                        }}
                      >
                        Cancel subscription
                      </Button>
                    ) : held?.status === "canceling" ? null : (
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs"
                        disabled={pendingId === offering.id}
                        onClick={() => {
                          void subscribe(offering.id);
                        }}
                      >
                        Subscribe with Stripe
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
