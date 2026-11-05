import { describe, expect, test } from "bun:test";
import { savedJoinCatalog } from "@/lib/saved-join/catalog";
import { readSavedJoinBody } from "@/lib/saved-join/body";
import { CROSS_DB_JOINS_ID } from "@/lib/saved-join/connection";
import {
  SAVED_JOIN_MAX_SQL_CHARS,
  SAVED_JOIN_MAX_TABLES,
  SavedJoinError,
  type SavedJoinLimits,
} from "@/lib/saved-join/limits";
import { runSavedJoin, type SavedJoinRunner, type SavedJoinSource, type SavedJoinTable } from "@/lib/saved-join/run";
import { sourceReadRefusal } from "@/lib/saved-join/source-guard";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { KUBECTL_MAX_TEXT_BYTES } from "@/lib/db/providers/platform/kubernetes/console/commands";
import type { DatabaseConnection, SavedQuery } from "@/lib/types";

const limits: SavedJoinLimits = {
  maxSourceRows: 5,
  maxResultRows: 5,
  memoryLimit: "32MB",
  threads: 1,
  timeoutMs: 15_000,
};
const page = { limit: 10, offset: 0, unlimited: false };
const signal = new AbortController().signal;

function source(name: string, extra: Partial<SavedJoinSource> = {}): SavedJoinSource {
  return {
    name,
    query: "SELECT 1",
    connection: { id: "c1", type: "postgres" } as DatabaseConnection,
    ...extra,
  };
}

function sheets(map: Record<string, SavedJoinTable>): SavedJoinRunner {
  return async (entry) => {
    const sheet = map[entry.name];
    if (!sheet) throw new Error(`no sheet for ${entry.name}`);
    return sheet;
  };
}

const orders: SavedJoinTable = {
  fields: ["id", "name"],
  rows: [
    { id: 1, name: "Ada" },
    { id: 2, name: "Grace" },
  ],
};
const people: SavedJoinTable = {
  fields: ["id", "email"],
  rows: [
    { id: 1, email: "ada@example.com" },
    { id: 2, email: "grace@example.com" },
  ],
};

describe("savedJoinCatalog", () => {
  const query = (tableId: string | undefined, connectionId?: string): SavedQuery => ({
    id: "q1",
    name: "Monthly Active Users",
    tableId,
    query: "SELECT 1",
    connectionType: "postgres",
    connectionId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const inline = { id: "c1", type: "postgres", name: "App", managed: false } as DatabaseConnection;
  const seed = { id: "c2", type: "mysql", name: "Seed", managed: true, seedId: "sales" } as DatabaseConnection;

  test("names each query by its ID and points it at a seed or the connection record", () => {
    expect(
      savedJoinCatalog([query("orders", "c1"), query("people", "c2"), query(undefined, "c1")], [inline, seed]),
    ).toEqual([
      { name: "orders", query: "SELECT 1", connection: inline },
      { name: "people", query: "SELECT 1", connectionId: "seed:sales" },
    ]);
  });

  test("keeps a query whose connection is gone, and drops an ID that is not a table name", () => {
    expect(savedJoinCatalog([query("orders", "missing"), query("my query")], [])).toEqual([
      { name: "orders", query: "SELECT 1" },
    ]);
  });

  test("drops a query that was saved on Cross_DB_Joins", () => {
    expect(savedJoinCatalog([query("orders", "c1"), query("joined", CROSS_DB_JOINS_ID)], [inline])).toEqual([
      { name: "orders", query: "SELECT 1", connection: inline },
    ]);
  });
});

describe("sourceReadRefusal", () => {
  test("allows one read and refuses a write, a script, and an oversize console", () => {
    expect(sourceReadRefusal("postgres", "SELECT 1")).toBeNull();
    expect(sourceReadRefusal("mongodb", '{"collection":"orders","operation":"find"}')).toBeNull();
    expect(sourceReadRefusal("redis", "GET user:1")).toBeNull();
    expect(sourceReadRefusal("postgres", "DELETE FROM orders")).toContain("has to be a read");
    expect(sourceReadRefusal("redis", "FLUSHALL")).toContain("has to be a read");
    expect(sourceReadRefusal("mongodb", '{"collection":"orders","operation":"deleteMany","filter":{}}')).toContain(
      "has to be a read",
    );
    expect(sourceReadRefusal("mongodb", "db.orders.deleteMany({})")).toContain("has to be a read");
    expect(sourceReadRefusal("postgres", "SELECT 1; SELECT 2")).toContain("one statement");
    expect(sourceReadRefusal("postgres", "SELECT 'oops")).toContain("one statement");
    expect(sourceReadRefusal("postgres", "SELECT 1 -- x\r; DELETE FROM t")).toContain("one statement");
    expect(sourceReadRefusal("kubernetes", "a".repeat(KUBECTL_MAX_TEXT_BYTES + 1))).toContain("byte");
  });
});

describe("readSavedJoinBody", () => {
  const ok = { name: "orders", query: "SELECT 1", connection: { id: "c1", type: "postgres", name: "App" } };

  test("reads a statement, its saved queries, and a page", () => {
    const parsed = readSavedJoinBody({
      sql: "SELECT * FROM saved.orders",
      saved: [ok],
      options: { limit: 10, offset: 2 },
    });
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") return;
    expect(parsed.sql).toBe("SELECT * FROM saved.orders");
    expect(parsed.saved[0]?.name).toBe("orders");
    expect(parsed.saved[0]?.connectionId).toBeUndefined();
    expect(parsed.page).toEqual({ limit: 10, offset: 2, unlimited: false });
  });

  test("keeps a seed id and defaults the page", () => {
    const parsed = readSavedJoinBody({
      sql: "SELECT 1",
      saved: [{ name: "orders", query: "SELECT 1", connectionId: "seed:sales", connection: { nope: true } }],
    });
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.saved[0]?.connectionId).toBe("seed:sales");
    expect(parsed.saved[0]?.connection).toBeNull();
    expect(parsed.page.limit).toBe(500);
    expect(parsed.page.unlimited).toBe(false);
  });

  test("refuses a body that is not one join", () => {
    expect(readSavedJoinBody({ sql: "  ", saved: [] })).toContain("sql");
    expect(readSavedJoinBody({ sql: 1, saved: [] })).toContain("sql");
    expect(readSavedJoinBody({ sql: "x".repeat(SAVED_JOIN_MAX_SQL_CHARS + 1), saved: [] })).toContain("characters");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: {} })).toContain("array");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: Array.from({ length: 51 }, () => ok) })).toContain("50");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [null] })).toContain("name and a query");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [{ name: "", query: "SELECT 1" }] })).toContain("needs an ID");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [{ name: "my query", query: "SELECT 1" }] })).toContain(
      "underscores",
    );
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [{ name: "orders", query: 1 }] })).toContain("query text");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [], options: [] })).toContain("object");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [], options: { limit: -1 } })).toContain("limit");
    expect(readSavedJoinBody({ sql: "SELECT 1", saved: [], options: { unlimited: "yes" } })).toContain("boolean");
    const unlimited = readSavedJoinBody({ sql: "SELECT 1", saved: [], options: { unlimited: true } });
    if (typeof unlimited === "string") throw new Error(unlimited);
    expect(unlimited.page.unlimited).toBe(true);
  });
});

describe("runSavedJoin", () => {
  test("joins two saved queries in DuckDB and pages the result", async () => {
    const result = await runSavedJoin({
      sql: "SELECT orders.id, orders.name, people.email FROM saved.orders JOIN saved.people ON orders.id = people.id ORDER BY orders.id",
      saved: [source("orders"), source("people")],
      page: { limit: 1, offset: 1, unlimited: false },
      signal,
      limits,
      runSource: sheets({ orders, people }),
    });
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.name).toBe("Grace");
    expect(result.pagination).toMatchObject({ limit: 1, offset: 1, hasMore: false, wasLimited: false });
  });

  test("returns every row when the page is unlimited, and an empty page past the end", async () => {
    const all = await runSavedJoin({
      sql: "SELECT * FROM saved.orders ORDER BY id",
      saved: [source("orders")],
      page: { limit: 1, offset: 0, unlimited: true },
      signal,
      limits,
      runSource: sheets({ orders }),
    });
    expect(all.rowCount).toBe(2);
    expect(all.pagination.hasMore).toBe(false);
    expect(all.pagination.limit).toBe(2);

    const none = await runSavedJoin({
      sql: "SELECT * FROM saved.orders",
      saved: [source("orders")],
      page: { limit: 10, offset: 50, unlimited: false },
      signal,
      limits,
      runSource: sheets({ orders }),
    });
    expect(none.rows).toEqual([]);
    expect(none.pagination.hasMore).toBe(false);
  });

  test("loads each saved query once and keeps the ID's case", async () => {
    let calls = 0;
    const result = await runSavedJoin({
      sql: 'SELECT * FROM saved."Orders" a JOIN saved."Orders" b ON a.id = b.id',
      saved: [source("Orders"), source("orders")],
      page,
      signal,
      limits,
      runSource: async (entry) => {
        calls += 1;
        expect(entry.name).toBe("Orders");
        return orders;
      },
    });
    expect(calls).toBe(1);
    expect(result.rowCount).toBe(2);
  });

  test("matches an ID that differs only by case, and refuses an ambiguous or missing one", async () => {
    const folded = await runSavedJoin({
      sql: "SELECT * FROM saved.ORDERS",
      saved: [source("orders")],
      page,
      signal,
      limits,
      runSource: sheets({ orders }),
    });
    expect(folded.rowCount).toBe(2);

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.ORDERS",
        saved: [source("Orders"), source("orders")],
        page,
        signal,
        limits,
        runSource: sheets({ Orders: orders, orders }),
      }),
    ).rejects.toThrow('matches the ID "ORDERS"');

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders"), source("orders")],
        page,
        signal,
        limits,
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow('uses the ID "orders"');

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.missing",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow('no saved query with the ID "missing"');
  });

  test("refuses a saved query that has no connection", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders", { connection: null, connectionId: undefined })],
        page,
        signal,
        limits,
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow("no connection");
  });

  test("passes a seed failure through and wraps any other failure with the query's ID", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: async () => {
          throw new SeedConnectionError("not granted", 403);
        },
      }),
    ).rejects.toBeInstanceOf(SeedConnectionError);

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toThrow('Saved query "orders" failed: down');

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: async () => {
          throw new SavedJoinError("stop");
        },
      }),
    ).rejects.toThrow("stop");

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: async () => {
          throw "down";
        },
      }),
    ).rejects.toThrow('Saved query "orders" failed: down');
  });

  test("stops when a saved query or the join itself returns too many rows", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits: { ...limits, maxSourceRows: 1 },
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow("more than 1 row");

    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders a, saved.orders b",
        saved: [source("orders")],
        page,
        signal,
        limits: { ...limits, maxResultRows: 3 },
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow("more than 3 rows");
  });

  test("refuses a saved query that returned no columns", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("no columns");
  });

  test("loads booleans, numbers, dates, objects, and quoted column names", async () => {
    const when = new Date("2020-01-02T03:04:05.000Z");
    const wide: SavedJoinTable = {
      fields: ["id", "ok", "n", "amount", "label", "when", "extra", "list", "empty", "word", "mixed", 'a"b', "big"],
      rows: [
        {
          id: 1,
          ok: true,
          n: BigInt(1),
          amount: 1,
          label: "a",
          when,
          extra: { a: 1 },
          list: [1],
          empty: null,
          word: "x",
          mixed: true,
          'a"b': "q",
          big: Number.MAX_SAFE_INTEGER + 2,
        },
        {
          id: 2,
          ok: false,
          n: BigInt(2),
          amount: 1.5,
          label: "b",
          when,
          extra: { a: 2 },
          list: [2, 3],
          empty: null,
          word: Number.POSITIVE_INFINITY,
          mixed: "no",
          'a"b': "r",
          big: 1.25,
        },
      ],
    };
    const result = await runSavedJoin({
      sql: 'SELECT label, ok, amount, "when", extra, "a""b" FROM saved.wide ORDER BY label',
      saved: [source("wide")],
      page,
      signal,
      limits,
      runSource: sheets({ wide }),
    });
    expect(result.rows.map((row) => row.label)).toEqual(["a", "b"]);
    expect(result.rows[0]?.ok).toBe(true);
    expect(result.rows[1]?.ok).toBe(false);
    expect(String(result.rows[0]?.when)).toContain("2020-01-02");
    expect(String(result.rows[0]?.extra)).toContain("1");
    expect(result.rows[0]?.['a"b']).toBe("q");
  });

  test("a common table expression and a union are still one DuckDB statement", async () => {
    const cte = await runSavedJoin({
      sql: "WITH other AS (SELECT 1 AS id) SELECT other.id, orders.name FROM other JOIN saved.orders ON other.id = orders.id",
      saved: [source("orders")],
      page,
      signal,
      limits,
      runSource: sheets({ orders }),
    });
    expect(cte.rowCount).toBe(1);

    const union = await runSavedJoin({
      sql: "SELECT id FROM saved.orders UNION SELECT id FROM saved.people ORDER BY id",
      saved: [source("orders"), source("people")],
      page,
      signal,
      limits,
      runSource: sheets({ orders, people }),
    });
    expect(union.rowCount).toBe(2);
  });

  test("an unqualified name is the saved query, and main. names the same table", async () => {
    const joined = await runSavedJoin({
      sql: "SELECT orders.name, people.email FROM orders JOIN people ON orders.id = people.id ORDER BY orders.name",
      saved: [source("orders"), source("people")],
      page,
      signal,
      limits,
      runSource: sheets({ orders, people }),
    });
    expect(joined.rows).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" },
    ]);

    let reads = 0;
    const once = await runSavedJoin({
      sql: "SELECT a.name FROM orders a JOIN main.Orders b ON a.id = b.id ORDER BY a.name",
      saved: [source("orders")],
      page,
      signal,
      limits,
      runSource: async () => {
        reads += 1;
        return orders;
      },
    });
    expect(reads).toBe(1);
    expect(once.rows.map((row) => row.name)).toEqual(["Ada", "Grace"]);
  });

  test("refuses anything that is not one DuckDB select of saved-query IDs", async () => {
    const run = (sql: string) =>
      runSavedJoin({
        sql,
        saved: [source("orders"), source("people")],
        page,
        signal,
        limits,
        runSource: sheets({ orders, people }),
      });
    await expect(run("SELECT * FROM saved.orders; SELECT * FROM saved.people")).rejects.toThrow("one DuckDB statement");
    await expect(run("INSERT INTO saved.orders VALUES (1, 'a')")).rejects.toThrow("one DuckDB SELECT");
    await expect(run("SELECT FROM")).rejects.toThrow("syntax error");
    await expect(run("SELECT * FROM read_csv_auto('x.csv')")).rejects.toThrow("by their ID");
    await expect(run("SHOW TABLES")).rejects.toThrow("by their ID");
    await expect(run("SELECT * FROM public.orders")).rejects.toThrow("not one");
    await expect(run("SELECT * FROM mem.saved.orders")).rejects.toThrow("by their ID");
    await expect(run("SELECT * FROM saved.orders AT (VERSION => 1)")).rejects.toThrow("by their ID");
    await expect(run("SELECT * FROM saved.orders JOIN other ON true")).rejects.toThrow('ID "other"');
    await expect(run('SELECT * FROM saved."a b"')).rejects.toThrow("underscores");
    await expect(run("SELECT 1")).rejects.toThrow("at least one saved query");
    const names = Array.from({ length: SAVED_JOIN_MAX_TABLES + 1 }, (_, index) => `t${index}`);
    await expect(run(`SELECT * FROM ${names.map((name) => `saved.${name}`).join(", ")}`)).rejects.toThrow(
      `${SAVED_JOIN_MAX_TABLES}`,
    );
  });

  test("runs an ordinary function and refuses one that reads the server's settings", async () => {
    const lowered = await runSavedJoin({
      sql: "SELECT lower(name) AS name FROM saved.orders ORDER BY name",
      saved: [source("orders")],
      page,
      signal,
      limits,
      runSource: sheets({ orders }),
    });
    expect(lowered.rows.map((row) => row.name)).toEqual(["ada", "grace"]);

    const hidden = (sql: string) =>
      runSavedJoin({ sql, saved: [source("orders")], page, signal, limits, runSource: sheets({ orders }) });
    await expect(hidden("SELECT current_setting('temp_directory') FROM saved.orders")).rejects.toThrow(
      "server's settings",
    );
    await expect(hidden("SELECT lower(current_setting('secret_directory')) FROM saved.orders")).rejects.toThrow(
      "server's settings",
    );
  });

  test("a file read inside the DuckDB statement is refused", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT read_text('secret.txt') FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow(/read_text|permission|disabled/i);
  });

  test("a missing column is the engine's own sentence", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT missing FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits,
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow(/missing/i);
  });

  test("refuses a memory limit or a thread count this server did not choose", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits: { ...limits, memoryLimit: "lots" },
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow("memory limit");
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal,
        limits: { ...limits, threads: 1.5 },
        runSource: sheets({ orders }),
      }),
    ).rejects.toThrow("thread count");
  });

  test("a cancel while a saved query is running stops the join", async () => {
    const controller = new AbortController();
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal: controller.signal,
        limits,
        runSource: async () => {
          controller.abort();
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  test("a join that runs past its deadline is stopped", async () => {
    await expect(
      runSavedJoin({
        sql: "SELECT * FROM saved.orders",
        saved: [source("orders")],
        page,
        signal: AbortSignal.timeout(40),
        limits: { ...limits, timeoutMs: 2_000 },
        runSource: (_entry, sourceSignal) =>
          new Promise((_resolve, reject) => {
            sourceSignal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }),
    ).rejects.toThrow("longer than 2 seconds");
  });
});
