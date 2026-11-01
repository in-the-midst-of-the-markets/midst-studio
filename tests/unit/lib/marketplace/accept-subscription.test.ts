import "../../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { acceptSubscribedConnection, subscribedConnection } from "@/lib/marketplace/accept-subscription";
import { storage } from "@/lib/storage";

const saved = {
  id: "marketplace-postgres",
  name: "PostgreSQL",
  type: "postgres",
  host: "db.example",
  port: 5432,
  user: "app",
  password: "s3cret",
  database: "trades",
  schema: "public",
  connectionString: "postgresql://app:s3cret@db.example:5432/trades",
  ssl: { mode: "require" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  localStorage.clear();
});

describe("subscribedConnection", () => {
  test("reads the database Checkout returned", () => {
    expect(subscribedConnection(saved)).toMatchObject({
      id: "marketplace-postgres",
      host: "db.example",
      port: 5432,
      password: "s3cret",
      schema: "public",
      connectionString: saved.connectionString,
      ssl: { mode: "require" },
    });
    expect(subscribedConnection(saved)?.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("rejects a body that is not a connection", () => {
    expect(subscribedConnection(null)).toBeNull();
    expect(subscribedConnection([])).toBeNull();
    expect(subscribedConnection("postgres")).toBeNull();
    expect(subscribedConnection({ ...saved, id: "" })).toBeNull();
    expect(subscribedConnection({ ...saved, name: 1 })).toBeNull();
    expect(subscribedConnection({ ...saved, type: "" })).toBeNull();
    expect(subscribedConnection({ ...saved, createdAt: 1 })).toBeNull();
    expect(subscribedConnection({ ...saved, createdAt: "nope" })).toBeNull();
    expect(subscribedConnection({ ...saved, port: 1.5, ssl: null }).port).toBeUndefined();
    expect(subscribedConnection({ ...saved, ssl: [] })?.ssl).toBeUndefined();
    expect(subscribedConnection({ ...saved, ssl: { mode: "prefer" } })?.ssl).toBeUndefined();
    expect(subscribedConnection({ ...saved, ssl: { mode: "verify-system" } })?.ssl).toEqual({ mode: "verify-system" });
  });
});

describe("acceptSubscribedConnection", () => {
  test("saves the database, selects it, and keeps the first date when it arrives again", () => {
    expect(acceptSubscribedConnection({ id: 1 })).toBe(false);
    expect(storage.getConnections()).toHaveLength(0);

    expect(acceptSubscribedConnection(saved)).toBe(true);
    expect(storage.getActiveConnectionId()).toBe("marketplace-postgres");
    const first = storage.getConnections()[0]?.createdAt;

    expect(acceptSubscribedConnection({ ...saved, host: "next.example", createdAt: "2026-06-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(storage.getConnections()).toHaveLength(1);
    expect(storage.getConnections()[0]).toMatchObject({ host: "next.example", createdAt: first });
  });
});
