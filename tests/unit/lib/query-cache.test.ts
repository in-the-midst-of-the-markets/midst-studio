import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindValue, columnType } from "@/lib/query-cache/columns";
import {
  isAppKeptConnection,
  isQueryCache,
  queryCacheConnection,
  QUERY_CACHE_ID,
  withQueryCache as listWithCache,
} from "@/lib/query-cache/connection";
import { cacheTableNameError, readCacheBody } from "@/lib/query-cache/body";
import { QueryCacheError, QUERY_CACHE_MAX_ROWS } from "@/lib/query-cache/limits";
import { isInsideQueryCache, queryCacheFile } from "@/lib/query-cache/path";
import { cacheQueryResult, listCachedQueries, withQueryCache, type CacheRunner } from "@/lib/query-cache/store";
import type { CacheWrite } from "@/lib/query-cache/body";

describe("query cache names", () => {
  test("keeps the cache beside Cross_DB_Joins and drops a second copy", () => {
    const own = { id: "c1", name: "App", type: "postgres" as const, createdAt: new Date(0) };
    const cross = { id: "cross-db-joins", name: "Cross_DB_Joins", type: "duckdb" as const, createdAt: new Date(0) };
    const again = { ...cross };
    expect(listWithCache([own]).map((connection) => connection.id)).toEqual([QUERY_CACHE_ID, "c1"]);
    expect(listWithCache([cross, own, queryCacheConnection()]).map((connection) => connection.id)).toEqual([
      "cross-db-joins",
      QUERY_CACHE_ID,
      "c1",
    ]);
    expect(listWithCache([cross, again]).filter((connection) => connection.id === QUERY_CACHE_ID)).toHaveLength(1);
    expect(isQueryCache(queryCacheConnection())).toBe(true);
    expect(isQueryCache(null)).toBe(false);
    expect(isAppKeptConnection(cross)).toBe(true);
    expect(isAppKeptConnection(own)).toBe(false);
    expect(queryCacheConnection().database).toBeUndefined();
  });

  test("names a file from the user, and two names do not share one", () => {
    expect(queryCacheFile("Ada")).toContain("Ada-");
    expect(queryCacheFile("Ada/../x")).not.toContain("/../");
    expect(queryCacheFile("")).toContain("user-");
    expect(queryCacheFile("Ada")).not.toBe(queryCacheFile("ada"));
  });

  test("recognizes the cache directory and nothing outside it", () => {
    expect(isInsideQueryCache("\0")).toBe(false);
    expect(isInsideQueryCache("/tmp/notes.duckdb")).toBe(false);
    expect(isInsideQueryCache(queryCacheFile("ada"))).toBe(true);
  });

  test("treats a path it cannot resolve as outside the cache", () => {
    const realpath = spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      expect(isInsideQueryCache("/tmp/notes.duckdb")).toBe(false);
    } finally {
      realpath.mockRestore();
    }
  });

  test("walks a missing path up to a directory that exists", () => {
    const realpath = spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    try {
      expect(typeof isInsideQueryCache("/tmp/missing-cache.duckdb")).toBe("boolean");
    } finally {
      realpath.mockRestore();
    }
  });
});

describe("query cache columns", () => {
  test("picks one type and widens numbers", () => {
    expect(columnType([null, undefined])).toBe("VARCHAR");
    expect(columnType([true, false])).toBe("BOOLEAN");
    expect(columnType([1, 2])).toBe("BIGINT");
    expect(columnType([1, 1.5])).toBe("DOUBLE");
    expect(columnType([1.5, 2])).toBe("DOUBLE");
    expect(columnType([true, 1])).toBe("VARCHAR");
    expect(columnType([Number.POSITIVE_INFINITY])).toBe("VARCHAR");
  });

  test("binds a value to the column type", () => {
    expect(bindValue(null, "BIGINT")).toBeNull();
    expect(bindValue(undefined, "VARCHAR")).toBeNull();
    expect(bindValue(true, "BOOLEAN")).toBe(true);
    expect(bindValue(1, "BOOLEAN")).toBe(false);
    expect(bindValue(1.9, "BIGINT")).toBe(1);
    expect(bindValue("3", "BIGINT")).toBe(3);
    expect(bindValue("nope", "DOUBLE")).toBeNull();
    expect(bindValue(1.5, "DOUBLE")).toBe(1.5);
    expect(bindValue("ada", "VARCHAR")).toBe("ada");
    expect(bindValue(1, "VARCHAR")).toBe("1");
    expect(bindValue(true, "VARCHAR")).toBe("true");
    expect(bindValue(1n, "VARCHAR")).toBe("1");
    expect(bindValue({ id: 1 }, "VARCHAR")).toBe('{"id":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(bindValue(cyclic, "VARCHAR")).toBeNull();
  });
});

const WRITE: CacheWrite = {
  tableName: "orders",
  fields: ["id", "name", "note"],
  rows: [
    { id: 1, name: "Ada", note: null },
    { id: 2, name: "Bea", note: { kind: "vip" } },
  ],
  sourceName: "App",
  sourceSql: "SELECT id, name, note FROM orders",
  sourceConnectionId: "c1",
};

describe("query cache body", () => {
  test("accepts a result and names every reason it refuses one", () => {
    expect(cacheTableNameError("")).toContain("table name");
    expect(cacheTableNameError("1bad")).toContain("letter");
    expect(readCacheBody({ ...WRITE })).toMatchObject({ tableName: "orders" });
    expect(readCacheBody({ tableName: 1 })).toContain("table name");
    expect(readCacheBody({ ...WRITE, tableName: "" })).toContain("table name");
    expect(readCacheBody({ ...WRITE, sourceName: 1 })).toContain("source name");
    expect(readCacheBody({ ...WRITE, sourceSql: "x".repeat(100_001) })).toContain("source query");
    expect(readCacheBody({ ...WRITE, sourceConnectionId: 1 })).toContain("source connection");
    expect(readCacheBody({ ...WRITE, fields: [] })).toContain("no columns");
    expect(readCacheBody({ ...WRITE, fields: "id" })).toContain("no columns");
    expect(readCacheBody({ ...WRITE, fields: Array.from({ length: 501 }, (_, index) => `c${index}`) })).toContain(
      "columns",
    );
    expect(readCacheBody({ ...WRITE, fields: [""] })).toContain("column needs a name");
    expect(readCacheBody({ ...WRITE, fields: ["a\0"] })).toContain("column needs a name");
    expect(readCacheBody({ ...WRITE, fields: ["a".repeat(257)] })).toContain("too long");
    expect(readCacheBody({ ...WRITE, fields: ["id", "id"] })).toContain("two columns");
    expect(readCacheBody({ ...WRITE, rows: "nope" })).toContain("list");
    expect(
      readCacheBody({ ...WRITE, rows: Array.from({ length: QUERY_CACHE_MAX_ROWS + 1 }, () => ({ id: 1 })) }),
    ).toContain("10,000");
    expect(readCacheBody({ ...WRITE, rows: [1] })).toContain("object");
  });
});

describe("query cache store", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.STORAGE_SQLITE_PATH;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function useRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "query-cache-"));
    roots.push(root);
    process.env.STORAGE_SQLITE_PATH = path.join(root, "storage.db");
    return root;
  }

  test("refuses a write that has nothing to store", async () => {
    const runner: CacheRunner = {
      run: () => Promise.reject(new Error("should not run")),
    };
    await expect(cacheQueryResult(runner, { ...WRITE, tableName: "" })).rejects.toBeInstanceOf(QueryCacheError);
    await expect(cacheQueryResult(runner, { ...WRITE, fields: [] })).rejects.toThrow(/no columns/);
    await expect(
      cacheQueryResult(runner, {
        ...WRITE,
        rows: Array.from({ length: QUERY_CACHE_MAX_ROWS + 1 }, () => ({ id: 1, name: "a", note: null })),
      }),
    ).rejects.toThrow(/10,000/);
  });

  test("lists nothing until the registry exists, and reads the stored types", async () => {
    let calls = 0;
    const runner: CacheRunner = {
      run: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ rows: [] });
        return Promise.resolve({
          rows: [
            {
              table_name: 1,
              source_name: true,
              source_sql: 2n,
              source_connection_id: null,
              row_count: "4",
              cached_at: false,
            },
            {
              table_name: "orders",
              source_name: "App",
              source_sql: "SELECT 1",
              source_connection_id: "c1",
              row_count: Number.NaN,
              cached_at: "today",
            },
          ],
        });
      },
    };
    expect(await listCachedQueries(runner)).toEqual([]);
    const listed = await listCachedQueries(runner);
    expect(listed[0]).toMatchObject({
      tableName: "1",
      sourceName: "true",
      sourceSql: "2",
      rowCount: 4,
      cachedAt: "false",
    });
    expect(listed[1]?.rowCount).toBe(0);
  });

  test("writes a table and replaces it on the next cache of the same name", async () => {
    useRoot();
    const first = await withQueryCache("ada", (runner) => cacheQueryResult(runner, WRITE));
    expect(first).toEqual({ tableName: "orders", rowCount: 2, replaced: false });
    const replaced = await withQueryCache("ada", (runner) =>
      cacheQueryResult(runner, { ...WRITE, rows: [{ id: 9, name: "Cy", note: null }], sourceSql: "SELECT 9" }),
    );
    expect(replaced.replaced).toBe(true);
    expect(replaced.rowCount).toBe(1);
    const rows = await withQueryCache("ada", (runner) => runner.run("SELECT id, name FROM main.orders ORDER BY id"));
    expect(rows.rows).toEqual([{ id: "9", name: "Cy" }]);
    const listed = await withQueryCache("ada", (runner) => listCachedQueries(runner));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      tableName: "orders",
      sourceSql: "SELECT 9",
      rowCount: 1,
      sourceConnectionId: "c1",
    });
    await expect(withQueryCache("ada", async () => Promise.reject(new Error("stop")))).rejects.toThrow("stop");
  });

  test("an empty result still replaces the table", async () => {
    useRoot();
    await withQueryCache("ada", (runner) => cacheQueryResult(runner, WRITE));
    const replaced = await withQueryCache("ada", (runner) => cacheQueryResult(runner, { ...WRITE, rows: [] }));
    expect(replaced).toMatchObject({ rowCount: 0, replaced: true });
    const rows = await withQueryCache("ada", (runner) => runner.run("SELECT * FROM main.orders"));
    expect(rows.rows).toEqual([]);
  });

  test("fails when the cache directory cannot be created", async () => {
    const root = useRoot();
    writeFileSync(path.join(root, "query-cache"), "not a directory");
    await expect(withQueryCache("ada", (runner) => listCachedQueries(runner))).rejects.toThrow();
  });

  test("a cache directory that is missing its parent still resolves", () => {
    const root = useRoot();
    mkdirSync(root, { recursive: true });
    expect(isInsideQueryCache(path.join(root, "query-cache", "missing.duckdb"))).toBe(true);
  });
});
