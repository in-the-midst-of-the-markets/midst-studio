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
const { POST: schedule } = await import("@/app/api/db/query-cache/schedule/route");

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

  function postSchedule(body: unknown): Promise<Response> {
    return schedule(
      new NextRequest("http://localhost/api/db/query-cache/schedule", {
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

  test("stores a refresh interval, keeps it when the rows are replaced, and clears it", async () => {
    const missing = await postSchedule({ tableName: "orders", refreshSeconds: 120 });
    expect(missing.status).toBe(404);

    const created = await post({ ...WRITE, refreshSeconds: 120 });
    expect(created.status).toBe(200);
    const listed = await get();
    expect(await listed.json()).toMatchObject({ tables: [{ tableName: "orders", refreshSeconds: 120 }] });

    const replaced = await post({ ...WRITE, rows: [{ id: 2, name: "Bea" }] });
    expect(replaced.status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ tables: [{ refreshSeconds: 120 }] });

    const cleared = await postSchedule({ tableName: "orders", refreshSeconds: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ tableName: "orders", refreshSeconds: null });
    const after = (await (await get()).json()) as { tables: { refreshSeconds?: number }[] };
    expect(after.tables[0]).not.toHaveProperty("refreshSeconds");

    const again = await postSchedule({ tableName: "orders", refreshSeconds: 300 });
    expect(again.status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ tables: [{ refreshSeconds: 300 }] });
    expect((await postSchedule({ tableName: "other", refreshSeconds: 60 })).status).toBe(404);
  });

  test("refuses a schedule that is not a whole number of seconds at least a minute", async () => {
    expect((await postSchedule([])).status).toBe(400);
    expect((await postSchedule({ tableName: "" })).status).toBe(400);
    expect((await postSchedule({ tableName: "orders" })).status).toBe(400);
    const soon = await postSchedule({ tableName: "orders", refreshSeconds: 10 });
    expect(soon.status).toBe(400);
    expect(await soon.json()).toMatchObject({ error: expect.stringContaining("60") });
    expect((await postSchedule({ tableName: "orders", refreshSeconds: 1.5 })).status).toBe(400);
    expect((await post({ ...WRITE, refreshSeconds: "120" })).status).toBe(400);
    mockGetSession.mockResolvedValueOnce(null);
    expect((await postSchedule({ tableName: "orders", refreshSeconds: 60 })).status).toBe(401);
  });

  test("answers 500 when the schedule file cannot be opened", async () => {
    const root = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    writeFileSync(path.join(root, "query-cache"), "not a directory");
    const response = await postSchedule({ tableName: "orders", refreshSeconds: 60 });
    expect(response.status).toBe(500);
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
