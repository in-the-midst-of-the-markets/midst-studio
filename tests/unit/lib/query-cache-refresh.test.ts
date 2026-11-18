import { describe, expect, test } from "bun:test";
import {
  MAX_CACHE_REFRESH_SECONDS,
  cacheIsDue,
  cacheScheduleDraft,
  cacheScheduleLabel,
  readCacheRefresh,
  readScheduleBody,
} from "@/lib/query-cache/schedule";
import { refreshDueCaches, rerunCacheEntry, type CacheFetch } from "@/lib/query-cache/run-refresh";
import type { CacheEntry } from "@/lib/query-cache/entry";
import type { DatabaseConnection } from "@/lib/types";

const SOURCE: DatabaseConnection = {
  id: "c1",
  name: "App",
  type: "postgres",
  createdAt: new Date(0),
};

const JOIN: DatabaseConnection = {
  id: "cross-db-joins",
  name: "Cross_DB_Joins",
  type: "duckdb",
  createdAt: new Date(0),
};

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    tableName: "orders",
    sourceName: "App",
    sourceSql: "SELECT 1",
    sourceConnectionId: "c1",
    rowCount: 1,
    cachedAt: "2000-01-01T00:00:00.000Z",
    refreshSeconds: 60,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("cache refresh schedule", () => {
  test("opens the calendar on today, and on a stored clock", () => {
    const now = new Date(2026, 10, 18, 15, 0, 0);
    expect(cacheScheduleDraft(undefined, now)).toEqual({
      every: "daily",
      minuteOfDay: 9 * 60,
      startsOn: "2026-11-18",
      year: 2026,
      month: 10,
    });
    expect(cacheScheduleDraft({ refreshSeconds: 60 * 60 }, now).every).toBe("hourly");
    expect(cacheScheduleDraft({ refreshSeconds: 24 * 60 * 60 }, now).every).toBe("daily");
    expect(cacheScheduleDraft({ refreshSeconds: 120 }, now).every).toBe("off");
    expect(cacheScheduleDraft({}, now).every).toBe("daily");
    expect(
      cacheScheduleDraft({ refreshMinute: 10 * 60, refreshStartsOn: "2026-11-20", refreshSeconds: 24 * 60 * 60 }, now),
    ).toMatchObject({ every: "daily", minuteOfDay: 600, startsOn: "2026-11-20", year: 2026, month: 10 });
    expect(cacheScheduleDraft({ refreshMinute: 10 * 60, refreshStartsOn: "nope" }, now).startsOn).toBe("2026-11-18");
    expect(cacheScheduleDraft({ refreshMinute: 10 * 60 }, now).startsOn).toBe("2026-11-18");
    expect(cacheScheduleDraft({ refreshMinute: 24 * 60 }, now).every).toBe("daily");
  });

  test("names a daily clock, an hourly repeat, and a leftover interval", () => {
    expect(cacheScheduleLabel({})).toBe("");
    expect(cacheScheduleLabel({ refreshSeconds: 60 * 60 })).toBe("Hourly");
    expect(cacheScheduleLabel({ refreshSeconds: 24 * 60 * 60 })).toBe("Daily");
    expect(cacheScheduleLabel({ refreshSeconds: 120 })).toBe("every 120s");
    expect(cacheScheduleLabel({ refreshMinute: 9 * 60 }, "2026-11-18")).toBe("Daily at 9:00 AM");
    expect(cacheScheduleLabel({ refreshMinute: 9 * 60, refreshStartsOn: "2026-11-18" }, "2026-11-18")).toBe(
      "Daily at 9:00 AM",
    );
    expect(cacheScheduleLabel({ refreshMinute: 9 * 60, refreshStartsOn: "nope" }, "2026-11-18")).toBe(
      "Daily at 9:00 AM",
    );
    expect(cacheScheduleLabel({ refreshMinute: 9 * 60, refreshStartsOn: "2026-11-20" }, "2026-11-18")).toBe(
      "Daily at 9:00 AM · Nov 20",
    );
    expect(cacheScheduleLabel({ refreshMinute: 99 * 60 })).toBe("");
  });

  test("reads a stored interval, or the sentence that refuses it", () => {
    expect(readCacheRefresh(null)).toBeNull();
    expect(readCacheRefresh(60)).toBe(60);
    expect(readCacheRefresh(MAX_CACHE_REFRESH_SECONDS)).toBe(MAX_CACHE_REFRESH_SECONDS);
    expect(readCacheRefresh(0)).toContain("60");
    expect(readCacheRefresh(59)).toContain("60");
    expect(readCacheRefresh(-1)).toContain("whole number");
    expect(readCacheRefresh(1.5)).toContain("whole number");
    expect(readCacheRefresh(Number.NaN)).toContain("whole number");
    expect(readCacheRefresh(Number.POSITIVE_INFINITY)).toContain("whole number");
    expect(readCacheRefresh("60")).toContain("whole number");
    expect(readCacheRefresh(undefined)).toContain("whole number");
    expect(readCacheRefresh(MAX_CACHE_REFRESH_SECONDS + 1)).toContain("366 days");
  });

  test("a table is due once its interval has elapsed, and immediately when the time cannot be read", () => {
    const now = Date.parse("2026-01-01T00:02:00.000Z");
    expect(cacheIsDue(entry({ refreshSeconds: undefined }), now)).toBe(false);
    expect(cacheIsDue(entry({ cachedAt: "not-a-time" }), now)).toBe(true);
    expect(cacheIsDue(entry({ cachedAt: "2026-01-01T00:01:30.000Z" }), now)).toBe(false);
    expect(cacheIsDue(entry({ cachedAt: "2026-01-01T00:01:00.000Z" }), now)).toBe(true);
    expect(cacheIsDue(entry({ cachedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(true);

    const minute = 9 * 60;
    const before = new Date(2026, 10, 18, 8, 59, 0).getTime();
    const after = new Date(2026, 10, 18, 9, 1, 0).getTime();
    const daily = {
      refreshSeconds: 24 * 60 * 60,
      refreshMinute: minute,
      refreshStartsOn: "2026-11-18",
    };
    expect(cacheIsDue(entry({ ...daily, cachedAt: new Date(2026, 10, 17, 9, 0).toISOString() }), before)).toBe(false);
    expect(cacheIsDue(entry({ ...daily, cachedAt: new Date(2026, 10, 17, 9, 0).toISOString() }), after)).toBe(true);
    expect(cacheIsDue(entry({ ...daily, cachedAt: "not-a-time" }), after)).toBe(true);
    expect(cacheIsDue(entry({ ...daily, cachedAt: new Date(2026, 10, 18, 9, 0).toISOString() }), after)).toBe(false);
    expect(
      cacheIsDue(
        entry({ ...daily, cachedAt: new Date(2026, 10, 18, 9, 0).toISOString() }),
        new Date(2026, 10, 19, 9, 1).getTime(),
      ),
    ).toBe(true);
    expect(cacheIsDue(entry({ ...daily, refreshStartsOn: undefined, cachedAt: "not-a-time" }), after)).toBe(true);
    expect(cacheIsDue(entry({ ...daily, refreshStartsOn: "nope" }), before)).toBe(true);
    expect(
      cacheIsDue(entry({ refreshMinute: 30 * 60, refreshSeconds: 60, cachedAt: "2026-01-01T00:01:00.000Z" }), now),
    ).toBe(true);
    expect(
      cacheIsDue(entry({ ...daily, refreshStartsOn: "2026-11-20", cachedAt: "2000-01-01T00:00:00.000Z" }), after),
    ).toBe(false);
    expect(cacheIsDue(entry({ ...daily, refreshPaused: true, cachedAt: "2000-01-01T00:00:00.000Z" }), after)).toBe(
      false,
    );
    expect(
      cacheIsDue(entry({ refreshSeconds: 60, refreshPaused: true, cachedAt: "2000-01-01T00:00:00.000Z" }), now),
    ).toBe(false);
  });

  test("reads a schedule body", () => {
    expect(readScheduleBody({ tableName: 1 })).toContain("table name");
    expect(readScheduleBody({ tableName: "" })).toContain("table name");
    expect(readScheduleBody({ tableName: "orders" })).toContain("how often");
    expect(readScheduleBody({ tableName: "orders", refreshSeconds: 1 })).toContain("60");
    expect(readScheduleBody({ tableName: "orders", refreshSeconds: null })).toEqual({
      tableName: "orders",
      refreshSeconds: null,
      refreshMinute: null,
      refreshStartsOn: null,
    });
    expect(readScheduleBody({ tableName: "orders", refreshSeconds: 90 })).toEqual({
      tableName: "orders",
      refreshSeconds: 90,
      refreshMinute: null,
      refreshStartsOn: null,
    });
    expect(readScheduleBody({ tableName: "orders", every: "weekly" })).toContain("hourly, daily");
    expect(readScheduleBody({ tableName: "orders", every: 1 })).toContain("hourly, daily");
    expect(readScheduleBody({ tableName: "orders", every: " Hourly " })).toMatchObject({
      refreshSeconds: 60 * 60,
      refreshMinute: null,
      refreshStartsOn: null,
    });
    expect(readScheduleBody({ tableName: "orders", every: "off" })).toMatchObject({
      refreshSeconds: null,
      refreshMinute: null,
    });
    expect(readScheduleBody({ tableName: "orders", every: "daily" })).toBe("Choose a time.");
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 1.5 })).toBe("Choose a time.");
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: -1 })).toBe("Choose a time.");
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 24 * 60 })).toBe("Choose a time.");
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 9 * 60 })).toBe("Choose a day.");
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 9 * 60, startsOn: "yesterday" })).toBe(
      "Choose a day.",
    );
    expect(readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 9 * 60, startsOn: "2026-02-31" })).toBe(
      "Choose a day.",
    );
    expect(readScheduleBody({ tableName: "orders", paused: true })).toEqual({ tableName: "orders", paused: true });
    expect(readScheduleBody({ tableName: "orders", paused: false })).toEqual({ tableName: "orders", paused: false });
    expect(readScheduleBody({ tableName: "orders", paused: "yes" })).toBe("Say whether the run is paused.");
    expect(readScheduleBody({ tableName: "orders", every: "off", paused: true })).toMatchObject({
      refreshSeconds: null,
    });
    expect(
      readScheduleBody({ tableName: "orders", every: "daily", minuteOfDay: 9 * 60, startsOn: "2026-11-18" }),
    ).toEqual({
      tableName: "orders",
      refreshSeconds: 24 * 60 * 60,
      refreshMinute: 9 * 60,
      refreshStartsOn: "2026-11-18",
    });
  });

  test("reruns a source and replaces the table, and skips what it cannot rerun", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const fetchImpl: CacheFetch = async (path, init) => {
      calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/db/query") return json({ rows: [{ id: 2 }], fields: ["id"] });
      return json({ replaced: true });
    };
    const done = await rerunCacheEntry(entry(), [SOURCE], fetchImpl);
    expect(done).toEqual({ ok: true, replaced: true, rowCount: 1, tableName: "orders" });
    expect(calls[1]?.body).not.toHaveProperty("refreshSeconds");

    const fresh = await rerunCacheEntry(entry(), [SOURCE], async (path) =>
      path === "/api/db/query" ? json({ rows: [], fields: [] }) : json({}),
    );
    expect(fresh).toMatchObject({ ok: true, replaced: false, rowCount: 0 });

    expect(await rerunCacheEntry(entry({ sourceConnectionId: "gone" }), [SOURCE], fetchImpl)).toMatchObject({
      ok: false,
      message: expect.stringContaining("not open here"),
    });
    expect(await rerunCacheEntry(entry({ sourceConnectionId: JOIN.id }), [JOIN], fetchImpl)).toMatchObject({
      ok: false,
      message: expect.stringContaining("join"),
    });
    expect(await rerunCacheEntry(entry(), [SOURCE], async () => json({ error: "warehouse off" }, 500))).toMatchObject({
      ok: false,
      message: "warehouse off",
    });
    expect(await rerunCacheEntry(entry(), [SOURCE], async () => new Response("nope", { status: 500 }))).toMatchObject({
      ok: false,
      message: "The source query failed.",
    });
    expect(await rerunCacheEntry(entry(), [SOURCE], async () => json({ fields: ["id"] }))).toMatchObject({
      ok: false,
      message: "The source query failed.",
    });
    expect(await rerunCacheEntry(entry(), [SOURCE], async () => json({ rows: "nope", fields: ["id"] }))).toMatchObject({
      ok: false,
      message: "The source query failed.",
    });
    expect(await rerunCacheEntry(entry(), [SOURCE], async () => json({ rows: [], fields: "id" }))).toMatchObject({
      ok: false,
      message: "The source query failed.",
    });
    expect(
      await rerunCacheEntry(entry(), [SOURCE], async () =>
        json({ rows: [{ id: 1 }], fields: ["id"], pagination: { hasMore: true } }),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("10,000") });
    expect(
      await rerunCacheEntry(entry(), [SOURCE], async (path) =>
        path === "/api/db/query"
          ? json({ rows: Array.from({ length: 10_001 }, () => ({ id: 1 })), fields: ["id"] })
          : json({}),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("10,000") });
    expect(
      await rerunCacheEntry(entry(), [SOURCE], async (path) =>
        path === "/api/db/query" ? json({ rows: [{ id: 1 }], fields: ["id"] }) : json({ error: "disk full" }, 500),
      ),
    ).toMatchObject({ ok: false, message: "disk full" });
    expect(
      await rerunCacheEntry(entry(), [SOURCE], async (path) =>
        path === "/api/db/query" ? json({ rows: [{ id: 1 }], fields: ["id"] }) : new Response("nope", { status: 500 }),
      ),
    ).toMatchObject({ ok: false, message: "The rows could not be cached." });
    await expect(rerunCacheEntry(entry(), [SOURCE], () => Promise.reject(new Error("down")))).rejects.toThrow("down");
  });

  test("refreshes only the tables that are due, and keeps going when one source fails", async () => {
    const now = Date.parse("2026-01-01T00:02:00.000Z");
    const due = entry({ cachedAt: "2026-01-01T00:00:00.000Z" });
    const waiting = entry({ tableName: "fresh", cachedAt: "2026-01-01T00:01:30.000Z" });
    const own = entry({ tableName: "again", sourceConnectionId: "query-cache" });
    let queries = 0;
    const fetchImpl: CacheFetch = async (path) => {
      if (path === "/api/db/query-cache" && queries === 0) {
        return json({ tables: [waiting, own, due] });
      }
      if (path === "/api/db/query") {
        queries += 1;
        return json({ rows: [{ id: 1 }], fields: ["id"] });
      }
      return json({ replaced: true });
    };
    expect(await refreshDueCaches([SOURCE], fetchImpl, now)).toBe(true);
    expect(queries).toBe(1);

    await expect(refreshDueCaches([SOURCE], async () => json({ error: "locked" }, 500), now)).rejects.toThrow("locked");
    await expect(refreshDueCaches([SOURCE], async () => new Response("nope", { status: 500 }), now)).rejects.toThrow(
      "could not be read",
    );
    await expect(refreshDueCaches([SOURCE], async () => new Response("nope", { status: 200 }), now)).rejects.toThrow(
      "could not be read",
    );
    expect(await refreshDueCaches([SOURCE], async () => json({ tables: "nope" }), now)).toBe(false);
    expect(await refreshDueCaches([SOURCE], async () => json({}), now)).toBe(false);

    const asked: string[] = [];
    const mixed: CacheFetch = async (path, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { tableName?: string }) : undefined;
      if (path === "/api/db/query-cache" && body === undefined) {
        return json({
          tables: [
            entry({ tableName: "first", sourceConnectionId: "gone" }),
            entry({ tableName: "second" }),
            entry({ tableName: "third" }),
          ],
        });
      }
      if (path === "/api/db/query") {
        const sql = JSON.parse(String(init?.body)) as { connection: { id: string } };
        if (sql.connection.id === "c1" && !asked.includes("second")) {
          asked.push("second");
          return Promise.reject(new Error("down"));
        }
        asked.push("third");
        return json({ rows: [{ id: 1 }], fields: ["id"] });
      }
      asked.push(body?.tableName ?? "");
      return json({ replaced: false });
    };
    expect(await refreshDueCaches([SOURCE], mixed, now)).toBe(true);
    expect(asked).toContain("third");
    expect(asked).toContain("second");
  });
});
