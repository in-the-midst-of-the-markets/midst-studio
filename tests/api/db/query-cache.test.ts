import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { clearRateLimitState } from "@/lib/api/rate-limit";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "user",
    username: "ada",
  }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const session = await mockGetSession();
    return session ? { kind: "authenticated" as const, session } : { kind: "anonymous" as const };
  }),
}));

const { GET, POST } = await import("@/app/api/db/query-cache/route");

const WRITE = {
  tableName: "orders",
  fields: ["id", "name"],
  rows: [{ id: 1, name: "Ada" }],
  sourceName: "App",
  sourceSql: "SELECT id, name FROM orders",
  sourceConnectionId: "c1",
};

describe("/api/db/query-cache", () => {
  const roots: string[] = [];

  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), "query-cache-api-"));
    roots.push(root);
    process.env.STORAGE_SQLITE_PATH = path.join(root, "storage.db");
    clearRateLimitState();
    mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  });

  afterEach(() => {
    delete process.env.STORAGE_SQLITE_PATH;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function get(): Promise<Response> {
    return GET(new NextRequest("http://localhost/api/db/query-cache"));
  }

  function post(body: unknown): Promise<Response> {
    return POST(
      new NextRequest("http://localhost/api/db/query-cache", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  test("requires a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    mockGetSession.mockResolvedValueOnce(null);
    expect((await post(WRITE)).status).toBe(401);
  });

  test("refuses a body that is not a cache", async () => {
    expect((await post([])).status).toBe(400);
    const named = await post({ tableName: "" });
    expect(named.status).toBe(400);
    expect(await named.json()).toMatchObject({ error: expect.stringContaining("table name") });
  });

  test("caches the rows and replaces them when the same table is cached again", async () => {
    const empty = await get();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ tables: [] });

    const created = await post(WRITE);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ tableName: "orders", rowCount: 1, replaced: false });

    const again = await post({ ...WRITE, rows: [{ id: 2, name: "Bea" }] });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ rowCount: 1, replaced: true });

    const listed = await get();
    expect(await listed.json()).toMatchObject({
      tables: [{ tableName: "orders", rowCount: 1, sourceName: "App", sourceConnectionId: "c1" }],
    });
  });

  test("answers 500 when the cache file cannot be opened", async () => {
    const root = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    writeFileSync(path.join(root, "query-cache"), "not a directory");
    const response = await post(WRITE);
    expect(response.status).toBe(500);
    const listed = await get();
    expect(listed.status).toBe(500);
  });
});
