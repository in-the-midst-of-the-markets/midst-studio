/**
 * SAP HANA provider with an injected session: the probe is `SELECT 1 FROM DUMMY`, a named
 * schema is `SET SCHEMA`, and the catalog is `SYS.SCHEMAS`, `SYS.TABLES` and
 * `SYS.TABLE_COLUMNS`. One case opens the real session factory against a stand-in `hdb`
 * client so the opener is covered without a server.
 */

import { describe, expect, mock, test } from "bun:test";

import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { SapHanaProvider } from "@/lib/db/providers/sql/saphana";
import { asHdb, openSapHanaSession, sapHanaClientOptions, sapHanaRows } from "@/lib/db/providers/sql/saphana/session";
import type { DatabaseConnection } from "@/lib/types";

interface HdbScript {
  connectError: Error | null;
  endThrows: boolean;
  execError: Error | null;
  result: unknown;
  options: unknown;
  ended: boolean;
  sql: string[];
}

const hdbScript: HdbScript = {
  connectError: null,
  endThrows: false,
  execError: null,
  result: [],
  options: undefined,
  ended: false,
  sql: [],
};

mock.module("hdb", () => ({
  createClient(options: unknown) {
    hdbScript.options = options;
    return {
      connect(callback: (error: Error | null) => void) {
        callback(hdbScript.connectError);
      },
      exec(sql: string, callback: (error: Error | null, result: unknown) => void) {
        hdbScript.sql.push(sql);
        if (hdbScript.execError) callback(hdbScript.execError, undefined);
        else callback(null, hdbScript.result);
      },
      end() {
        hdbScript.ended = true;
        if (hdbScript.endThrows) throw new Error("end failed");
      },
    };
  },
}));

interface Scripted {
  queries: string[];
  ended: boolean;
  failEnd: boolean;
  fail: unknown;
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
      if (current.fail !== undefined) {
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
  id: "hana-1",
  name: "HANA",
  type: "saphana",
  host: "hana.internal",
  port: 30015,
  user: "STUDIO",
  password: "secret",
  database: "APP",
  createdAt: new Date("2026-11-15T00:00:00.000Z"),
};

function providerFor(current: Scripted, overrides: Partial<DatabaseConnection> = {}): SapHanaProvider {
  return new SapHanaProvider({ ...connection, ...overrides }, {}, undefined, open(current));
}

describe("SAP HANA client options", () => {
  test("defaults the port and leaves TLS off until the mode or port 443 asks for it", () => {
    expect(sapHanaClientOptions({ ...connection, port: 0, password: undefined, host: undefined, user: "  " })).toEqual({
      host: "",
      port: 30015,
      user: "",
      password: "",
    });
    expect(sapHanaClientOptions({ ...connection, ssl: { mode: "disable" } })).not.toHaveProperty("useTLS");
    expect(sapHanaClientOptions({ ...connection, ssl: { mode: "require" } })).toMatchObject({
      useTLS: true,
      rejectUnauthorized: false,
    });
    expect(
      sapHanaClientOptions({
        ...connection,
        ssl: { mode: "verify-full", caCert: "CA", clientCert: "CERT", clientKey: "KEY", rejectUnauthorized: false },
      }),
    ).toMatchObject({
      useTLS: true,
      rejectUnauthorized: false,
      ca: "CA",
      cert: "CERT",
      key: "KEY",
    });
    expect(sapHanaClientOptions({ ...connection, port: 443, ssl: { mode: "disable" } })).toMatchObject({
      useTLS: true,
      rejectUnauthorized: false,
    });
    expect(sapHanaClientOptions({ ...connection, ssl: { mode: "verify-ca" } })).toMatchObject({
      useTLS: true,
      rejectUnauthorized: true,
    });
  });

  test("reads an exec result as rows, an affected-row count, or nothing", () => {
    expect(sapHanaRows(2)).toEqual({ rows: [[2]], fields: [{ name: "affectedRows" }], rowCount: 2 });
    expect(sapHanaRows(undefined)).toEqual({ rows: [], fields: [], rowCount: 0 });
    expect(sapHanaRows([{ A: 1, B: "x" }, 4, { B: "y", C: true }])).toEqual({
      rows: [
        [1, "x", undefined],
        [undefined, "y", true],
      ],
      fields: [{ name: "A" }, { name: "B" }, { name: "C" }],
      rowCount: 2,
    });
  });

  test("refuses a module that is not the client", () => {
    expect(() => asHdb(null)).toThrow("The SAP HANA client did not load.");
    expect(() => asHdb({})).toThrow("The SAP HANA client did not load.");
    expect(typeof asHdb({ createClient: () => undefined }).createClient).toBe("function");
  });
});

describe("SAP HANA session opener", () => {
  test("opens the client, runs a statement, and closes it", async () => {
    hdbScript.connectError = null;
    hdbScript.endThrows = false;
    hdbScript.execError = null;
    hdbScript.ended = false;
    hdbScript.sql = [];
    hdbScript.result = [{ ONE: 1 }];
    const session = await openSapHanaSession(connection);
    expect(hdbScript.options).toMatchObject({ host: "hana.internal", port: 30015, user: "STUDIO" });
    expect(await session.query("SELECT 1 FROM DUMMY")).toEqual({
      rows: [[1]],
      fields: [{ name: "ONE" }],
      rowCount: 1,
    });
    await session.end();
    expect(hdbScript.ended).toBe(true);
    expect(hdbScript.sql).toEqual(["SELECT 1 FROM DUMMY"]);
  });

  test("closes the client when connect fails, and still reports that failure when close throws", async () => {
    hdbScript.connectError = new Error("refused");
    hdbScript.endThrows = false;
    hdbScript.ended = false;
    await expect(openSapHanaSession(connection)).rejects.toThrow("refused");
    expect(hdbScript.ended).toBe(true);

    hdbScript.endThrows = true;
    hdbScript.ended = false;
    await expect(openSapHanaSession(connection)).rejects.toThrow("refused");
    hdbScript.connectError = null;
    hdbScript.endThrows = false;
  });

  test("rejects a statement the client refuses", async () => {
    hdbScript.connectError = null;
    hdbScript.execError = new Error("bad sql");
    const session = await openSapHanaSession(connection);
    await expect(session.query("SELECT")).rejects.toThrow("bad sql");
    hdbScript.execError = null;
    await session.end();
  });
});

describe("SAP HANA provider", () => {
  test("needs a host and a user, and a second connect does nothing", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await expect(providerFor(scripted(), { host: "  " }).connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(providerFor(scripted(), { user: " " }).connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    await provider.connect();
    expect(current.queries[0]).toBe("SELECT 1 FROM DUMMY");
    expect(current.queries[1]).toBe('SET SCHEMA "APP"');
    await provider.connect();
    expect(current.queries).toHaveLength(2);
  });

  test("quotes a schema name and stops when the probe or the schema statement fails", async () => {
    const named = scripted();
    await providerFor(named, { database: 'A"B' }).connect();
    expect(named.queries[1]).toBe('SET SCHEMA "A""B"');

    const bare = scripted();
    await providerFor(bare, { database: "  " }).connect();
    expect(bare.queries).toEqual(["SELECT 1 FROM DUMMY"]);

    const probe = scripted();
    probe.fail = new Error("probe down");
    await expect(providerFor(probe).connect()).rejects.toThrow("probe down");
    expect(probe.ended).toBe(true);

    const schema = scripted();
    const original = open(schema);
    const swapping = new SapHanaProvider(connection, {}, undefined, async () => {
      const session = await original();
      return {
        query: async (sql: string) => {
          if (sql.startsWith("SET SCHEMA")) throw new Error("no schema");
          return session.query(sql);
        },
        end: () => session.end(),
      };
    });
    await expect(swapping.connect()).rejects.toThrow("no schema");
    expect(schema.ended).toBe(true);
  });

  test("runs a statement, refuses parameters, and maps a server error", async () => {
    const current = scripted();
    current.rows = [[1, "a"]];
    current.fields = [{ name: "ID" }, { name: "NAME" }];
    current.rowCount = 1;
    const provider = providerFor(current);
    await expect(provider.query("SELECT 1 FROM DUMMY")).rejects.toBeInstanceOf(QueryError);
    await provider.connect();
    const result = await provider.query("SELECT ID, NAME FROM APP.T");
    expect(result.rows).toEqual([{ ID: 1, NAME: "a" }]);
    expect(result.fields).toEqual(["ID", "NAME"]);
    expect(result.rowCount).toBe(1);
    await expect(provider.query("SELECT 1", [1])).rejects.toBeInstanceOf(QueryError);
    await expect(provider.query("SELECT 1", [])).resolves.toMatchObject({ rowCount: 1 });
    current.fail = new Error("bad sql");
    await expect(provider.query("SELECT")).rejects.toThrow("bad sql");
  });

  test("lists the named schema, or the user schemas, and hides the system ones", async () => {
    const named = scripted();
    const namedProvider = providerFor(named);
    await namedProvider.connect();
    expect(await namedProvider.listContainers(["APP"])).toEqual([]);
    expect(await namedProvider.listContainers()).toEqual([{ path: ["APP"], name: "APP", level: 0 }]);

    const listed = scripted();
    listed.script = [
      {
        match: "SYS.SCHEMAS",
        rows: [["APP"], ["SYS"], ["system"], ["_SYS_BIC"], [""], [7]],
        fields: [{ name: "schema_name" }],
        rowCount: 6,
      },
    ];
    const listedProvider = providerFor(listed, { database: "" });
    await listedProvider.connect();
    expect(await listedProvider.listContainers(undefined)).toEqual([
      { path: ["APP"], name: "APP", level: 0 },
      { path: ["7"], name: "7", level: 0 },
    ]);
  });

  test("lists and describes tables, and reports a catalog failure as unavailable", async () => {
    const current = scripted();
    current.script = [
      {
        match: "SYS.TABLES",
        rows: [["ORDERS"], [""]],
        fields: [{ name: "TABLE_NAME" }],
        rowCount: 2,
      },
      {
        match: "SYS.TABLE_COLUMNS",
        rows: [
          ["ID", "INTEGER", "FALSE"],
          ["NOTE", "NVARCHAR", "TRUE"],
          ["FLAG", "BOOLEAN", "NO"],
        ],
        fields: [{ name: "COLUMN_NAME" }, { name: "DATA_TYPE_NAME" }, { name: "IS_NULLABLE" }],
        rowCount: 3,
      },
      {
        match: "SYS.INDEX_COLUMNS",
        rows: [["ID"]],
        fields: [{ name: "COLUMN_NAME" }],
        rowCount: 1,
      },
    ];
    const provider = providerFor(current);
    await provider.connect();
    expect(await provider.countObjects(["APP"])).toEqual({ table: { count: 1 } });
    expect(await provider.listObjects(["APP"], "table")).toEqual([
      { path: ["APP", "ORDERS"], name: "ORDERS", kind: "table" },
    ]);
    await expect(provider.listObjects(["APP"], "view")).rejects.toBeInstanceOf(QueryError);
    const detail = await provider.describeObject(["APP", "ORDERS"], "table");
    expect(detail.columns).toEqual([
      { name: "ID", type: "INTEGER", nullable: false, isPrimary: true },
      { name: "NOTE", type: "NVARCHAR", nullable: true, isPrimary: false },
      { name: "FLAG", type: "BOOLEAN", nullable: false, isPrimary: false },
    ]);
    const batch = await provider.describeObjects(["APP"], "table");
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toBeUndefined();
    const limited = await provider.describeObjects(["APP"], "table", 1);
    expect(limited.details).toHaveLength(1);

    current.script = [
      {
        match: "SYS.TABLES",
        rows: [["A"], ["B"]],
        fields: [{ name: "TABLE_NAME" }],
        rowCount: 2,
      },
      {
        match: "SYS.TABLE_COLUMNS",
        rows: [],
        fields: [],
        rowCount: 0,
      },
      {
        match: "SYS.INDEX_COLUMNS",
        rows: [],
        fields: [],
        rowCount: 0,
      },
    ];
    const truncated = await provider.describeObjects(["APP"], "table", 1);
    expect(truncated.truncated?.limit).toBe(1);
    await expect(provider.describeObjects(["APP"], "table", 0)).rejects.toBeInstanceOf(QueryError);

    current.fail = "catalog down";
    expect(await provider.countObjects(["APP"])).toEqual({ table: { unavailable: expect.any(String) } });
  });

  test("reports a version, an empty overview, health, and no maintenance", async () => {
    const current = scripted();
    current.script = [
      { match: "SYS.M_DATABASE", rows: [["2.00.076"]], fields: [{ name: "VERSION" }], rowCount: 1 },
      { match: "SYS.TABLES", rows: [["ORDERS"]], fields: [{ name: "TABLE_NAME" }], rowCount: 1 },
    ];
    const provider = providerFor(current);
    await provider.connect();
    expect(await provider.getOverview()).toMatchObject({ version: "2.00.076", tableCount: 1, uptime: "N/A" });
    current.script = [
      { match: "SYS.M_DATABASE", rows: [], fields: [], rowCount: 0 },
      { match: "SYS.TABLES", rows: [], fields: [], rowCount: 0 },
    ];
    expect((await provider.getOverview()).version).toBe("unknown");
    expect(await provider.getHealth()).toMatchObject({ databaseSize: "N/A" });
    await expect(provider.runMaintenance("analyze")).rejects.toBeInstanceOf(QueryError);
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expect(provider.getLabels().entityName).toBe("Table");
    expect(provider.getCapabilities().defaultPort).toBe(30015);
  });

  test("disconnects, including when close throws, and again when already closed", async () => {
    const current = scripted();
    const provider = providerFor(current);
    await provider.disconnect();
    await provider.connect();
    current.failEnd = true;
    await provider.disconnect();
    expect(current.ended).toBe(true);
    await provider.disconnect();
  });
});
