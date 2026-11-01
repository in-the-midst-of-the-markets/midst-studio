import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SubscriptionRelease } from "@/components/marketplace/SubscriptionRelease";
import { storage } from "@/lib/storage";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
  localStorage.clear();
});

describe("SubscriptionRelease", () => {
  test("drops an ended marketplace database when the app loads", async () => {
    storage.saveConnection({
      id: "marketplace-postgres",
      name: "PostgreSQL",
      type: "postgres",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    storage.setActiveConnectionId("marketplace-postgres");
    mockGlobalFetch({
      "/api/marketplace/subscriptions": {
        json: { subscriptions: [{ offeringId: "postgres", status: "ended", accessUntil: null }] },
      },
    });

    render(<SubscriptionRelease />);

    await waitFor(() => {
      expect(storage.getConnections()).toEqual([]);
    });
    expect(storage.getActiveConnectionId()).toBeNull();
  });
});
