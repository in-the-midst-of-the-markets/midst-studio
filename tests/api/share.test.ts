import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { DatabaseProvider } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { readShare, writeShare, type ShareRecord } from "@/lib/dashboards/share-record";

let provider: DatabaseProvider = createMockProvider();
let storedConnections: unknown = null;
const mockGetOrCreateProvider = mock(async () => provider);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "admin",
    username: "admin",
  }),
);
const mockResolve = mock(async (body: { connection?: unknown; connectionId?: string }) => {
  if (typeof body.connectionId === "string") {
    throw new SeedConnectionError(
      "Connection not found: it does not exist or is not granted to you",
      404,
      ApiErrorCode.CONNECTION_NOT_FOUND,
    );
  }
  if (!body.connection) throw new SeedConnectionError("Either connection or connectionId is required", 400);
  if ((body.connection as { id?: string }).id === "custom") {
    throw new SeedConnectionError("Custom connections are disabled on this server", 403, ApiErrorCode.AUTH_ERROR);
  }
  return body.connection;
});

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

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () =>
    storedConnections === null ? null : { getCollection: async () => storedConnections },
}));

mock.module("@/lib/seed/resolve-connection", () => ({
  SeedConnectionError,
  resolveConnection: mockResolve,
}));

const realDb = await import("@/lib/db");
mock.module("@/lib/db", () => ({
  ...realDb,
  getOrCreateProvider: mockGetOrCreateProvider,
}));

const { POST: publish } = await import("@/app/api/share/route");
const { GET, DELETE } = await import("@/app/api/share/[id]/route");
const { POST: queryShare } = await import("@/app/api/share/[id]/query/route");
const { POST: refresh } = await import("@/app/api/share/[id]/refresh/route");

const connection = {
  id: "c1",
  name: "App",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "app",
  createdAt: new Date().toISOString(),
};

const sheet: QueryResult = {
  rows: [{ region: "east", total: 2 }],
  fields: ["region", "total"],
  rowCount: 1,
  executionTime: 1,
};

let directory = "";
let queryMax: string | undefined;

function useDataDir(): void {
  directory = mkdtempSync(join(tmpdir(), "share-api-"));
  process.env.STORAGE_SQLITE_PATH = join(directory, "libredb.db");
}

function board(extra: Record<string, unknown> = {}) {
  return {
    dashboard: {
      id: "dash",
      name: "Sales",
      charts: [{ chartId: "revenue", width: 480, height: 320 }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    charts: [
      {
        id: "revenue",
        token: "c_abc12345",
        name: "Revenue",
        chartType: "bar",
        xAxis: "region",
        yAxis: ["total"],
        query: "SELECT region, total FROM sales",
        connectionId: "c1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    connections: [connection],
    ...extra,
  };
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  clearRateLimitState();
  useDataDir();
  provider = createMockProvider({ queryResult: sheet });
  mockGetOrCreateProvider.mockClear();
  mockGetOrCreateProvider.mockImplementation(async () => provider);
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  mockResolve.mockClear();
  storedConnections = null;
});

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
  if (queryMax === undefined) delete process.env.RATE_LIMIT_QUERY_MAX;
  else process.env.RATE_LIMIT_QUERY_MAX = queryMax;
  queryMax = undefined;
});

describe("dashboard share", () => {
  test("publish, refresh and delete require a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect(
      (await publish(createMockRequest("/api/share", { method: "POST", body: { probe: true } }) as never)).status,
    ).toBe(401);
    expect(
      (await refresh(createMockRequest("/api/share/x/refresh", { method: "POST", body: { probe: true } }) as never))
        .status,
    ).toBe(401);
    expect((await DELETE(createMockRequest("/api/share/x", { method: "DELETE" }) as never, context("x"))).status).toBe(
      401,
    );
  });

  test("a connection on the request is resolved before a snapshot is built", async () => {
    const response = await publish(
      createMockRequest("/api/share", { method: "POST", body: { connectionId: "seed:orders" } }) as never,
    );
    expect(response.status).toBe(404);
    expect(await parseResponseJSON(response)).toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    const refreshed = await refresh(
      createMockRequest("/api/share/x/refresh", { method: "POST", body: { connection: { id: "custom" } } }) as never,
    );
    expect(refreshed.status).toBe(403);
  });

  test("copies the chart and lets a visitor read only the snapshot", async () => {
    const created = await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never);
    expect(created.status).toBe(200);
    const body = await parseResponseJSON<{ id: string; frozen: unknown[] }>(created);
    expect(body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(body.frozen).toEqual([]);

    mockGetSession.mockResolvedValue(null);
    const described = await GET(createMockRequest(`/api/share/${body.id}`) as never, context(body.id));
    const view = await parseResponseJSON<{ charts: { query?: string; connectionId?: string }[]; sources?: unknown }>(
      described,
    );
    expect(view.charts[0]?.query).toBe('SELECT * FROM "c_abc12345"');
    expect(view.charts[0]?.connectionId).toBeUndefined();
    expect(view.sources).toBeUndefined();

    const rows = await queryShare(
      createMockRequest(`/api/share/${body.id}/query`, {
        method: "POST",
        body: { sql: 'SELECT region, total FROM "c_abc12345"' },
      }) as never,
      context(body.id),
    );
    expect(rows.status).toBe(200);
    expect((await parseResponseJSON<{ rows: { region: string }[] }>(rows)).rows[0]?.region).toBe("east");

    const write = await queryShare(
      createMockRequest(`/api/share/${body.id}/query`, {
        method: "POST",
        body: { sql: 'DELETE FROM "c_abc12345"' },
      }) as never,
      context(body.id),
    );
    expect(write.status).toBe(400);
    const foreign = await queryShare(
      createMockRequest(`/api/share/${body.id}/query`, {
        method: "POST",
        body: { sql: "SELECT * FROM other" },
      }) as never,
      context(body.id),
    );
    expect(foreign.status).toBe(400);

    mockGetSession.mockResolvedValue({ role: "user", username: "other" });
    expect(
      (await DELETE(createMockRequest(`/api/share/${body.id}`, { method: "DELETE" }) as never, context(body.id)))
        .status,
    ).toBe(404);
    mockGetSession.mockResolvedValue({ role: "admin", username: "admin" });
    expect(
      (await DELETE(createMockRequest(`/api/share/${body.id}`, { method: "DELETE" }) as never, context(body.id)))
        .status,
    ).toBe(200);
    expect((await GET(createMockRequest(`/api/share/${body.id}`) as never, context(body.id))).status).toBe(404);
  });

  test("keeps the current result when a filter column was not copied, and replaces only the owner's link", async () => {
    provider.query = mock(async () => ({ rows: [{ total: 1 }], fields: ["total"], rowCount: 1, executionTime: 1 }));
    const created = await publish(
      createMockRequest("/api/share", {
        method: "POST",
        body: board({
          dashboard: {
            id: "dash",
            name: "Sales",
            charts: [{ chartId: "revenue", width: 480, height: 320 }],
            filters: [{ id: "filter-1", name: "region", query: "", value: "east" }],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          charts: [
            {
              id: "revenue",
              token: "c_abc12345",
              name: "Revenue",
              chartType: "bar",
              xAxis: "total",
              yAxis: ["total"],
              query: "SELECT total FROM sales WHERE region = {{region}}",
              connectionId: "c1",
              refreshSeconds: 60,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      }) as never,
    );
    const body = await parseResponseJSON<{ id: string; refreshedAt: string; frozen: { reason: string }[] }>(created);
    expect(created.status).toBe(200);
    expect(body.frozen.some((note) => note.reason.includes("not a column"))).toBe(true);

    const again = await publish(
      createMockRequest("/api/share", { method: "POST", body: board({ id: body.id }) }) as never,
    );
    expect((await parseResponseJSON<{ id: string }>(again)).id).toBe(body.id);

    mockGetSession.mockResolvedValue({ role: "user", username: "other" });
    expect(
      (await publish(createMockRequest("/api/share", { method: "POST", body: board({ id: body.id }) }) as never))
        .status,
    ).toBe(404);

    mockGetSession.mockResolvedValue({ role: "admin", username: "admin" });
    provider.query = mock(async () => {
      throw new Error("down");
    });
    const forced = await refresh(
      createMockRequest(`/api/share/${body.id}/refresh`, {
        method: "POST",
        body: { force: true, connections: [connection] },
      }) as never,
      context(body.id),
    );
    expect(forced.status).toBe(400);

    provider = createMockProvider({
      queryResult: { rows: [{ region: "west", total: 9 }], fields: ["region", "total"], rowCount: 1, executionTime: 1 },
    });
    mockGetOrCreateProvider.mockImplementation(async () => provider);
    const updated = await refresh(
      createMockRequest(`/api/share/${body.id}/refresh`, {
        method: "POST",
        body: { force: true, connections: [connection] },
      }) as never,
      context(body.id),
    );
    expect(updated.status).toBe(200);
    const quiet = await refresh(
      createMockRequest(`/api/share/${body.id}/refresh`, {
        method: "POST",
        body: { connections: [connection] },
      }) as never,
      context(body.id),
    );
    expect((await parseResponseJSON<{ refreshedAt: string }>(quiet)).refreshedAt).toBe(
      (await parseResponseJSON<{ refreshedAt: string }>(updated)).refreshedAt,
    );

    const saved = readShare(body.id);
    writeShare({
      ...(saved as ShareRecord),
      refreshSeconds: 60,
      refreshedAt: "2020-01-01T00:00:00.000Z",
    });
    storedConnections = [connection];
    const visitor = await queryShare(
      createMockRequest(`/api/share/${body.id}/query`, {
        method: "POST",
        body: { sql: 'SELECT total FROM "c_abc12345"' },
      }) as never,
      context(body.id),
    );
    expect(visitor.status).toBe(200);
    expect((await GET(createMockRequest(`/api/share/${body.id}`) as never, context(body.id))).status).toBe(200);
  });

  test("refuses a snapshot that is not one, a query that is not one statement, and a hammered read", async () => {
    expect((await publish(createMockRequest("/api/share", { method: "POST", body: {} }) as never)).status).toBe(400);
    expect(
      (
        await publish(
          new Request("http://localhost:3000/api/share", {
            method: "POST",
            body: "{",
            headers: { "content-type": "application/json" },
          }) as never,
        )
      ).status,
    ).toBe(400);
    expect(
      (await publish(createMockRequest("/api/share", { method: "POST", body: board({ charts: [] }) }) as never)).status,
    ).toBe(400);
    expect(
      (await refresh(createMockRequest("/api/share/x/refresh", { method: "POST", body: { force: true } }) as never))
        .status,
    ).toBe(404);
    expect(
      (
        await queryShare(
          createMockRequest("/api/share/nope/query", { method: "POST", body: { sql: "SELECT 1" } }) as never,
          context("nope"),
        )
      ).status,
    ).toBe(404);
    const missing = "ab".repeat(16);
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${missing}/query`, { method: "POST", body: { sql: "SELECT 1" } }) as never,
          context(missing),
        )
      ).status,
    ).toBe(404);
    expect((await GET(createMockRequest(`/api/share/${missing}`) as never, context(missing))).status).toBe(404);

    const created = await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never);
    const id = (await parseResponseJSON<{ id: string }>(created)).id;
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${id}/query`, { method: "POST", body: {} }) as never,
          context(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${id}/query`, { method: "POST", body: { sql: "   " } }) as never,
          context(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${id}/query`, { method: "POST", body: { sql: "x".repeat(100_001) } }) as never,
          context(id),
        )
      ).status,
    ).toBe(400);

    provider = createMockProvider({
      queryResult: {
        rows: Array.from({ length: 51 }, (_, index) => ({ id: index })),
        fields: ["id"],
        rowCount: 51,
        executionTime: 1,
      },
    });
    mockGetOrCreateProvider.mockImplementation(async () => provider);
    const wide = await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never);
    expect(wide.status).toBe(400);

    provider.query = mock(async () => {
      throw new Error("down");
    });
    expect((await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never)).status).toBe(
      400,
    );

    clearRateLimitState();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await GET(createMockRequest(`/api/share/${missing}`) as never, context(missing))).status).toBe(404);
    }
    expect((await GET(createMockRequest(`/api/share/${missing}`) as never, context(missing))).status).toBe(429);

    queryMax = process.env.RATE_LIMIT_QUERY_MAX;
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    clearRateLimitState();
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${id}/query`, {
            method: "POST",
            body: { sql: 'SELECT region FROM "c_abc12345"' },
          }) as never,
          context(id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await queryShare(
          createMockRequest(`/api/share/${id}/query`, {
            method: "POST",
            body: { sql: 'SELECT region FROM "c_abc12345"' },
          }) as never,
          context(id),
        )
      ).status,
    ).toBe(429);
  });

  test("a refresh with no connections waits, and a seed refusal from the query itself is not a snapshot error", async () => {
    const created = await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never);
    const createdBody = await parseResponseJSON<{ id: string; refreshedAt: string }>(created);
    const waited = await refresh(
      createMockRequest(`/api/share/${createdBody.id}/refresh`, { method: "POST", body: { force: true } }) as never,
      context(createdBody.id),
    );
    expect((await parseResponseJSON<{ refreshedAt: string }>(waited)).refreshedAt).toBe(createdBody.refreshedAt);

    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new SeedConnectionError(
        "Connection not found: it does not exist or is not granted to you",
        404,
        ApiErrorCode.CONNECTION_NOT_FOUND,
      );
    });
    const refused = await publish(createMockRequest("/api/share", { method: "POST", body: board() }) as never);
    expect(refused.status).toBe(404);
  });
});
