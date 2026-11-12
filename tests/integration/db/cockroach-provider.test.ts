/**
 * CockroachDB provider with an injected wire session: the statement is sent as given
 * (no `pg_backend_pid()`), the catalog is `information_schema`, and monitoring that would
 * need `pg_stat_*` stays empty. One case opens the real session factory against a stand-in
 * `pg` pool so the opener is covered without a server.
 */

import { describe, expect, mock, test } from "bun:test";

import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { CockroachProvider } from "@/lib/db/providers/sql/cockroach";
import { openCockroachSession, cockroachPoolConfig } from "@/lib/db/providers/sql/cockroach/session";
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
  fail: Error | undefined;
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
  id: "crdb-1",
  name: "Cluster",
  type: "cockroach",
  host: "cluster.cockroachlabs.cloud",
  port: 26257,
  user: "root",
  password: "secret",
  database: "defaultdb",
  createdAt: new Date("2026-11-11T00:00:00.000Z"),
};

function providerFor(current: Scripted, overrides: Partial<DatabaseConnection> = {}): CockroachProvider {
  return new CockroachProvider({ ...connection, ...overrides }, {}, undefined, open(current));
}

const CATALOG = {
  match: "information_schema.tables",
  rows: [
    ["public", "orders", "BASE TABLE"],
    ["public", "revenue", "VIEW"],
    ["public", "ext", "EXTERNAL TABLE"],
    ["public", "", "BASE TABLE"],
    ["public", "seq", "SEQUENCE"],
    ["information_schema", "tables", "VIEW"],
    ["pg_catalog", "pg_class", "BASE TABLE"],
    ["pg_temp_1", "t", "BASE TABLE"],
    ["crdb_internal", "tables", "BASE TABLE"],
    ["pg_extension", "spatial_ref_sys", "BASE TABLE"],
    ["", "orphan", "BASE TABLE"],
    ["sales", "daily", "BASE TABLE"],
  ],
  fields: [{ name: "table_schema" }, { name: "table_name" }, { name: "table_type" }],
  rowCount: 12,
};

describe("CockroachDB pool", () => {
  test("keeps the typed user and database, defaults the port, and spells TLS the way the mode asks", () => {
    expect(cockroachPoolConfig({ ...connection, port: 0, password: undefined, host: undefined })).toMatchObject({
      user: "root",
      database: "defaultdb",
      port: 26257,
      password: "",
      host: "",
      ssl: false,
    });
    expect(cockroachPoolConfig({ ...connection, user: "  ", database: "  " })).toMatchObject({
      user: "",
      database: "",
    });
    expect(cockroachPoolConfig({ ...connection, ssl: { mode: "disable" } }).ssl).toBe(false);
    expect(cockroachPoolConfig({ ...connection, ssl: { mode: "require" } }).ssl).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(cockroachPoolConfig({ ...connection, ssl: { mode: "verify-full" } }).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(
      cockroachPoolConfig({
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
    const opened = await openCockroachSession(connection);
    const result = await opened.query("SELECT 1");
    expect(result.rows).toEqual([[1]]);
    expect(result.fields[0]?.name).toBe("?column?");
    await opened.end();
    expect(standInPools[0]?.ended).toBe(true);
    expect(standInPools[0]?.options).toMatchObject({
      host: "cluster.cockroachlabs.cloud",
      database: "defaultdb",
      user: "root",
      port: 26257,
    });
  });
});

describe("CockroachDB provider", () => {
  test("probes with SELECT 1 and does not ask for a backend pid when a query id is attached", async () => {
    const current = scripted();
    current.rows = [[1]];
    current.fields = [{ name: "?column?" }];
    current.rowCount = 1;
    const provider = providerFor(current);
    expect(provider.getCapabilities().defaultPort).toBe(26257);
    expect(provider.getCapabilities().supportsTransactions).toBe(false);
    expect(provider.getLabels().entityName).toBe("Table");
    await provider.connect();
    await provider.connect();
    expect(current.queries).toEqual(["SELECT 1"]);

    current.script.push({
      match: "country",
      rows: [["uk", 2]],
      fields: [{ name: "country" }, { name: "c" }],
      rowCount: null,
    });
    const result = await provider.query("SELECT country, count(*) c FROM orders", undefined, "run-1");
    expect(result.rows).toEqual([{ country: "uk", c: 2 }]);
    expect(result.fields).toEqual(["country", "c"]);
    expect(result.rowCount).toBe(1);
    expect(current.queries.at(-1)).toBe("SELECT country, count(*) c FROM orders");
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
    await expect(provider.query("SELECT 1")).rejects.toThrow("Not connected to CockroachDB.");
  });

  test("maps a refused credential, a refused connection and a statement fault", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.fail = new Error("password authentication failed");
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
    current.fail = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:26257"), { code: "ECONNREFUSED" });
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
    current.fail = Object.assign(new Error("column does not exist"), { code: "42703" });
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(QueryError);
  });

  test("lists schemas, hides system schemas, and reads a declared key", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push(CATALOG);
    expect(await provider.listContainers()).toEqual([
      { path: ["public"], name: "public", level: 0 },
      { path: ["sales"], name: "sales", level: 0 },
    ]);
    expect(await provider.listContainers(["public"])).toEqual([]);

    expect(await provider.listObjects(["public"], "table")).toEqual([
      { path: ["public", "orders"], name: "orders", kind: "table" },
      { path: ["public", "ext"], name: "ext", kind: "table" },
    ]);
    expect(await provider.listObjects(["public"], "view")).toEqual([
      { path: ["public", "revenue"], name: "revenue", kind: "view" },
    ]);

    current.script.push({
      match: "information_schema.columns",
      rows: [
        ["id", "integer", "NO", "YES"],
        ["note", "character varying", "YES", "NO"],
        ["n", 4, "YES", "NO"],
        ["blank", null, "YES", "NO"],
        ["flag", "boolean", "YES", "YES"],
      ],
      fields: [{ name: "column_name" }, { name: "data_type" }, { name: "is_nullable" }, { name: "is_primary" }],
      rowCount: 5,
    });
    const described = await provider.describeObject(["pub'lic", "o'rders"], "table");
    expect(described.columns[0]).toMatchObject({ name: "id", type: "integer", isPrimary: true, nullable: false });
    expect(described.columns[1]).toMatchObject({
      name: "note",
      type: "character varying",
      isPrimary: false,
      nullable: true,
    });
    expect(described.columns[2]).toMatchObject({ name: "n", type: "4", isPrimary: false, nullable: true });
    expect(described.columns[3]).toMatchObject({ name: "blank", type: "", isPrimary: false, nullable: true });
    expect(described.columns[4]).toMatchObject({ name: "flag", isPrimary: true, nullable: false });
    expect(current.queries.at(-1)).toContain("'pub''lic'");
    expect(current.queries.at(-1)).toContain("'o''rders'");

    const columns = current.script.find((row) => row.match === "information_schema.columns");
    if (columns) {
      columns.rows = [["when", "timestamp", "NO", "NO"]];
      columns.fields = [
        { name: "Column_Name" },
        { name: "Data_Type" },
        { name: "Is_Nullable" },
        { name: "Is_Primary" },
      ];
    }
    const mixed = await provider.describeObject(["public", "mixed"], "table");
    expect(mixed.columns[0]).toMatchObject({ name: "when", type: "timestamp", isPrimary: false, nullable: false });
  });

  test("counts tables and views, reports a catalog failure, and truncates a bounded describe", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push(CATALOG);
    expect(await provider.countObjects(["public"])).toEqual({ table: { count: 2 }, view: { count: 1 } });

    current.fail = new Error("catalog down");
    expect(await provider.countObjects(["public"])).toEqual({
      table: { unavailable: expect.stringContaining("catalog down") },
      view: { unavailable: expect.stringContaining("catalog down") },
    });

    current.script.push({
      match: "information_schema.columns",
      rows: [["c", "integer", "YES", "NO"]],
      fields: [{ name: "column_name" }, { name: "data_type" }, { name: "is_nullable" }, { name: "is_primary" }],
      rowCount: 1,
    });
    const page = await provider.describeObjects(["public"], "table", 1);
    expect(page.details).toHaveLength(1);
    expect(page.truncated?.limit).toBe(1);
    expect(page.truncated?.reason).toContain("bounded at 1");

    const all = await provider.describeObjects(["public"], "table");
    expect(all.details).toHaveLength(2);
    expect(all.truncated).toBeUndefined();
  });

  test("refuses a bad path, a bad kind and a bad limit", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push(CATALOG);
    await expect(provider.listObjects(["public"], "sequence")).rejects.toThrow(QueryError);
    await expect(provider.listObjects([], "table")).rejects.toThrow(QueryError);
    await expect(provider.describeObject(["public"], "table")).rejects.toThrow(QueryError);
    await expect(provider.describeObjects(["public"], "table", 0)).rejects.toThrow(QueryError);
    await expect(provider.countObjects(["public", "extra"])).rejects.toThrow(QueryError);
  });

  test("leaves monitoring empty and refuses maintenance", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.script.push(
      { match: "version()", rows: [["CockroachDB CCL v26.3.2"]], fields: [{ name: "version" }], rowCount: 1 },
      CATALOG,
    );
    const overview = await provider.getOverview();
    expect(overview.version).toBe("CockroachDB CCL v26.3.2");
    expect(overview.uptime).toBe("N/A");
    expect(overview.databaseSize).toBe("N/A");
    expect(overview.tableCount).toBe(3);
    expect(overview.maxConnections).toBe(0);

    current.script[0] = { match: "version()", rows: [[""]], fields: [{ name: "version" }], rowCount: 1 };
    expect((await provider.getOverview()).version).toBe("unknown");
    current.script[0] = { match: "version()", rows: [[8]], fields: [{ name: "version" }], rowCount: 1 };
    expect((await provider.getOverview()).version).toBe("8");
    current.script[0] = { match: "version()", rows: [], fields: [{ name: "version" }], rowCount: 0 };
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
    await expect(provider.runMaintenance("analyze")).rejects.toThrow(
      "CockroachDB maintenance is not run from Studio. ANALYZE names one table in the statement.",
    );
  });

  test("refuses a missing host, database or user, and ends the session when the probe fails", async () => {
    const current = scripted();
    await expect(providerFor(current, { host: "  " }).connect()).rejects.toThrow("CockroachDB needs a host.");
    await expect(providerFor(current, { host: undefined }).connect()).rejects.toThrow("CockroachDB needs a host.");
    await expect(providerFor(current, { database: "  " }).connect()).rejects.toThrow(
      "CockroachDB needs a database name.",
    );
    await expect(providerFor(current, { database: undefined }).connect()).rejects.toThrow(
      "CockroachDB needs a database name.",
    );
    await expect(providerFor(current, { user: "  " }).connect()).rejects.toThrow("CockroachDB needs a user.");
    await expect(providerFor(current, { user: undefined }).connect()).rejects.toThrow("CockroachDB needs a user.");
    expect(current.queries).toHaveLength(0);

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
      new CockroachProvider(connection, {}, undefined, () => Promise.reject(new Error("dial failed"))).connect(),
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
    const provider = new CockroachProvider(connection);
    await provider.connect();
    const result = await provider.query("SELECT 1");
    expect(result.rows).toEqual([{ "?column?": 1 }]);
    await provider.disconnect();
    expect(standInPools[0]?.ended).toBe(true);
  });

  test("counts tables before a connection as unavailable", async () => {
    const provider = providerFor(scripted());
    expect(await provider.countObjects(["public"])).toEqual({
      table: { unavailable: "Not connected to CockroachDB." },
      view: { unavailable: "Not connected to CockroachDB." },
    });
  });

  test("surfaces a failed overview and a non-error catalog failure", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.connect();
    current.fail = Object.assign(new Error("unknown function name: version"), { code: "42883" });
    await expect(provider.getOverview()).rejects.toBeInstanceOf(QueryError);
  });
});
