import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";

let provider: DatabaseProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => provider);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "admin",
    username: "admin",
  }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const session = await mockGetSession();
    return session ? { kind: "authenticated", session } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code?: string,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    SeedConnectionError,
    resolveConnection: mock(async (body: { connection?: unknown; connectionId?: string }) => {
      if (typeof body.connectionId === "string") {
        if (!body.connectionId.startsWith("seed:")) throw new SeedConnectionError("Invalid connection ID format", 400);
        return {
          id: body.connectionId,
          name: "Seed",
          type: "postgres",
          host: "seed",
          port: 5432,
          database: "app",
          createdAt: new Date(),
        };
      }
      if (!body.connection) throw new SeedConnectionError("Either connection or connectionId is required", 400);
      return body.connection;
    }),
  };
});

const realDb = await import("@/lib/db");
mock.module("@/lib/db", () => ({
  ...realDb,
  getOrCreateProvider: mockGetOrCreateProvider,
}));

const { POST } = await import("@/app/api/db/saved-join/route");

const connection = {
  id: "c1",
  name: "App",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "app",
  createdAt: new Date().toISOString(),
};

function request(body: unknown): Request {
  return createMockRequest("/api/db/saved-join", { method: "POST", body });
}

describe("POST /api/db/saved-join", () => {
  beforeEach(() => {
    clearRateLimitState();
    provider = createMockProvider();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("requires a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const response = await POST(request({ sql: "SELECT 1", saved: [] }) as never);
    expect(response.status).toBe(401);
  });

  test("refuses a body that is not a join", async () => {
    const raw = new Request("http://localhost:3000/api/db/saved-join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect((await POST(raw as never)).status).toBe(400);

    const empty = await POST(request({ sql: "", saved: [] }) as never);
    expect(empty.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(empty)).error).toContain("sql");
  });

  test("joins the saved queries and only then runs the DuckDB statement", async () => {
    const response = await POST(
      request({
        sql: "SELECT orders.name, people.email FROM saved.orders JOIN saved.people ON orders.id = people.id ORDER BY orders.name",
        saved: [
          { name: "orders", query: "SELECT id, name, email FROM orders", connection },
          { name: "people", query: "SELECT id, name, email FROM people", connectionId: "seed:people" },
        ],
      }) as never,
    );
    expect(response.status).toBe(200);
    const body = await parseResponseJSON<{ rowCount: number; rows: { name: string }[] }>(response);
    expect(body.rowCount).toBe(3);
    expect(body.rows.map((row) => row.name)).toEqual(["Alice", "Bob", "Charlie"]);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(2);
  });

  test("refuses a saved query the statement does not have, and one that is not a read", async () => {
    const missing = await POST(
      request({ sql: "SELECT * FROM saved.missing", saved: [{ name: "orders", query: "SELECT 1" }] }) as never,
    );
    expect(missing.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(missing)).error).toContain("missing");

    const write = await POST(
      request({
        sql: "SELECT * FROM saved.orders",
        saved: [{ name: "orders", query: "DELETE FROM orders", connection }],
      }) as never,
    );
    expect(write.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(write)).error).toContain("has to be a read");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("refuses a saved query that came back with another page still waiting", async () => {
    provider = createMockProvider({
      prepareQueryResult: { query: "SELECT 1", wasLimited: true, limit: 1, offset: 0 },
    });
    const response = await POST(
      request({
        sql: "SELECT * FROM saved.orders",
        saved: [{ name: "orders", query: "SELECT id, name, email FROM orders", connection }],
      }) as never,
    );
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("rows");
  });

  test("names the saved query when its database fails", async () => {
    provider = createMockProvider();
    provider.query = mock(async () => {
      throw new QueryError("down", "postgres");
    });
    const response = await POST(
      request({
        sql: "SELECT * FROM saved.orders",
        saved: [{ name: "orders", query: "SELECT 1", connection }],
      }) as never,
    );
    expect(response.status).toBe(400);
    const body = await parseResponseJSON<{ error: string }>(response);
    expect(body.error).toContain("orders");
    expect(body.error).toContain("down");
  });

  test("refuses a connection named on the request before it reads the statement", async () => {
    const response = await POST(request({ connectionId: "user-1" }) as never);
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Invalid connection ID");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("keeps a connection failure's own status", async () => {
    const response = await POST(
      request({
        sql: "SELECT * FROM saved.orders",
        saved: [{ name: "orders", query: "SELECT 1", connectionId: "user-1" }],
      }) as never,
    );
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Invalid connection ID");
  });
});
