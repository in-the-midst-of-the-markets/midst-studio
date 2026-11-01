import { describe, expect, test } from "bun:test";
import {
  cancelSubscriptionBody,
  cancellationNotice,
  checkoutSubscriptionLink,
  heldSubscriptions,
  isSubscriptionId,
  readSubscription,
  stripeListPage,
  subscriptionFromBody,
  subscriptionView,
  subscriptionsFromBody,
  type HeldSubscription,
} from "@/lib/marketplace/subscription-status";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const FUTURE = Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1000);
const PAST = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
const FUTURE_ISO = new Date(FUTURE * 1000).toISOString();

function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_abc",
    status: "active",
    current_period_end: FUTURE,
    metadata: { offering_id: "opensearch", subscriber: "ada" },
    ...overrides,
  };
}

describe("isSubscriptionId", () => {
  test("accepts a Stripe subscription id and refuses anything else", () => {
    expect(isSubscriptionId("sub_abc")).toBe(true);
    expect(isSubscriptionId("sub_")).toBe(false);
    expect(isSubscriptionId("cs_test_abc")).toBe(false);
    expect(isSubscriptionId(`sub_${"a".repeat(252)}`)).toBe(false);
  });
});

describe("readSubscription", () => {
  test("reads an open, canceling, or ended subscription", () => {
    expect(readSubscription(subscription(), NOW)).toEqual({
      subscriptionId: "sub_abc",
      status: "active",
      accessUntil: FUTURE_ISO,
    });
    for (const status of ["trialing", "past_due", "paused"]) {
      expect(readSubscription(subscription({ status }), NOW)?.status).toBe("active");
    }
    expect(readSubscription(subscription({ cancel_at_period_end: true }), NOW)?.status).toBe("canceling");
    expect(readSubscription(subscription({ cancel_at_period_end: true, current_period_end: PAST }), NOW)).toMatchObject(
      {
        status: "ended",
      },
    );
    for (const status of ["canceled", "incomplete_expired", "unpaid"]) {
      expect(readSubscription(subscription({ status }), NOW)?.status).toBe("ended");
    }
    expect(readSubscription(subscription({ status: "incomplete" }), NOW)?.status).toBe("ended");
  });

  test("reads the period end from the first subscription item, then from cancel_at", () => {
    expect(
      readSubscription(
        subscription({
          current_period_end: undefined,
          items: { data: [{ current_period_end: FUTURE }] },
        }),
        NOW,
      )?.accessUntil,
    ).toBe(FUTURE_ISO);
    expect(readSubscription(subscription({ current_period_end: undefined, cancel_at: FUTURE }), NOW)?.accessUntil).toBe(
      FUTURE_ISO,
    );
  });

  test("leaves the end empty when Stripe did not send one", () => {
    const shapes = [
      subscription({ current_period_end: undefined, items: null }),
      subscription({ current_period_end: undefined, items: [] }),
      subscription({ current_period_end: undefined, items: { data: "no" } }),
      subscription({ current_period_end: undefined, items: { data: [null] } }),
      subscription({ current_period_end: undefined, items: { data: [[]] } }),
      subscription({ current_period_end: undefined, items: { data: [{ current_period_end: "soon" }] } }),
      subscription({ current_period_end: undefined, cancel_at_period_end: true }),
    ];

    for (const shape of shapes) {
      expect(readSubscription(shape, NOW)?.accessUntil).toBeNull();
    }
    expect(
      readSubscription(subscription({ current_period_end: undefined, cancel_at_period_end: true }), NOW)?.status,
    ).toBe("canceling");
  });

  test.each([null, [[]], { id: "nope", status: "active" }, { id: "sub_abc" }, { status: "active" }])(
    "refuses a payload that is not a subscription (%j)",
    (payload) => {
      expect(readSubscription(payload, NOW)).toBeNull();
    },
  );
});

describe("checkoutSubscriptionLink", () => {
  const session = {
    id: "cs_test_abc",
    status: "complete",
    subscription: "sub_abc",
    client_reference_id: "opensearch",
  };

  test("reads the offering and the subscriber a completed session names", () => {
    expect(checkoutSubscriptionLink(session)).toEqual({
      subscriptionId: "sub_abc",
      offeringId: "opensearch",
      subscriber: null,
    });
    expect(checkoutSubscriptionLink({ ...session, metadata: { subscriber: "ada", ignored: 1 } })).toMatchObject({
      subscriber: "ada",
    });
    expect(checkoutSubscriptionLink({ ...session, metadata: { subscriber: "" } })?.subscriber).toBeNull();
    expect(checkoutSubscriptionLink({ ...session, metadata: null })?.subscriber).toBeNull();
    expect(checkoutSubscriptionLink({ ...session, metadata: [] })?.subscriber).toBeNull();
  });

  test.each([
    null,
    [[]],
    { ...session, status: "open" },
    { ...session, subscription: { id: "sub_abc" } },
    { ...session, subscription: "nope" },
    { ...session, client_reference_id: "" },
    { ...session, client_reference_id: undefined },
  ])("refuses %j", (payload) => {
    expect(checkoutSubscriptionLink(payload)).toBeNull();
  });
});

describe("stripeListPage", () => {
  test("reads a page and whether another follows it", () => {
    expect(stripeListPage({ data: [{ id: "sub_abc" }, { id: "sub_def" }], has_more: true })).toEqual({
      rows: [{ id: "sub_abc" }, { id: "sub_def" }],
      hasMore: true,
      lastId: "sub_def",
    });
    expect(stripeListPage({ data: [{ id: "sub_abc" }], has_more: false })).toMatchObject({ hasMore: false });
    expect(stripeListPage({ data: [], has_more: true })).toEqual({ rows: [], hasMore: false, lastId: null });
    expect(stripeListPage({ data: [null], has_more: true })).toMatchObject({ hasMore: false, lastId: null });
    expect(stripeListPage({ data: [{ id: 1 }], has_more: true })).toMatchObject({ hasMore: false, lastId: null });
    expect(stripeListPage({ data: [[]], has_more: true })).toMatchObject({ lastId: null });
  });

  test.each([null, [[]], { data: "no" }])("refuses %j", (payload) => {
    expect(stripeListPage(payload)).toBeNull();
  });
});

describe("heldSubscriptions", () => {
  test("keeps one subscription per offering, preferring one that is still open", () => {
    const rows = heldSubscriptions(
      [
        subscription({ id: "sub_old", status: "canceled", current_period_end: PAST }),
        subscription({ id: "sub_new" }),
        subscription({
          id: "sub_quotes",
          metadata: { offering_id: "north-quotes", subscriber: "ada" },
        }),
        subscription({ id: "sub_later", current_period_end: FUTURE + 100 }),
      ],
      [],
      "ada",
      NOW,
    );

    expect(rows.map((row) => row.subscriptionId)).toEqual(["sub_new", "sub_quotes"]);
    expect(subscriptionView(rows[0] as HeldSubscription)).toEqual({
      offeringId: "opensearch",
      status: "active",
      accessUntil: FUTURE_ISO,
    });
  });

  test("keeps the first open subscription when a later one is not better", () => {
    const rows = heldSubscriptions(
      [subscription(), subscription({ id: "sub_old", status: "canceled" })],
      [],
      "ada",
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.subscriptionId).toBe("sub_abc");
  });

  test("uses the Checkout session when the subscription itself has no offering", () => {
    const rows = heldSubscriptions(
      [{ id: "sub_legacy", status: "active", current_period_end: FUTURE }],
      [
        { status: "open", subscription: "sub_legacy", client_reference_id: "ignored" },
        {
          status: "complete",
          subscription: "sub_legacy",
          client_reference_id: "opensearch",
          metadata: { subscriber: "ada" },
        },
      ],
      "ada",
      NOW,
    );

    expect(rows).toEqual([
      { subscriptionId: "sub_legacy", offeringId: "opensearch", status: "active", accessUntil: FUTURE_ISO },
    ]);
  });

  test("hides a subscription stamped for someone else and keeps one with no subscriber", () => {
    const legacy = heldSubscriptions(
      [{ id: "sub_legacy", status: "active", current_period_end: FUTURE }],
      [{ status: "complete", subscription: "sub_legacy", client_reference_id: "opensearch" }],
      "ada",
      NOW,
    );
    const hidden = heldSubscriptions(
      [subscription({ metadata: { offering_id: "opensearch", subscriber: "bob" } })],
      [],
      "ada",
      NOW,
    );
    const stampedOnTheSession = heldSubscriptions(
      [{ id: "sub_legacy", status: "active", current_period_end: FUTURE }],
      [
        {
          status: "complete",
          subscription: "sub_legacy",
          client_reference_id: "opensearch",
          metadata: { subscriber: "bob" },
        },
      ],
      "ada",
      NOW,
    );
    const rowWins = heldSubscriptions(
      [subscription({ metadata: { offering_id: "postgres", subscriber: "bob" } })],
      [
        {
          status: "complete",
          subscription: "sub_abc",
          client_reference_id: "opensearch",
          metadata: { subscriber: "ada" },
        },
      ],
      "ada",
      NOW,
    );

    expect(legacy).toHaveLength(1);
    expect(hidden).toEqual([]);
    expect(stampedOnTheSession).toEqual([]);
    expect(rowWins).toEqual([]);
  });

  test("skips a row that does not name an offering or is not a subscription", () => {
    const rows = heldSubscriptions(
      [
        null,
        [],
        { id: 1, status: "active", metadata: { offering_id: "opensearch" } },
        { id: "sub_bare", status: "active" },
        { metadata: { offering_id: "opensearch", subscriber: "ada" } },
        "nope",
      ],
      [{ status: "complete", subscription: "sub_missing", client_reference_id: "postgres" }],
      "ada",
      NOW,
    );

    expect(rows).toEqual([]);
  });

  test("falls back to the session offering when the subscription's own is blank", () => {
    const rows = heldSubscriptions(
      [subscription({ metadata: { offering_id: "", subscriber: "" } })],
      [{ status: "complete", subscription: "sub_abc", client_reference_id: "opensearch" }],
      "ada",
      NOW,
    );

    expect(rows.map((row) => row.offeringId)).toEqual(["opensearch"]);
  });
});

describe("subscription bodies", () => {
  const view = { offeringId: "opensearch", status: "canceling" as const, accessUntil: FUTURE_ISO };

  test("reads one subscription and a list, and drops a row that is not one", () => {
    expect(subscriptionFromBody(view)).toEqual(view);
    expect(subscriptionFromBody({ ...view, accessUntil: null })).toEqual({ ...view, accessUntil: null });
    expect(subscriptionsFromBody({ subscriptions: [view, { offeringId: "" }, null, { status: "active" }] })).toEqual([
      view,
    ]);
    expect(subscriptionsFromBody(null)).toEqual([]);
    expect(subscriptionsFromBody([])).toEqual([]);
    expect(subscriptionsFromBody({ subscriptions: "no" })).toEqual([]);
  });

  test.each([
    null,
    [[]],
    { offeringId: "", status: "active", accessUntil: null },
    { offeringId: "opensearch", status: "open", accessUntil: null },
    { offeringId: "opensearch", status: "active", accessUntil: 1 },
  ])("refuses %j", (payload) => {
    expect(subscriptionFromBody(payload)).toBeNull();
  });
});

describe("cancellationNotice", () => {
  test("names the last day the database stays, in UTC", () => {
    expect(cancellationNotice("2026-03-01T00:00:00.000Z")).toBe(
      "Cancels on March 1, 2026. This database stays in your connections until then.",
    );
    expect(cancellationNotice(null)).toBe("This database stays in your connections until the subscription ends.");
    expect(cancellationNotice("not-a-date")).toBe(
      "This database stays in your connections until the subscription ends.",
    );
  });
});

describe("cancelSubscriptionBody", () => {
  test("stops the subscription at the period end and stamps who canceled it", () => {
    expect(cancelSubscriptionBody("ada", "opensearch")).toBe(
      "cancel_at_period_end=true&metadata%5Bsubscriber%5D=ada&metadata%5Boffering_id%5D=opensearch",
    );
  });
});
