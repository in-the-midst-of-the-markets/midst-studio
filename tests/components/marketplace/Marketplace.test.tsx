import "../../setup-dom";
import { resetMockSearchParams, setMockSearchParams } from "../../helpers/mock-navigation";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import { Marketplace } from "@/components/marketplace/Marketplace";
import { storage } from "@/lib/storage";

const TRADES = {
  id: "acme-trades",
  name: "Acme Trades",
  description: "Tick history for listed names",
  priceLabel: "$49/month",
};

const QUOTES = {
  id: "north-quotes",
  name: "North Quotes",
  description: "End of day quotes",
  priceLabel: "$12/month",
};

function deferred(): {
  promise: Promise<MockFetchResponse>;
  resolve: (value: MockFetchResponse) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: MockFetchResponse) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<MockFetchResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
  resetMockSearchParams();
  localStorage.clear();
});

describe("Marketplace", () => {
  test("shows an empty shop when nothing is listed", async () => {
    mockGlobalFetch({ "/api/marketplace/offerings": { json: { offerings: [] } } });

    render(<Marketplace />);

    expect(screen.getByText("Reading the marketplace...")).not.toBeNull();
    expect(
      await screen.findByText("No databases are listed yet. A connection you add in the editor is not listed here."),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Subscribe to third-party databases. Each database has its own monthly price. Payment is collected by Stripe.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("$5/month")).toBeNull();
  });

  test("treats a catalog that is not a list as empty", async () => {
    mockGlobalFetch({ "/api/marketplace/offerings": { json: { offerings: {} } } });

    render(<Marketplace />);

    expect(
      await screen.findByText("No databases are listed yet. A connection you add in the editor is not listed here."),
    ).not.toBeNull();
  });

  test("says when the catalog cannot be read, including a checkout Stripe did not confirm", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    mockGlobalFetch({
      "/api/marketplace/offerings": { status: 500, json: { error: "down" } },
      "/api/marketplace/checkout": { status: 502, json: { error: "down" } },
    });

    render(<Marketplace />);

    expect(await screen.findByText("The marketplace could not be read. Reload the page to try again.")).not.toBeNull();
    expect(
      screen.getByText("Checkout returned from Stripe, but the subscription could not be confirmed."),
    ).not.toBeNull();
  });

  test("filters by name and by description", async () => {
    mockGlobalFetch({ "/api/marketplace/offerings": { json: { offerings: [TRADES, QUOTES] } } });

    render(<Marketplace />);
    const search = await screen.findByLabelText("Search marketplace");

    fireEvent.change(search, { target: { value: "  " } });
    expect(screen.getByText("Acme Trades")).not.toBeNull();
    expect(screen.getByText("North Quotes")).not.toBeNull();

    fireEvent.change(search, { target: { value: "Acme" } });
    expect(screen.getByText("Acme Trades")).not.toBeNull();
    expect(screen.queryByText("North Quotes")).toBeNull();

    fireEvent.change(search, { target: { value: "end of day" } });
    expect(screen.queryByText("Acme Trades")).toBeNull();
    expect(screen.getByText("North Quotes")).not.toBeNull();

    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText("No data matches that search.")).not.toBeNull();
  });

  test("says checkout was canceled and that Stripe did not take a payment", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "cancel" }));
    mockGlobalFetch({ "/api/marketplace/offerings": { json: { offerings: [] } } });

    render(<Marketplace />);

    expect(await screen.findByText("Checkout was canceled. Stripe did not take a payment.")).not.toBeNull();
  });

  test.each([
    ["success without a session", { checkout: "success" }],
    ["a blank session", { checkout: "success", session_id: "" }],
  ])("does not confirm a return that is %s", async (_label, params) => {
    setMockSearchParams(new URLSearchParams(params));
    const fetchMock = mockGlobalFetch({ "/api/marketplace/offerings": { json: { offerings: [TRADES] } } });

    render(<Marketplace />);
    expect(await screen.findByText("Acme Trades")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/marketplace/checkout"))).toBe(false);
  });

  test("names the offering Stripe reported as paid", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": { json: { complete: true, offeringId: "acme-trades" } },
    });

    render(<Marketplace />);

    expect(await screen.findByText("Subscribed to Acme Trades. Stripe has the payment.")).not.toBeNull();
  });

  test("adds the subscribed database when Stripe finishes", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    mockGlobalFetch({
      "/api/marketplace/offerings": {
        json: { offerings: [{ id: "postgres", name: "PostgreSQL", description: "Tables", priceLabel: "$5/month" }] },
      },
      "/api/marketplace/checkout": {
        json: {
          complete: true,
          offeringId: "postgres",
          connection: {
            id: "marketplace-postgres",
            name: "PostgreSQL",
            type: "postgres",
            host: "db.example",
            port: 5432,
            user: "app",
            password: "s3cret",
            database: "trades",
            createdAt: "2026-01-01T00:00:00.000Z",
            ssl: { mode: "require" },
          },
        },
      },
    });

    render(<Marketplace />);

    expect(
      await screen.findByText("Subscribed to PostgreSQL. That database is now in your connections."),
    ).not.toBeNull();
    expect(storage.getConnections()[0]).toMatchObject({
      id: "marketplace-postgres",
      host: "db.example",
      password: "s3cret",
    });
    expect(storage.getActiveConnectionId()).toBe("marketplace-postgres");
  });

  test("says subscribed when the paid offering is no longer listed", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": { json: { complete: true, offeringId: "retired" } },
    });

    render(<Marketplace />);

    expect(await screen.findByText("Subscribed. Stripe has the payment.")).not.toBeNull();
  });

  test("says the subscription could not be confirmed when Stripe did not complete it", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": { json: { complete: false, offeringId: "acme-trades" } },
    });

    render(<Marketplace />);

    expect(
      await screen.findByText("Checkout returned from Stripe, but the subscription could not be confirmed."),
    ).not.toBeNull();
  });

  test("sends the browser to the Checkout URL Stripe returned", async () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": { json: { url: "https://checkout.stripe.com/c/pay/cs_test_abc" } },
    });

    render(<Marketplace />);
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe with Stripe" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_abc");
    });
    assign.mockRestore();
  });

  test("shows the error Stripe returned", async () => {
    mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": { status: 503, json: { error: "Stripe checkout is not configured" } },
    });

    render(<Marketplace />);
    fireEvent.click(await screen.findByRole("button", { name: "Subscribe with Stripe" }));

    expect(await screen.findByText("Stripe checkout is not configured")).not.toBeNull();
  });

  test("shows a generic error when checkout answers without a URL, with a bad body, or not at all", async () => {
    const show = async (checkout: MockFetchResponse | ((req: Request) => MockFetchResponse)) => {
      cleanup();
      mockGlobalFetch({
        "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
        "/api/marketplace/checkout": checkout,
      });
      render(<Marketplace />);
      fireEvent.click(await screen.findByRole("button", { name: "Subscribe with Stripe" }));
      expect(await screen.findByText("Stripe could not start checkout.")).not.toBeNull();
    };

    await show({ json: { url: 1 } });
    await show({ status: 502, json: {} });
    await show({ text: "not-json" });
    await show(() => {
      throw new Error("offline");
    });
  });

  test("ignores a second subscribe while the first Checkout is still starting", async () => {
    const pending = deferred();
    const fetchMock = mockGlobalFetch({
      "/api/marketplace/offerings": { json: { offerings: [TRADES] } },
      "/api/marketplace/checkout": () => pending.promise,
    });
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});

    render(<Marketplace />);
    const button = await screen.findByRole("button", { name: "Subscribe with Stripe" });
    fireEvent.click(button);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Subscribe with Stripe" }) as HTMLButtonElement).disabled).toBe(true);
    });
    (screen.getByRole("button", { name: "Subscribe with Stripe" }) as HTMLButtonElement).disabled = false;
    fireEvent.click(screen.getByRole("button", { name: "Subscribe with Stripe" }));

    const checkoutCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/marketplace/checkout"));
    expect(checkoutCalls()).toHaveLength(1);

    await act(async () => {
      pending.resolve({ json: { url: "https://checkout.stripe.com/c/pay/cs_test_abc" } });
    });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(checkoutCalls()).toHaveLength(1);
    assign.mockRestore();
  });

  test("ignores a catalog and a confirmation that arrive after the page is gone", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    const offerings = deferred();
    const checkout = deferred();
    mockGlobalFetch({
      "/api/marketplace/offerings": () => offerings.promise,
      "/api/marketplace/checkout": () => checkout.promise,
    });

    const view = render(<Marketplace />);
    view.unmount();
    await act(async () => {
      offerings.resolve({ json: { offerings: [TRADES] } });
      checkout.resolve({ json: { complete: true, offeringId: "acme-trades" } });
    });
  });

  test("ignores a catalog and a confirmation that fail after the page is gone", async () => {
    setMockSearchParams(new URLSearchParams({ checkout: "success", session_id: "cs_test_abc" }));
    const offerings = deferred();
    const checkout = deferred();
    mockGlobalFetch({
      "/api/marketplace/offerings": () => offerings.promise,
      "/api/marketplace/checkout": () => checkout.promise,
    });

    const view = render(<Marketplace />);
    view.unmount();
    await act(async () => {
      offerings.reject(new Error("gone"));
      checkout.reject(new Error("gone"));
    });
  });
});
