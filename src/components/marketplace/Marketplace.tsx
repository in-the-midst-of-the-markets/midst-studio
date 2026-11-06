"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Calendar, Clock, Database, List, Search } from "lucide-react";
import { appFetch } from "@/lib/config/base-path";
import { acceptSubscribedConnection } from "@/lib/marketplace/accept-subscription";
import type { PublicMarketplaceOffering } from "@/lib/marketplace/catalog";
import { dropEndedSubscription, releaseEndedSubscriptions } from "@/lib/marketplace/release-subscription";
import {
  accessUntilLabel,
  CANCELLATION_DETAIL,
  cancellationNotice,
  splitPriceLabel,
  subscriptionFromBody,
  type SubscriptionView,
} from "@/lib/marketplace/subscription-status";
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

function heldSubscription(
  subscriptions: readonly SubscriptionView[],
  offeringId: string,
): SubscriptionView | undefined {
  const listed = subscriptions.find((row) => row.offeringId === offeringId);
  return listed !== undefined && holdsMarketplaceDatabase(offeringId) ? listed : undefined;
}

function OfferingMark({ description }: { description: string }) {
  const Icon = /index|search/i.test(description) ? List : Database;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
    </span>
  );
}

function StatusBadge({ held }: { held: SubscriptionView | undefined }) {
  if (held?.status === "canceling") {
    return <span className="rounded-full bg-fill px-2 py-0.5 text-xs font-medium text-fg-secondary">Canceling</span>;
  }
  if (held?.status === "active") {
    return <span className="rounded-full bg-brand-tint/20 px-2 py-0.5 text-xs font-medium text-brand">Subscribed</span>;
  }
  return <span className="rounded-full bg-brand-tint/20 px-2 py-0.5 text-xs font-medium text-brand">Available</span>;
}

function OfferingCard({
  offering,
  held,
  pending,
  onSubscribe,
  onCancel,
}: {
  offering: PublicMarketplaceOffering;
  held: SubscriptionView | undefined;
  pending: boolean;
  onSubscribe: () => void;
  onCancel: () => void;
}) {
  const price = splitPriceLabel(offering.priceLabel);
  const until = held?.status === "canceling" ? accessUntilLabel(held.accessUntil) : null;
  const notice = held?.status === "canceling" ? cancellationNotice(held.accessUntil) : null;
  return (
    <li className="rounded-2xl border border-hairline bg-raised shadow-sm">
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <OfferingMark description={offering.description} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-fg">{offering.name}</p>
            <StatusBadge held={held} />
          </div>
          <p className="mt-0.5 text-sm text-fg-muted">{offering.description}</p>
        </div>
        <p className="text-sm text-fg-muted">
          <span className="text-lg font-semibold text-fg">{price.amount}</span>
          {price.period !== null && <span> {price.period}</span>}
        </p>
        {held?.status === "active" ? (
          <button
            type="button"
            className="h-9 rounded-lg border border-hairline bg-raised px-3 text-sm font-medium text-fg-secondary hover:bg-fill"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel subscription
          </button>
        ) : held?.status === "canceling" ? (
          until !== null && (
            <p className="flex items-center gap-1.5 text-sm text-fg-secondary">
              <Clock aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              {until}
            </p>
          )
        ) : (
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-solid px-3.5 text-sm font-medium text-white hover:bg-brand-solid-hover disabled:opacity-50"
            disabled={pending}
            onClick={onSubscribe}
          >
            Subscribe with Stripe
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {notice !== null && (
        <div className="flex items-start gap-3 border-t border-hairline px-5 py-3">
          <Calendar aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
          <div>
            <p className="text-sm font-medium text-fg">{notice}</p>
            {until !== null && <p className="text-sm text-fg-muted">{CANCELLATION_DETAIL}</p>}
          </div>
        </div>
      )}
    </li>
  );
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
    <main>
      <h1 className="text-3xl font-semibold tracking-tight text-fg">Marketplace</h1>
      <p className="mt-2 max-w-xl text-sm text-fg-secondary">
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
          {offerings.length > 0 && (
            <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
              <div className="flex items-center gap-2 pb-1">
                <h2 className="text-sm font-medium text-fg">Databases</h2>
                <span className="rounded-full bg-fill px-2 py-0.5 text-xs text-fg-secondary">{visible.length}</span>
              </div>
              <label className="block text-xs text-fg-muted" htmlFor="marketplace-search">
                Search marketplace
                <span className="relative mt-1.5 block">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-muted"
                    strokeWidth={1.75}
                  />
                  <input
                    id="marketplace-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search third-party data"
                    className="h-10 w-full rounded-lg border border-hairline bg-raised pr-3 pl-9 text-sm text-fg sm:w-72"
                  />
                </span>
              </label>
            </div>
          )}
          {offerings.length === 0 ? (
            <p className="mt-6 text-sm text-fg-secondary">
              No databases are listed yet. A connection you add in the editor is not listed here.
            </p>
          ) : visible.length === 0 ? (
            <p className="mt-6 text-sm text-fg-secondary">No data matches that search.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {visible.map((offering) => (
                <OfferingCard
                  key={offering.id}
                  offering={offering}
                  held={heldSubscription(subscriptions, offering.id)}
                  pending={pendingId === offering.id}
                  onSubscribe={() => {
                    void subscribe(offering.id);
                  }}
                  onCancel={() => {
                    void cancel(offering.id);
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
