import "../../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { dropEndedSubscription, releaseEndedSubscriptions } from "@/lib/marketplace/release-subscription";
import { storage } from "@/lib/storage";
import type { DatabaseConnection } from "@/lib/types";

function connection(id: string): DatabaseConnection {
  return {
    id,
    name: id,
    type: "postgres",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function save(offeringId: string): void {
  storage.saveConnection(connection(`marketplace-${offeringId}`));
}

afterEach(() => {
  localStorage.clear();
});

describe("dropEndedSubscription", () => {
  test("removes the database and clears it when it is selected", () => {
    save("postgres");
    storage.saveConnection(connection("other"));
    storage.setActiveConnectionId("marketplace-postgres");

    dropEndedSubscription("postgres");

    expect(storage.getConnections().map((item) => item.id)).toEqual(["other"]);
    expect(storage.getActiveConnectionId()).toBeNull();
  });

  test("leaves a different selected connection in place", () => {
    save("postgres");
    storage.setActiveConnectionId("other");

    dropEndedSubscription("postgres");

    expect(storage.getConnections()).toEqual([]);
    expect(storage.getActiveConnectionId()).toBe("other");
  });

  test("clears a selected id that is no longer stored", () => {
    storage.setActiveConnectionId("marketplace-postgres");

    dropEndedSubscription("postgres");

    expect(storage.getActiveConnectionId()).toBeNull();
  });

  test("does nothing when that database is not selected", () => {
    storage.setActiveConnectionId("other");

    dropEndedSubscription("postgres");

    expect(storage.getConnections()).toEqual([]);
    expect(storage.getActiveConnectionId()).toBe("other");
  });
});

describe("releaseEndedSubscriptions", () => {
  test("drops every database whose subscription has ended and returns the list", async () => {
    save("postgres");
    save("opensearch");
    storage.setActiveConnectionId("marketplace-postgres");
    const fetchImpl = mock(async () => {
      return new Response(
        JSON.stringify({
          subscriptions: [
            { offeringId: "postgres", status: "ended", accessUntil: null },
            { offeringId: "opensearch", status: "active", accessUntil: "2027-01-01T00:00:00.000Z" },
            { offeringId: "", status: "ended", accessUntil: null },
            null,
          ],
        }),
        { status: 200 },
      );
    });

    const views = await releaseEndedSubscriptions(fetchImpl as unknown as typeof fetch);

    expect(views.map((view) => view.offeringId)).toEqual(["postgres", "opensearch"]);
    expect(storage.getConnections().map((item) => item.id)).toEqual(["marketplace-opensearch"]);
    expect(storage.getActiveConnectionId()).toBeNull();
  });

  test("leaves connections in place when the list cannot be read", async () => {
    save("postgres");
    const denied = mock(async () => new Response(JSON.stringify({ error: "no" }), { status: 502 }));
    const notJson = mock(async () => new Response("nope", { status: 200 }));
    const offline = mock(async () => {
      throw new Error("offline");
    });

    expect(await releaseEndedSubscriptions(denied as unknown as typeof fetch)).toEqual([]);
    expect(await releaseEndedSubscriptions(notJson as unknown as typeof fetch)).toEqual([]);
    expect(await releaseEndedSubscriptions(offline as unknown as typeof fetch)).toEqual([]);
    expect(storage.getConnections().map((item) => item.id)).toEqual(["marketplace-postgres"]);
  });

  test("uses the app fetch when the caller passes none", async () => {
    expect(await releaseEndedSubscriptions()).toEqual([]);
  });
});
