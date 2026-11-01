import { afterEach, describe, expect, mock, test } from "bun:test";
import { cancelMarketplaceSubscription, listMarketplaceSubscriptions } from "@/lib/marketplace/subscription";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const FUTURE = Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1000);
const PAST = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
const FUTURE_ISO = new Date(FUTURE * 1000).toISOString();
const originalFetch = globalThis.fetch;

function page(rows: unknown[], hasMore = false): Response {
  return new Response(JSON.stringify({ data: rows, has_more: hasMore }), { status: 200 });
}

function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_abc",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: FUTURE,
    metadata: { offering_id: "opensearch", subscriber: "ada" },
    ...overrides,
  };
}

function routes(input: {
  subscriptions?: (url: string) => Response;
  sessions?: (url: string) => Response;
  cancel?: (url: string, body: string) => Response;
}): typeof fetch {
  return mock(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (init?.body !== undefined) {
      if (input.cancel === undefined) throw new Error(`unexpected cancel ${href}`);
      return input.cancel(href, String(init.body));
    }
    if (href.includes("/v1/subscriptions")) return (input.subscriptions ?? (() => page([])))(href);
    if (href.includes("/v1/checkout/sessions")) return (input.sessions ?? (() => page([])))(href);
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listMarketplaceSubscriptions", () => {
  test("lists this account's subscriptions, including canceled ones, without the Stripe id", async () => {
    const urls: string[] = [];
    const fetchImpl = routes({
      subscriptions: (url) => {
        urls.push(url);
        return page([
          subscription(),
          subscription({ id: "sub_bob", metadata: { offering_id: "postgres", subscriber: "bob" } }),
        ]);
      },
    });

    const listed = await listMarketplaceSubscriptions("sk_test_x", "ada", fetchImpl, NOW);

    expect(listed).toEqual({
      ok: true,
      subscriptions: [{ offeringId: "opensearch", status: "active", accessUntil: FUTURE_ISO }],
    });
    expect(urls).toEqual(["https://api.stripe.com/v1/subscriptions?status=all&limit=100"]);
    expect(JSON.stringify(listed)).not.toContain("sub_abc");
  });

  test("follows another page and reads the offering from the Checkout session", async () => {
    const urls: string[] = [];
    const fetchImpl = routes({
      subscriptions: (url) => {
        urls.push(url);
        if (url.includes("starting_after=")) return page([subscription({ id: "sub_legacy", metadata: {} })]);
        return page([{ id: "sub_page1" }], true);
      },
      sessions: (url) => {
        urls.push(url);
        return page([
          {
            status: "complete",
            subscription: "sub_legacy",
            client_reference_id: "opensearch",
          },
        ]);
      },
    });

    const listed = await listMarketplaceSubscriptions("sk_test_x", "ada", fetchImpl, NOW);

    expect(listed).toEqual({
      ok: true,
      subscriptions: [{ offeringId: "opensearch", status: "active", accessUntil: FUTURE_ISO }],
    });
    expect(urls[0]).toContain("status=all&limit=100");
    expect(urls[1]).toContain("status=all&limit=100&starting_after=sub_page1");
    expect(urls[2]).toBe("https://api.stripe.com/v1/checkout/sessions?limit=100");
  });

  test("an empty Stripe account is an empty list", async () => {
    const listed = await listMarketplaceSubscriptions("sk_test_x", "ada", routes({}), NOW);

    expect(listed).toEqual({ ok: true, subscriptions: [] });
  });

  test("a list Stripe does not answer is not an empty account", async () => {
    const offline = routes({
      subscriptions: () => {
        throw new Error("offline");
      },
    });
    const shapeless = routes({
      subscriptions: () => new Response(JSON.stringify({ data: "no" }), { status: 200 }),
    });
    const sessionsDown = routes({
      subscriptions: () => page([subscription()]),
      sessions: () => new Response(JSON.stringify({}), { status: 200 }),
    });

    expect(await listMarketplaceSubscriptions("sk_test_x", "ada", offline, NOW)).toEqual({ ok: false });
    expect(await listMarketplaceSubscriptions("sk_test_x", "ada", shapeless, NOW)).toEqual({ ok: false });
    expect(await listMarketplaceSubscriptions("sk_test_x", "ada", sessionsDown, NOW)).toEqual({ ok: false });
  });

  test("uses fetch and the current time when the caller passes neither", async () => {
    globalThis.fetch = routes({}) as unknown as typeof fetch;

    expect(await listMarketplaceSubscriptions("sk_test_x", "ada")).toEqual({ ok: true, subscriptions: [] });
  });
});

describe("cancelMarketplaceSubscription", () => {
  test("stops an active subscription at the end of the paid period", async () => {
    const fetchImpl = routes({
      subscriptions: () => page([subscription()]),
      cancel: (url, body) => {
        expect(url).toBe("https://api.stripe.com/v1/subscriptions/sub_abc");
        expect(body).toContain("cancel_at_period_end=true");
        expect(body).toContain("metadata%5Bsubscriber%5D=ada");
        expect(body).toContain("metadata%5Boffering_id%5D=opensearch");
        return new Response(JSON.stringify(subscription({ cancel_at_period_end: true })), { status: 200 });
      },
    });

    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", fetchImpl, NOW)).toEqual({
      ok: true,
      subscription: { offeringId: "opensearch", status: "canceling", accessUntil: FUTURE_ISO },
    });
  });

  test("reports an already ended subscription without posting again", async () => {
    const canceling = routes({
      subscriptions: () => page([subscription({ cancel_at_period_end: true })]),
      cancel: () => {
        throw new Error("should not post");
      },
    });
    const ended = routes({
      subscriptions: () => page([subscription({ status: "canceled" })]),
      cancel: () => {
        throw new Error("should not post");
      },
    });
    const periodOver = routes({
      subscriptions: () => page([subscription({ cancel_at_period_end: true, current_period_end: PAST })]),
      cancel: () => {
        throw new Error("should not post");
      },
    });

    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", canceling, NOW)).toEqual({
      ok: true,
      subscription: { offeringId: "opensearch", status: "canceling", accessUntil: FUTURE_ISO },
    });
    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", ended, NOW)).toEqual({
      ok: true,
      subscription: { offeringId: "opensearch", status: "ended", accessUntil: FUTURE_ISO },
    });
    const over = await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", periodOver, NOW);
    expect(over).toMatchObject({ ok: true, subscription: { status: "ended" } });
  });

  test("a subscription this account does not hold is missing", async () => {
    const fetchImpl = routes({
      subscriptions: () => page([subscription({ metadata: { offering_id: "opensearch", subscriber: "bob" } })]),
    });

    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", fetchImpl, NOW)).toEqual({
      ok: false,
      missing: true,
    });
  });

  test("a Stripe failure while canceling is not a missing subscription", async () => {
    const listDown = routes({
      subscriptions: () => {
        throw new Error("offline");
      },
    });
    const postDown = routes({
      subscriptions: () => page([subscription()]),
      cancel: () => new Response(JSON.stringify({ error: "no" }), { status: 400 }),
    });
    const shapeless = routes({
      subscriptions: () => page([subscription()]),
      cancel: () => new Response(JSON.stringify({ id: "nope" }), { status: 200 }),
    });

    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", listDown, NOW)).toEqual({
      ok: false,
      missing: false,
    });
    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", postDown, NOW)).toEqual({
      ok: false,
      missing: false,
    });
    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch", shapeless, NOW)).toEqual({
      ok: false,
      missing: false,
    });
  });

  test("uses fetch and the current time when the caller passes neither", async () => {
    globalThis.fetch = routes({}) as unknown as typeof fetch;

    expect(await cancelMarketplaceSubscription("sk_test_x", "ada", "opensearch")).toEqual({
      ok: false,
      missing: true,
    });
  });
});
