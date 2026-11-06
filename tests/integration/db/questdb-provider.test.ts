/**
 * QuestDB provider with an injected wire session: the statement is sent as given (no
 * `pg_backend_pid()`), the catalog is `tables()` and `table_columns()`, and monitoring that
 * would need `pg_stat_*` stays empty. One case opens the real session factory against a stand-in
 * `pg` pool so the opener is covered without a server.
 */

import { describe, expect, mock, test } from "bun:test";

import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { QuestDbProvider } from "@/lib/db/providers/sql/questdb";
import { openQuestDbSession, questDbPoolConfig } from "@/lib/db/providers/sql/questdb/session";
import type { DatabaseConnection } from "@/lib/types";

interface StandInPool {
  options: unknown;
  ended: boolean;
}

const standInPools: StandInPool[] = [];

mock.module("pg", () => ({
  Pool: class {
    options: unknown;
    ended = false;

    constructor(options: unknown) {
      this.options = options;
      standInPools.push(this);
    }

    query(): Promise<{ rows: unknown[][]; fields: { name: string }[]; rowCount: number }> {
      return Promise.resolve({ rows: [[1]], fields: [{ name: "?column?" }], rowCount: 1 });
    }

    async end(): Promise<void> {
      this.ended = true;
    }
  },
}));

interface Scripted {
  queries: string[];
  ended: boolean;
  failEnd: boolean;
  /** Thrown by the next query, then cleared. */
  fail: Error | undefined;
  /** Rows keyed by a substring of the statement. The first match wins; otherwise `rows`. */
  script: { match: string; rows: unknown[][]; fields: { name: string }[]; rowCount: number | null }[];
  rows: unknown[][];
  fields: { name: string }[];
  rowCount: number | null;
}

function scripted(): Scripted {
  return {
    queries: [],
    ended: false,
    failEnd: false,
    fail: undefined,
    script: [],
    rows: [],
    fields: [],
    rowCount: null,
  };
}

function open(current: Scripted) {
  return async () => ({
    async query(text: string) {
      current.queries.push(text);
      if (current.fail) {
        const error = current.fail;
        current.fail = undefined;
        throw error;
      }
      const hit = current.script.find((row) => text.includes(row.match));
      return {
        rows: hit?.rows ?? current.rows,
        fields: hit?.fields ?? current.fields,
        rowCount: hit?.rowCount ?? current.rowCount,
      };
    },
    async end() {
      current.ended = true;
      if (current.failEnd) throw new Error("end failed");
    },
  });
}

const connection: DatabaseConnection = {
  id: "qdb-1",
  name: "Quest",
  type: "questdb",
  host: "questdb.internal",
  port: 8812,
  user: "admin",
  password: "secret",
  database: "qdb",
  createdAt: new Date("2026-11-06T00:00:00.000Z"),
};

function providerFor(current: Scripted, overrides: Partial<DatabaseConnection> = {}): QuestDbProvider {
  return new QuestDbProvider({ ...connection, ...overrides }, {}, undefined, open(current));
}

describe("QuestDB pool", () => {
  test("defaults the wire user, database and port, and spells TLS the way the mode asks", () => {
    expect(
      questDbPoolConfig({ ...connection, user: "  ", database: "  ", port: 0, password: undefined, host: undefined }),
    ).toMatchObject({
      user: "admin",
      database: "qdb",
      port: 8812,
      password: "",
      host: "",
      ssl: false,
    });
    expect(questDbPoolConfig({ ...connection, ssl: { mode: "disable" } }).ssl).toBe(false);
    expect(questDbPoolConfig({ ...connection, ssl: { mode: "require" } }).ssl).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(questDbPoolConfig({ ...connection, ssl: { mode: "verify-full" } }).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(
      questDbPoolConfig({
        ...connection,
        ssl: {
          mode: "verify-ca",
          rejectUnauthorized: false,
          caCert: "CA",
          clientCert: "C",
          clientKey: "K",
        },
      }).ssl,
    ).toEqual({ rejectUnauthorized: false, ca: "CA", cert: "C", key: "K" });
  });

  test("opens a session on the stand-in pool and sends the statement with positional rows", async () => {
    standInPools.length = 0;
    const opened = await openQuestDbSession(connection);
    const result = await opened.query("SELECT 1");
    expect(result.rows).toEqual([[1]]);
    expect(result.fields[0]?.name).toBe("?column?");
    await opened.end();
    expect(standInPools[0]?.ended).toBe(true);
    expect(standInPools[0]?.options).toMatchObject({ host: "questdb.internal", database: "qdb", user: "admin" });
  });
});

describe("QuestDB provider", () => {
  test("probes with SELECT 1 and does not ask for a backend pid when a query id is attached", async () => {
    const current = scripted();
    current.rows = [[1]];
    current.fields = [{ name: "?column?" }];
    current.rowCount = 1;
    const provider = providerFor(current);
    await provider.connect();
    await provider.connect();
    expect(current.queries).toEqual(["SELECT 1"]);

    current.script.push({
      match: "country",
      rows: [["uk", 2]],
      fields: [{ name: "country" }, { name: "c" }],
      rowCount: null,
    });
    const result = await provider.query("SELECT country, count() c FROM orders", undefined, undefined, "run-1");
    expect(result.rows).toEqual([{ country: "uk", c: 2 }]);
    expect(result.fields).toEqual(["country", "c"]);
    expect(result.rowCount).toBe(1);
    expect(current.queries.at(-1)).toBe("SELECT country, count() c FROM orders");
    current.script.push({
      match: "same",
      rows: [[1, 2]],
      fields: [{ name: "n" }, { name: "n" }],
      rowCount: 1,
    });
    const repeated = await provider.query("SELECT same");
    expect(repeated.fields).toEqual(["n", "n (2)"]);
    expect(repeated.rows).toEqual([{ n: 1, "n (2)": 2 }]);
    expect(current.queries).not.toContain("SELECT pg_backend_pid()");
  });

  test("refuses a parameter list and a missing connection", async () => {
    const provider = providerFor(scripted());
    await expect(provider.query("SELECT 1", ["x"])).rejects.toThrow(QueryError);
    await expect(provider.query("SELECT 1")).rejects.toThrow("Not connected to QuestDB.");
  });

  test("maps a refused credential, a refused connection and a statement fault", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.fail = new Error("password authentication failed");
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
    current.fail = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8812"), { code: "ECONNREFUSED" });
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
    current.fail = Object.assign(new Error("unknown function name: nope"), { code: "42883" });
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(QueryError);
  });

  test("lists the database, hides telemetry, and reads a designated timestamp as the key", async () => {
    const current = scripted();
    const provider = providerFor(current, { database: "  " });
    await provider.connect();
    expect(await provider.listContainers()).toEqual([{ path: ["qdb"], name: "qdb", level: 0 }]);
    expect(await provider.listContainers(["qdb"])).toEqual([]);

    current.script.push({
      match: "tables()",
      rows: [["orders"], ["Telemetry"], ["telemetry_config"], [""]],
      fields: [{ name: "table_name" }],
      rowCount: 4,
    });
    expect(await provider.listObjects(["qdb"], "table")).toEqual([
      { path: ["qdb", "orders"], name: "orders", kind: "table" },
    ]);

    current.script.push({
      match: "table_columns",
      rows: [
        ["ts", "TIMESTAMP", "true"],
        ["note", "VARCHAR", "t"],
        ["n", 4, null],
        ["id", "LONG", true],
      ],
      fields: [{ name: "column" }, { name: "type" }, { name: "designated" }],
      rowCount: 4,
    });
    const described = await provider.describeObject(["qdb", "o'rders"], "table");
    expect(described.columns[0]).toMatchObject({ name: "ts", isPrimary: true, nullable: false });
    expect(described.columns[1]).toMatchObject({ name: "note", isPrimary: true, nullable: false });
    expect(described.columns[2]).toMatchObject({ name: "n", type: "4", isPrimary: false, nullable: true });
    expect(described.columns[3]).toMatchObject({ name: "id", isPrimary: true });
    expect(current.queries.at(-1)).toContain("table_columns('o''rders')");

    const columns = current.script.find((row) => row.match === "table_columns");
    if (columns) {
      columns.rows = [["when", "TIMESTAMP", "true"]];
      columns.fields = [{ name: "Column" }, { name: "Type" }, { name: "Designated" }];
    }
    const mixed = await provider.describeObject(["qdb", "mixed"], "table");
    expect(mixed.columns[0]).toMatchObject({ name: "when", type: "TIMESTAMP", isPrimary: true });
  });

  test("counts tables, reports a catalog failure, and truncates a bounded describe", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push({
      match: "tables()",
      rows: [["a"], ["b"]],
      fields: [{ name: "table_name" }],
      rowCount: 2,
    });
    expect(await provider.countObjects(["qdb"])).toEqual({ table: { count: 2 } });

    current.fail = new Error("catalog down");
    expect(await provider.countObjects(["qdb"])).toEqual({
      table: { unavailable: expect.stringContaining("catalog down") },
    });

    current.script.push({
      match: "table_columns",
      rows: [["c", "INT", "false"]],
      fields: [{ name: "column" }, { name: "type" }, { name: "designated" }],
      rowCount: 1,
    });
    const page = await provider.describeObjects(["qdb"], "table", 1);
    expect(page.details).toHaveLength(1);
    expect(page.truncated?.limit).toBe(1);
    expect(page.truncated?.reason).toContain("bounded at 1");

    const all = await provider.describeObjects(["qdb"], "table");
    expect(all.details).toHaveLength(2);
    expect(all.truncated).toBeUndefined();
  });

  test("refuses a bad path, a bad kind and a bad limit", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    await expect(provider.listObjects(["qdb"], "view")).rejects.toThrow(QueryError);
    await expect(provider.listObjects([], "table")).rejects.toThrow(QueryError);
    await expect(provider.describeObject(["qdb"], "table")).rejects.toThrow(QueryError);
    await expect(provider.describeObjects(["qdb"], "table", 0)).rejects.toThrow(QueryError);
    await expect(provider.countObjects(["qdb", "extra"])).rejects.toThrow(QueryError);
  });

  test("leaves monitoring empty and refuses maintenance", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push(
      { match: "build()", rows: [["QuestDB 9.0.1"]], fields: [{ name: "build" }], rowCount: 1 },
      { match: "tables()", rows: [], fields: [{ name: "table_name" }], rowCount: 0 },
    );
    const overview = await provider.getOverview();
    expect(overview.version).toBe("QuestDB 9.0.1");
    expect(overview.uptime).toBe("N/A");
    expect(overview.databaseSize).toBe("N/A");
    expect(overview.tableCount).toBe(0);
    expect(overview.maxConnections).toBe(0);

    current.script[0] = { match: "build()", rows: [[""]], fields: [{ name: "build" }], rowCount: 1 };
    expect((await provider.getOverview()).version).toBe("unknown");
    current.script[0] = { match: "build()", rows: [], fields: [{ name: "build" }], rowCount: 0 };
    expect((await provider.getOverview()).version).toBe("unknown");

    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.databaseSize).toBe("N/A");
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await expect(provider.runMaintenance("analyze")).rejects.toThrow("QuestDB has no ANALYZE or VACUUM");
  });

  test("refuses a read-only seed and a missing host, and ends the session when the probe fails", async () => {
    const current = scripted();
    await expect(providerFor(current, { host: "  " }).connect()).rejects.toThrow("QuestDB needs a host.");
    await expect(providerFor(current, { host: undefined }).connect()).rejects.toThrow("QuestDB needs a host.");
    await expect(
      providerFor(current, { readOnly: true, seedId: "seed-1", user: "admin", password: "quest" }).connect(),
    ).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(current.queries).toHaveLength(0);

    await providerFor(current, { readOnly: true, user: "admin", password: "quest" }).connect();
    await providerFor(current, { readOnly: true, seedId: "", user: "admin", password: "quest" }).connect();
    await providerFor(current, { readOnly: true, seedId: "seed-1", user: "admin", password: "other" }).connect();
    expect(current.queries).toEqual(["SELECT 1", "SELECT 1", "SELECT 1"]);

    const failing = scripted();
    failing.fail = new Error("password authentication failed");
    await expect(providerFor(failing).connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(failing.ended).toBe(true);

    const dropping = scripted();
    dropping.fail = new Error("connect ECONNREFUSED");
    dropping.failEnd = true;
    await expect(providerFor(dropping).connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(dropping.ended).toBe(true);

    await expect(
      new QuestDbProvider(connection, {}, undefined, () => Promise.reject(new Error("dial failed"))).connect(),
    ).rejects.toThrow("dial failed");
  });

  test("disconnects, swallows an end failure, and disconnects again", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.disconnect();
    await provider.connect();
    current.failEnd = true;
    await provider.disconnect();
    expect(current.ended).toBe(true);
    await provider.disconnect();
    await expect(provider.query("SELECT 1")).rejects.toThrow("Not connected");
  });

  test("uses the default session opener when none is injected", async () => {
    standInPools.length = 0;
    const provider = new QuestDbProvider(connection);
    await provider.connect();
    const result = await provider.query("SELECT 1");
    expect(result.rows).toEqual([{ "?column?": 1 }]);
    await provider.disconnect();
    expect(standInPools[0]?.ended).toBe(true);
  });

  test("counts tables before a connection as unavailable", async () => {
    const provider = providerFor(scripted());
    expect(await provider.countObjects(["qdb"])).toEqual({ table: { unavailable: "Not connected to QuestDB." } });
  });

  test("surfaces a failed overview", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.fail = Object.assign(new Error("unknown function name: build"), { code: "42883" });
    await expect(provider.getOverview()).rejects.toBeInstanceOf(QueryError);
  });
});
