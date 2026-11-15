/**
 * Databricks SQL with an injected session: the probe is `SELECT 1`, a named schema is
 * the only container, and the catalog is `system.information_schema`. The statement
 * API itself is covered with a scripted HTTP, and one case opens the node transport
 * and closes it without a request.
 */

import { describe, expect, test } from "bun:test";

import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import { httpOrigin } from "@/lib/db/http/endpoint";
import type { NodeTransport } from "@/lib/db/http/node-transport";
import { DatabricksProvider } from "@/lib/db/providers/sql/databricks";
import {
  databricksAddress,
  databricksCell,
  databricksHttp,
  databricksNodeTransport,
  openDatabricksSession,
  runStatement,
  statementRequestBody,
  type DatabricksHttp,
  type DatabricksQueryResult,
} from "@/lib/db/providers/sql/databricks/session";
import type { DatabaseConnection } from "@/lib/types";

interface Scripted {
  queries: string[];
  ended: boolean;
  failEnd: boolean;
  fail: unknown;
  rows: unknown[][];
  fields: { name: string }[];
  rowCount: number | null;
  queue: { rows: unknown[][]; fields: { name: string }[] }[];
}

function scripted(): Scripted {
  return {
    queries: [],
    ended: false,
    failEnd: false,
    fail: undefined,
    rows: [],
    fields: [],
    rowCount: null,
    queue: [],
  };
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "dbx",
    name: "Warehouse",
    host: "adb-1.azuredatabricks.net",
    port: 443,
    password: "dapi-token",
    warehouse: "abc123",
    ...overrides,
    type: "databricks",
    createdAt: overrides.createdAt ?? new Date("2026-11-15T00:00:00.000Z"),
  };
}

function open(current: Scripted) {
  return async () => ({
    async query(sql: string): Promise<DatabricksQueryResult> {
      current.queries.push(sql);
      if (current.fail !== undefined) throw current.fail;
      const next = current.queue.shift();
      if (next !== undefined) return { rows: next.rows, fields: next.fields, rowCount: next.rows.length };
      return { rows: current.rows, fields: current.fields, rowCount: current.rowCount };
    },
    async end() {
      current.ended = true;
      if (current.failEnd) throw new Error("end failed");
    },
  });
}

function provider(current: Scripted, overrides: Partial<DatabaseConnection> = {}): DatabricksProvider {
  return new DatabricksProvider(connection(overrides), {}, undefined, open(current));
}

async function connected(current: Scripted, overrides: Partial<DatabaseConnection> = {}): Promise<DatabricksProvider> {
  const engine = provider(current, overrides);
  await engine.connect();
  current.queries.length = 0;
  return engine;
}

describe("Databricks SQL provider", () => {
  test("needs a workspace host before it opens", async () => {
    const engine = provider(scripted(), { host: "  " });
    await expect(engine.connect()).rejects.toThrow("workspace host");
  });

  test("connects with SELECT 1 and does not open twice", async () => {
    const current = scripted();
    const engine = provider(current);
    await engine.connect();
    await engine.connect();
    expect(current.queries).toEqual(["SELECT 1"]);
  });

  test("closes a session that fails the probe, including a close that itself fails", async () => {
    const current = scripted();
    current.fail = new Error("warehouse is stopped");
    current.failEnd = true;
    const engine = provider(current);
    await expect(engine.connect()).rejects.toThrow("warehouse is stopped");
    expect(current.ended).toBe(true);
  });

  test("query maps rows and refuses a parameter list", async () => {
    const current = scripted();
    current.rows = [
      ["a", 1],
      [undefined, true],
    ];
    current.fields = [{ name: "id" }, { name: "id" }];
    current.rowCount = 2;
    const engine = await connected(current);
    const result = await engine.query("SELECT id FROM t");
    expect(result.fields).toEqual(["id", "id (2)"]);
    expect(result.rows[1]).toEqual({ id: undefined, "id (2)": true });
    expect(result.rowCount).toBe(2);
    await expect(engine.query("SELECT 1", [1])).rejects.toThrow("do not bind parameters");
    current.fail = new QueryError("bad sql", "databricks");
    await expect(engine.query("SELECT 1")).rejects.toThrow("bad sql");
    await expect(provider(scripted()).query("SELECT 1")).rejects.toThrow("Not connected");
  });

  test("a named schema is the only container, and information_schema stays hidden", async () => {
    const named = await connected(scripted(), { schema: "sales" });
    expect(await named.listContainers()).toEqual([{ path: ["sales"], name: "sales", level: 0 }]);
    const current = scripted();
    current.rows = [["information_schema"], ["sales"], [""]];
    current.fields = [{ name: "schema_name" }];
    const engine = await connected(current, { database: "main" });
    expect(await engine.listContainers(["main"])).toEqual([]);
    expect(await engine.listContainers()).toEqual([{ path: ["sales"], name: "sales", level: 0 }]);
    expect(current.queries[0]).toContain("catalog_name = 'main'");
  });

  test("lists managed and external tables and describes columns", async () => {
    const current = scripted();
    current.rows = [["orders"]];
    current.fields = [{ name: "table_name" }];
    const engine = await connected(current);
    expect(await engine.listObjects(["sales"], "table")).toEqual([
      { path: ["sales", "orders"], name: "orders", kind: "table" },
    ]);
    expect(current.queries[0]).toContain("table_schema = 'sales'");
    expect(current.queries[0]).toContain("table_type IN ('MANAGED', 'EXTERNAL')");
    expect(current.queries[0]).toContain("catalog_name = current_catalog()");
    expect(await engine.countObjects(["sales"])).toEqual({ table: { count: 1 } });
    current.rows = [
      ["id", "INT", "NO"],
      ["note", "STRING", "YES"],
    ];
    current.fields = [{ name: "column_name" }, { name: "data_type" }, { name: "is_nullable" }];
    const detail = await engine.describeObject(["o'brien", "orders"], "table");
    expect(detail.columns[0]).toEqual({ name: "id", type: "INT", nullable: false, isPrimary: false });
    expect(detail.columns[1]?.nullable).toBe(true);
    expect(current.queries.at(-1)).toContain("table_schema = 'o''brien'");
    await expect(engine.listObjects(["sales"], "view")).rejects.toThrow("no object kind");
    await expect(engine.describeObject(["sales", "a\\b"], "table")).rejects.toThrow("will not send back");
  });

  test("a catalog read that fails is an unavailable count, including a non-error throw", async () => {
    const current = scripted();
    const engine = await connected(current);
    current.fail = "nope";
    expect(await engine.countObjects(["sales"])).toEqual({ table: { unavailable: "nope" } });
  });

  test("describeObjects honors a limit and refuses one that is not a positive whole number", async () => {
    const current = scripted();
    current.rows = [["a"], ["b"]];
    current.fields = [{ name: "table_name" }];
    const engine = await connected(current);
    const all = await engine.describeObjects(["sales"], "table");
    expect(all.details).toHaveLength(2);
    expect(all.truncated).toBeUndefined();
    const batch = await engine.describeObjects(["sales"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toEqual({ limit: 1, reason: expect.any(String) });
    await expect(engine.describeObjects(["sales"], "table", 0)).rejects.toThrow("positive whole number");
  });

  test("overview reads current_version and maintenance is refused", async () => {
    const current = scripted();
    const engine = await connected(current, { schema: "sales" });
    current.queue = [
      { rows: [["1.0"]], fields: [{ name: "current_version()" }] },
      { rows: [["orders"]], fields: [{ name: "table_name" }] },
      { rows: [[null]], fields: [{ name: "current_version()" }] },
      { rows: [], fields: [{ name: "table_name" }] },
    ];
    const overview = await engine.getOverview();
    expect(overview.version).toBe("1.0");
    expect(overview.tableCount).toBe(1);
    expect(current.queries[1]).toContain("table_schema = 'sales'");
    const empty = await engine.getOverview();
    expect(empty.version).toBe("unknown");
    await expect(engine.runMaintenance("analyze")).rejects.toThrow("no ANALYZE or VACUUM");
    expect(await engine.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(await engine.getPerformanceMetrics()).toEqual({});
    expect(await engine.getSlowQueries()).toEqual([]);
    expect(await engine.getActiveSessions()).toEqual([]);
    expect(await engine.getTableStats()).toEqual([]);
    expect(await engine.getIndexStats()).toEqual([]);
    expect(await engine.getStorageStats()).toEqual([]);
  });

  test("disconnect closes the session and ignores a close that fails", async () => {
    const current = scripted();
    const engine = await connected(current);
    current.failEnd = true;
    await engine.disconnect();
    await engine.disconnect();
    expect(current.ended).toBe(true);
  });

  test("capabilities stay inside what a warehouse was not measured for", () => {
    const engine = new DatabricksProvider(connection());
    const capabilities = engine.getCapabilities();
    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.supportsTransactions).toBe(false);
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    expect(capabilities.supportsResultPagination).toBe(true);
    expect(capabilities.identifierQuoting).toBe("backtick");
    expect(capabilities.defaultPort).toBe(443);
    expect(engine.getLabels().entityName).toBe("Table");
  });
});

describe("Databricks SQL statement API", () => {
  test("reads a pasted https host and refuses the rest", () => {
    expect(databricksAddress("https://ADB-1.azuredatabricks.net/sql", undefined)).toEqual({
      host: "adb-1.azuredatabricks.net",
      port: 443,
    });
    expect(databricksAddress("adb-1.azuredatabricks.net", 8443).port).toBe(8443);
    expect(databricksAddress("https://adb-1.azuredatabricks.net:8443", 0).port).toBe(8443);
    expect(() => databricksAddress("  ", undefined)).toThrow(DatabaseConfigError);
    expect(() => databricksAddress("http://adb-1.azuredatabricks.net", undefined)).toThrow("HTTPS only");
    expect(() => databricksAddress("https://token@adb-1.azuredatabricks.net", undefined)).toThrow("token field");
    expect(() => databricksAddress("https://", undefined)).toThrow(DatabaseConfigError);
  });

  test("the statement body names the warehouse, and the catalog and schema only when set", () => {
    const body = JSON.parse(statementRequestBody(connection({ database: "main", schema: "sales" }), "SELECT 1"));
    expect(body).toEqual({
      warehouse_id: "abc123",
      statement: "SELECT 1",
      wait_timeout: "30s",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      catalog: "main",
      schema: "sales",
    });
    expect(JSON.parse(statementRequestBody(connection(), "SELECT 1")).catalog).toBeUndefined();
    expect(() => statementRequestBody(connection({ warehouse: "" }), "SELECT 1")).toThrow("warehouse id");
    expect(() => statementRequestBody(connection({ database: "main catalog" }), "SELECT 1")).toThrow("catalog");
    expect(() => statementRequestBody(connection({ password: "" }), "SELECT 1")).not.toThrow();
  });

  test("a cell keeps JSON values and cuts a long struct", () => {
    expect(databricksCell(null)).toBeNull();
    expect(databricksCell("a")).toBe("a");
    expect(databricksCell(1)).toBe(1);
    expect(databricksCell(true)).toBe(true);
    expect(databricksCell(undefined)).toBeNull();
    const long = databricksCell({ note: "x".repeat(5000) });
    expect(typeof long).toBe("string");
    expect(String(long).length).toBe(4000);
    expect(databricksCell({ n: 1 })).toBe('{"n":1}');
  });

  test("runs a statement that is already finished", async () => {
    const seen: string[] = [];
    const http = scriptHttp(
      [
        {
          status: 200,
          text: JSON.stringify({
            statement_id: "stmt-1",
            status: { state: "SUCCEEDED" },
            manifest: {
              schema: {
                columns: [
                  { name: "", position: 1 },
                  { name: "id", position: 0 },
                ],
              },
              total_chunk_count: 1,
              total_row_count: 1,
            },
            result: { data_array: [["a", "b"]] },
          }),
        },
      ],
      seen,
    );
    const result = await runStatement(http, connection(), "SELECT 1");
    expect(result.fields.map((field) => field.name)).toEqual(["column_0", "id"]);
    expect(result.rows).toEqual([["a", "b"]]);
    expect(result.rowCount).toBe(1);
    expect(seen).toEqual(["POST /api/2.0/sql/statements"]);
    expect(http.closed).toBe(false);
  });

  test("polls a running statement and then reads the next inline chunk", async () => {
    const seen: string[] = [];
    const http = scriptHttp(
      [
        { status: 200, text: JSON.stringify({ statement_id: "stmt_1", status: { state: "PENDING" } }) },
        { status: 200, text: JSON.stringify({ statement_id: "stmt_1", status: { state: "RUNNING" } }) },
        {
          status: 200,
          text: JSON.stringify({
            statement_id: "stmt_1",
            status: { state: "SUCCEEDED" },
            manifest: { total_chunk_count: 2, total_row_count: -1 },
            result: { data_array: [["a"]] },
          }),
        },
        { status: 200, text: JSON.stringify({ data_array: [[{ n: 1 }]] }) },
      ],
      seen,
    );
    const result = await runStatement(http, connection(), "SELECT 1", async () => undefined);
    expect(result.rows).toEqual([["a"], ['{"n":1}']]);
    expect(result.rowCount).toBe(2);
    expect(seen[1]).toBe("GET /api/2.0/sql/statements/stmt_1");
    expect(seen[3]).toBe("GET /api/2.0/sql/statements/stmt_1/result/chunks/1");
  });

  test("refuses a statement that does not finish inline", async () => {
    const pending = scriptHttp(
      Array.from({ length: 21 }, () => ({
        status: 200,
        text: JSON.stringify({ statement_id: "stmt-1", status: { state: "PENDING" } }),
      })),
    );
    await expect(runStatement(pending, connection(), "SELECT 1", async () => undefined)).rejects.toThrow(
      "still running",
    );
    await expect(runStatement(failed("FAILED", "bad sql"), connection(), "SELECT 1")).rejects.toThrow("bad sql");
    await expect(runStatement(failed("CANCELED", ""), connection(), "SELECT 1")).rejects.toThrow("CANCELED");
    await expect(runStatement(failed("CLOSED", ""), connection(), "SELECT 1")).rejects.toThrow("CLOSED");
    await expect(runStatement(failed("QUEUED", ""), connection(), "SELECT 1")).rejects.toThrow("does not read");
    await expect(
      runStatement(
        scriptHttp([
          {
            status: 200,
            text: JSON.stringify({
              status: { state: "SUCCEEDED" },
              manifest: { truncated: true },
              result: { data_array: [] },
            }),
          },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("inline page");
    await expect(
      runStatement(
        scriptHttp([
          {
            status: 200,
            text: JSON.stringify({
              status: { state: "SUCCEEDED" },
              result: { external_links: [{}], data_array: [] },
            }),
          },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("inline page");
    await expect(
      runStatement(
        scriptHttp([
          {
            status: 200,
            text: JSON.stringify({
              statement_id: "stmt-1",
              status: { state: "SUCCEEDED" },
              manifest: { total_chunk_count: 9 },
              result: { data_array: [] },
            }),
          },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("inline page");
  });

  test("refuses a statement id, a row, or an HTTP status it will not follow", async () => {
    await expect(
      runStatement(
        scriptHttp([
          {
            status: 200,
            text: JSON.stringify({
              statement_id: "../etc",
              status: { state: "SUCCEEDED" },
              manifest: { total_chunk_count: 2 },
              result: { data_array: [] },
            }),
          },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("statement id");
    await expect(
      runStatement(
        scriptHttp([
          { status: 200, text: JSON.stringify({ status: { state: "SUCCEEDED" }, result: { data_array: [1] } }) },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("not a list");
    await expect(
      runStatement(
        scriptHttp([
          { status: 200, text: JSON.stringify({ status: { state: "SUCCEEDED" }, result: { data_array: "nope" } }) },
        ]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toThrow("not a list of rows");
    await expect(
      runStatement(scriptHttp([{ status: 401, text: JSON.stringify({ message: "no" }) }]), connection(), "SELECT 1"),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      runStatement(
        scriptHttp([{ status: 403, text: JSON.stringify({ status: { error: { message: "denied" } } }) }]),
        connection(),
        "SELECT 1",
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(runStatement(scriptHttp([{ status: 500, text: "nope" }]), connection(), "SELECT 1")).rejects.toThrow(
      "HTTP 500",
    );
    await expect(
      runStatement(scriptHttp([{ status: 500, text: JSON.stringify({ message: "down" }) }]), connection(), "SELECT 1"),
    ).rejects.toThrow("down");
    await expect(runStatement(scriptHttp([{ status: 400, text: "[]" }]), connection(), "SELECT 1")).rejects.toThrow(
      "HTTP 400",
    );
    expect(() => databricksAddress("https://adb-1.azuredatabricks.net", undefined)).not.toThrow();
  });

  test("the node transport is HTTPS and closes without a request", async () => {
    const opened = databricksNodeTransport(connection());
    expect(opened.origin).toEqual({ scheme: "https", host: "adb-1.azuredatabricks.net", port: 443 });
    opened.transport.close();
    expect(() => databricksNodeTransport(connection({ ssl: { mode: "disable" } }))).toThrow("HTTPS only");
    expect(() => databricksNodeTransport(connection({ password: "has a space" }))).toThrow("cannot send");
    expect(() => databricksNodeTransport(connection({ password: "" }))).toThrow("access token");
    const calls: string[] = [];
    const transport: NodeTransport = {
      async request(input) {
        calls.push(input.url);
        return { status: 204, contentType: null, retryAfter: null, text: "" };
      },
      close() {
        calls.push("close");
      },
    };
    const http = databricksHttp(transport, httpOrigin("https", "adb-1.azuredatabricks.net", 443));
    const response = await http.request({ method: "GET", path: "/api/2.0/sql/statements/stmt-1" });
    expect(response.status).toBe(204);
    expect(calls[0]).toContain("/api/2.0/sql/statements/stmt-1");
    http.close();
    expect(calls[1]).toBe("close");
    const session = await openDatabricksSession(connection(), {
      async request() {
        return {
          status: 200,
          text: JSON.stringify({ status: { state: "SUCCEEDED" }, result: { data_array: [] } }),
        };
      },
      close() {
        calls.push("session");
      },
    });
    expect((await session.query("SELECT 1")).rows).toEqual([]);
    await session.end();
    expect(calls).toContain("session");
  });

  test("opening without an injected HTTP builds the node transport and closes it", async () => {
    const session = await openDatabricksSession(connection());
    await session.end();
  });

  test("waitForPoll resolves", async () => {
    const { waitForPoll } = await import("@/lib/db/providers/sql/databricks/session");
    await waitForPoll(0);
  });
});

function scriptHttp(
  steps: { status: number; text: string }[],
  seen: string[] = [],
): DatabricksHttp & { closed: boolean } {
  let index = 0;
  return {
    closed: false,
    async request(input) {
      seen.push(`${input.method} ${input.path}`);
      const step = steps[index] ?? steps[steps.length - 1];
      index += 1;
      if (step === undefined) return { status: 500, text: "" };
      return step;
    },
    close() {
      this.closed = true;
    },
  };
}

function failed(state: string, message: string): DatabricksHttp {
  return scriptHttp([
    {
      status: 200,
      text: JSON.stringify({
        statement_id: "stmt-1",
        status: { state, error: message === "" ? {} : { message } },
      }),
    },
  ]);
}
