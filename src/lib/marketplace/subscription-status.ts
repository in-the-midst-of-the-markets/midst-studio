/**
 * What a Stripe subscription means for a marketplace database.
 *
 * Canceling keeps the database until the paid period ends. Only a subscription Stripe has
 * already ended, or one whose cancellation date has passed, drops the connection.
 * The Stripe secret never reaches this module. It only reads the objects Stripe returned.
 */

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const OPEN_STATUS = new Set(["active", "trialing", "past_due", "paused"]);
const ENDED_STATUS = new Set(["canceled", "incomplete_expired", "unpaid"]);

export type SubscriptionPhase = "active" | "canceling" | "ended";

/** A subscription this account can see. The Stripe id stays on the server. */
export interface SubscriptionView {
  readonly offeringId: string;
  readonly status: SubscriptionPhase;
  readonly accessUntil: string | null;
}

/** The same view plus the Stripe id the cancel request posts to. */
export interface HeldSubscription extends SubscriptionView {
  readonly subscriptionId: string;
}

export function isSubscriptionId(value: string): boolean {
  return value.length <= 255 && SUBSCRIPTION_ID.test(value);
}

function stringMetadata(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") entries[key] = item;
  }
  return entries;
}

function periodEndSeconds(row: Record<string, unknown>): number | null {
  // cancel_at is the moment access actually stops. The period end is only a fallback.
  if (typeof row.cancel_at === "number") return row.cancel_at;
  if (typeof row.current_period_end === "number") return row.current_period_end;
  const items = row.items;
  if (items !== null && typeof items === "object" && !Array.isArray(items)) {
    const data = (items as { data?: unknown }).data;
    const first = Array.isArray(data) ? data[0] : undefined;
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      const end = (first as { current_period_end?: unknown }).current_period_end;
      if (typeof end === "number") return end;
    }
  }
  return null;
}

function cancellationScheduled(row: Record<string, unknown>): boolean {
  return row.cancel_at_period_end === true || typeof row.cancel_at === "number";
}

/**
 * The access a subscription object grants at `now` (milliseconds).
 * A future `cancel_at` is a scheduled cancellation even when `cancel_at_period_end` is absent.
 * A missing or unfamiliar object is null, so a bad Stripe payload cannot be treated as ended.
 */
export function readSubscription(
  payload: unknown,
  now: number,
): { subscriptionId: string; status: SubscriptionPhase; accessUntil: string | null } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.id !== "string" || !isSubscriptionId(row.id) || typeof row.status !== "string") return null;
  const endSeconds = periodEndSeconds(row);
  const accessUntil = endSeconds === null ? null : new Date(endSeconds * 1000).toISOString();
  const scheduled = cancellationScheduled(row);
  const periodOver = scheduled && endSeconds !== null && endSeconds * 1000 <= now;
  if (ENDED_STATUS.has(row.status) || periodOver) return { subscriptionId: row.id, status: "ended", accessUntil };
  if (scheduled) return { subscriptionId: row.id, status: "canceling", accessUntil };
  if (OPEN_STATUS.has(row.status)) return { subscriptionId: row.id, status: "active", accessUntil };
  return { subscriptionId: row.id, status: "ended", accessUntil };
}

/** A completed Checkout session's subscription, when the session names one. */
export function checkoutSubscriptionLink(
  payload: unknown,
): { subscriptionId: string; offeringId: string; subscriber: string | null } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (row.status !== "complete" || typeof row.subscription !== "string" || !isSubscriptionId(row.subscription)) {
    return null;
  }
  if (typeof row.client_reference_id !== "string" || row.client_reference_id === "") return null;
  const subscriber = stringMetadata(row.metadata).subscriber;
  return {
    subscriptionId: row.subscription,
    offeringId: row.client_reference_id,
    subscriber: subscriber === undefined || subscriber === "" ? null : subscriber,
  };
}

export function stripeListPage(payload: unknown): { rows: unknown[]; hasMore: boolean; lastId: string | null } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const last = data.length === 0 ? null : data[data.length - 1];
  const lastId =
    last !== null &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    typeof (last as { id?: unknown }).id === "string"
      ? (last as { id: string }).id
      : null;
  const hasMore = (payload as { has_more?: unknown }).has_more === true && lastId !== null;
  return { rows: data, hasMore, lastId };
}

function subscriberOf(row: unknown, link: { subscriber: string | null } | undefined): string {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return link?.subscriber ?? "";
  const metadata = stringMetadata((row as { metadata?: unknown }).metadata).subscriber;
  if (metadata !== undefined && metadata !== "") return metadata;
  return link?.subscriber ?? "";
}

function offeringOf(row: unknown, link: { offeringId: string } | undefined): string | null {
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    const metadata = stringMetadata((row as { metadata?: unknown }).metadata).offering_id;
    if (metadata !== undefined && metadata !== "") return metadata;
  }
  return link?.offeringId ?? null;
}

/** One subscription per offering. An open one wins over one that is already ending or ended. */
function preferSubscriptions(rows: readonly HeldSubscription[]): HeldSubscription[] {
  const rank: Record<SubscriptionPhase, number> = { active: 0, canceling: 1, ended: 2 };
  const chosen = new Map<string, HeldSubscription>();
  for (const row of rows) {
    const prior = chosen.get(row.offeringId);
    if (prior === undefined || rank[row.status] < rank[prior.status]) chosen.set(row.offeringId, row);
  }
  return [...chosen.values()];
}

/**
 * Every subscription `username` may manage, including more than one for the same offering.
 * A subscription stamped with another account is hidden. One with no subscriber yet, including a
 * Checkout completed before subscribers were stamped, stays visible so it can still be canceled.
 */
export function subscriptionCandidates(
  subscriptions: readonly unknown[],
  sessions: readonly unknown[],
  username: string,
  now: number,
): HeldSubscription[] {
  const links = new Map<string, { offeringId: string; subscriber: string | null }>();
  for (const session of sessions) {
    const link = checkoutSubscriptionLink(session);
    if (link !== null) links.set(link.subscriptionId, link);
  }
  const found: HeldSubscription[] = [];
  for (const row of subscriptions) {
    const id =
      row !== null && typeof row === "object" && !Array.isArray(row) ? (row as { id?: unknown }).id : undefined;
    const link = typeof id === "string" ? links.get(id) : undefined;
    const offeringId = offeringOf(row, link);
    if (offeringId === null) continue;
    const subscriber = subscriberOf(row, link);
    if (subscriber !== "" && subscriber !== username) continue;
    const access = readSubscription(row, now);
    if (access === null) continue;
    found.push({ ...access, offeringId });
  }
  return found;
}

/** One subscription per offering. An open one wins over one that is already ending or ended. */
export function heldSubscriptions(
  subscriptions: readonly unknown[],
  sessions: readonly unknown[],
  username: string,
  now: number,
): HeldSubscription[] {
  return preferSubscriptions(subscriptionCandidates(subscriptions, sessions, username, now));
}

export function subscriptionView(row: HeldSubscription): SubscriptionView {
  return { offeringId: row.offeringId, status: row.status, accessUntil: row.accessUntil };
}

function isPhase(value: unknown): value is SubscriptionPhase {
  return value === "active" || value === "canceling" || value === "ended";
}

/** One subscription object from an API body, or null when the body does not carry one. */
export function subscriptionFromBody(value: unknown): SubscriptionView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.offeringId !== "string" || row.offeringId === "" || !isPhase(row.status)) return null;
  if (row.accessUntil !== null && typeof row.accessUntil !== "string") return null;
  return { offeringId: row.offeringId, status: row.status, accessUntil: row.accessUntil };
}

/** The list a subscriptions response carries. Anything else is an empty list. */
export function subscriptionsFromBody(value: unknown): SubscriptionView[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as { subscriptions?: unknown }).subscriptions;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const view = subscriptionFromBody(row);
    return view === null ? [] : [view];
  });
}

/** The second line under a dated cancellation. */
export const CANCELLATION_DETAIL = "This database stays in your connections until then.";

function accessDate(accessUntil: string | null): Date | null {
  if (accessUntil === null) return null;
  const date = new Date(accessUntil);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The short date beside a database that is already canceling, or null when the date is unknown. */
export function accessUntilLabel(accessUntil: string | null): string | null {
  const date = accessDate(accessUntil);
  if (date === null) return null;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `Access until ${formatted}`;
}

/** The sentence under a database whose cancellation is already scheduled. */
export function cancellationNotice(accessUntil: string | null): string {
  const date = accessDate(accessUntil);
  if (date === null) return "This database stays in your connections until the subscription ends.";
  const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(date);
  return `Subscription cancels ${formatted}.`;
}

/** `$5/month` splits into the amount and the period. Anything else stays one label. */
export function splitPriceLabel(label: string): { amount: string; period: string | null } {
  const match = /^(\$[\d,]+(?:\.\d{2})?)(\/month)$/.exec(label);
  if (match === null) return { amount: label, period: null };
  return { amount: match[1] ?? label, period: "/ month" };
}

/** Form body for `POST /v1/subscriptions/:id`. The subscription keeps running until the period ends. */
export function cancelSubscriptionBody(username: string, offeringId: string): string {
  const body = new URLSearchParams();
  body.set("cancel_at_period_end", "true");
  body.set("metadata[subscriber]", username);
  body.set("metadata[offering_id]", offeringId);
  return body.toString();
}
