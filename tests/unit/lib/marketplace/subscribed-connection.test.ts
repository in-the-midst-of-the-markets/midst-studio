import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UserPayload } from "@/lib/auth";
import type { DatabaseConnection } from "@/lib/types";
import type { ServerStorageProvider } from "@/lib/storage/types";

const collections = new Map<string, unknown>();
const getStorageProvider = mock(async (): Promise<ServerStorageProvider | null> => null);

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider,
}));

const { connectionForSubscription, forgetMarketplaceConnection, rememberMarketplaceConnection } = await import(
  "@/lib/marketplace/subscribed-connection"
);

const session = { role: "user", username: "ada" } as UserPayload;

const postgres = {
  id: "postgres",
  name: "PostgreSQL",
  description: "Tables",
  monthlyCents: 500,
};

function provider(): ServerStorageProvider {
  return {
    getCollection: async (_userId, collection) => (collections.get(collection) ?? null) as never,
    setCollection: async (_userId, collection, data) => {
      collections.set(collection, data);
    },
  } as unknown as ServerStorageProvider;
}

afterEach(() => {
  collections.clear();
  getStorageProvider.mockReset();
  getStorageProvider.mockResolvedValue(null);
});

describe("connectionForSubscription", () => {
  test("builds the database from the environment string", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const connection = connectionForSubscription(
      postgres,
      { POSTGRES_CONNECTION_STRING: "postgresql://app:s3cret@db.example:5432/trades?sslmode=require" },
      createdAt,
    );

    expect(connection).toEqual({
      id: "marketplace-postgres",
      name: "PostgreSQL",
      type: "postgres",
      host: "db.example",
      port: 5432,
      user: "app",
      password: "s3cret",
      database: "trades",
      ssl: { mode: "require" },
      createdAt,
    });
  });

  test("prefers the catalog row's own string", () => {
    const connection = connectionForSubscription(
      { ...postgres, connectionString: "https://reader:pw@search.example:9200" },
      { POSTGRES_CONNECTION_STRING: "postgresql://db.example/app" },
    );

    expect(connection).toMatchObject({
      id: "marketplace-postgres",
      type: "opensearch",
      host: "search.example",
      port: 9200,
      user: "reader",
      password: "pw",
      ssl: { mode: "require" },
    });
  });

  test("returns null when nothing readable is configured", () => {
    expect(connectionForSubscription(postgres, {})).toBeNull();
    expect(connectionForSubscription(postgres, { POSTGRES_CONNECTION_STRING: "not a database url" })).toBeNull();
    expect(connectionForSubscription({ ...postgres, id: "acme-trades" }, {})).toBeNull();
  });
});

describe("rememberMarketplaceConnection", () => {
  const connection = {
    id: "marketplace-postgres",
    name: "PostgreSQL",
    type: "postgres",
    host: "db.example",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  } as DatabaseConnection;

  test("does nothing when server storage is off", async () => {
    await rememberMarketplaceConnection(session, connection);

    expect(collections.size).toBe(0);
  });

  test("stores the first connection when the account has none", async () => {
    getStorageProvider.mockResolvedValue(provider());

    await rememberMarketplaceConnection(session, connection);

    expect(collections.get("connections")).toEqual([connection]);
    expect(collections.get("active_connection_id")).toBe("marketplace-postgres");
  });

  test("adds the connection and selects it", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [{ id: "other", name: "Other", type: "postgres", createdAt: new Date() }]);

    await rememberMarketplaceConnection(session, connection);

    expect(collections.get("connections")).toEqual([
      { id: "other", name: "Other", type: "postgres", createdAt: expect.any(Date) },
      connection,
    ]);
    expect(collections.get("active_connection_id")).toBe("marketplace-postgres");
  });

  test("updates an existing subscription and keeps the original date", async () => {
    getStorageProvider.mockResolvedValue(provider());
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    collections.set("connections", [{ ...connection, host: "old.example", createdAt }]);

    await rememberMarketplaceConnection(session, connection);

    expect(collections.get("connections")).toEqual([{ ...connection, createdAt }]);
  });

  test("keeps the confirmation when storage throws", async () => {
    getStorageProvider.mockRejectedValue(new Error("disk full"));

    await expect(rememberMarketplaceConnection(session, connection)).resolves.toBeUndefined();
  });
});

describe("forgetMarketplaceConnection", () => {
  const connection = {
    id: "marketplace-postgres",
    name: "PostgreSQL",
    type: "postgres",
    host: "db.example",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  } as DatabaseConnection;
  const other = {
    id: "other",
    name: "Other",
    type: "postgres",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as DatabaseConnection;

  test("does nothing when server storage is off", async () => {
    await forgetMarketplaceConnection(session, connection.id);

    expect(collections.size).toBe(0);
  });

  test("removes the connection and clears it when it is selected", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [connection, other]);
    collections.set("active_connection_id", connection.id);

    await forgetMarketplaceConnection(session, connection.id);

    expect(collections.get("connections")).toEqual([other]);
    expect(collections.get("active_connection_id")).toBeNull();
  });

  test("leaves a different selected connection in place", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [connection, other]);
    collections.set("active_connection_id", other.id);

    await forgetMarketplaceConnection(session, connection.id);

    expect(collections.get("connections")).toEqual([other]);
    expect(collections.get("active_connection_id")).toBe(other.id);
  });

  test("clears a selected id that is no longer stored", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("active_connection_id", connection.id);

    await forgetMarketplaceConnection(session, connection.id);

    expect(collections.has("connections")).toBe(false);
    expect(collections.get("active_connection_id")).toBeNull();
  });

  test("leaves storage untouched when the connection is not held", async () => {
    getStorageProvider.mockResolvedValue(provider());
    collections.set("connections", [other]);
    collections.set("active_connection_id", other.id);

    await forgetMarketplaceConnection(session, connection.id);

    expect(collections.get("connections")).toEqual([other]);
    expect(collections.get("active_connection_id")).toBe(other.id);
  });

  test("keeps the account when storage throws, including a non-error", async () => {
    getStorageProvider.mockRejectedValue(new Error("disk full"));
    await expect(forgetMarketplaceConnection(session, connection.id)).resolves.toBeUndefined();

    getStorageProvider.mockRejectedValue("disk full");
    await expect(forgetMarketplaceConnection(session, connection.id)).resolves.toBeUndefined();
  });
});
