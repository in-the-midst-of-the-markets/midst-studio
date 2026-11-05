import { describe, expect, mock, test } from "bun:test";
import type { SavedJoinLimits } from "@/lib/saved-join/limits";

let opened = 0;
let interrupted = 0;
let closed = 0;
let runImpl: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; columnNames: string[] }> =
  async () => ({ rows: [], columnNames: [] });

mock.module("@/lib/db/providers/sql/duckdb/client", () => ({
  openDuckDBClient: mock(async () => {
    opened += 1;
    return {
      readOnly: false,
      run: (sql: string, params?: unknown[]) => runImpl(sql, params),
      interrupt: () => {
        interrupted += 1;
      },
      close: () => {
        closed += 1;
      },
      endOpenTransaction: async () => false,
    };
  }),
}));

const { runSavedJoin } = await import("@/lib/saved-join/run");

const limits: SavedJoinLimits = {
  maxSourceRows: 10,
  maxResultRows: 10,
  memoryLimit: "256MB",
  threads: 1,
  timeoutMs: 15_000,
};
const page = { limit: 10, offset: 0, unlimited: false };
const idle = new AbortController().signal;

function astOf(ast: unknown): { rows: Record<string, unknown>[]; columnNames: string[] } {
  return { rows: [{ ast: JSON.stringify(ast) }], columnNames: ["ast"] };
}

async function refuse(ast: unknown, message: string): Promise<void> {
  runImpl = async (sql) => (sql.includes("json_serialize_sql") ? astOf(ast) : { rows: [], columnNames: [] });
  await expect(
    runSavedJoin({
      sql: "SELECT 1",
      saved: [],
      page,
      signal: idle,
      limits,
      runSource: async () => {
        throw new Error("the saved query should not run");
      },
    }),
  ).rejects.toThrow(message);
}

describe("saved join parser edges the engine does not emit", () => {
  test("wraps an engine failure, including one that is not an Error", async () => {
    runImpl = async (sql) => {
      if (sql.includes("json_serialize_sql")) throw new Error("engine blew up");
      return { rows: [], columnNames: [] };
    };
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: idle,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("engine blew up");
    expect(closed).toBeGreaterThan(0);

    runImpl = async (sql) => {
      if (sql.includes("json_serialize_sql")) throw "plain";
      return { rows: [], columnNames: [] };
    };
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: idle,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("plain");
  });

  test("refuses a statement the serializer did not return as JSON", async () => {
    runImpl = async (sql) =>
      sql.includes("json_serialize_sql")
        ? { rows: [{ ast: "{" }], columnNames: ["ast"] }
        : { rows: [], columnNames: [] };
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: idle,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("could not be read");
  });

  test("refuses an empty serializer answer and an error with no sentence", async () => {
    runImpl = async (sql) =>
      sql.includes("json_serialize_sql") ? { rows: [], columnNames: [] } : { rows: [], columnNames: [] };
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: idle,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("could not be read");
    await refuse({ error: true }, "could not be read");
    await refuse({ error: true, error_message: 12 }, "could not be read");
  });

  test("refuses a serializer answer that is not one statement with a node", async () => {
    await refuse({ error: false, statements: [] }, "one DuckDB statement");
    await refuse({ error: false, statements: [null] }, "one DuckDB statement");
    await refuse({ error: false, statements: [{ node: null }] }, "one DuckDB statement");
    await refuse({ error: false }, "one DuckDB statement");
  });

  test("refuses a saved table with no name", async () => {
    await refuse(
      {
        error: false,
        statements: [
          {
            node: {
              type: "SELECT_NODE",
              from_table: {
                type: "BASE_TABLE",
                schema_name: "saved",
                table_name: "",
                catalog_name: "",
                at_clause: null,
              },
            },
          },
        ],
      },
      "needs the saved query's ID",
    );
  });

  test("a cancel during parsing stops the engine and closes it", async () => {
    const controller = new AbortController();
    const before = interrupted;
    runImpl = async (sql) => {
      if (sql.includes("json_serialize_sql")) {
        controller.abort();
        throw new Error("stopped");
      }
      return { rows: [], columnNames: [] };
    };
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: controller.signal,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("cancelled");
    expect(interrupted).toBeGreaterThan(before);
    expect(closed).toBeGreaterThan(0);
  });

  test("an already cancelled join does not open an engine", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = opened;
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal: controller.signal,
        limits,
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("cancelled");
    expect(opened).toBe(before);
  });

  test("a timeout that already fired says how long the join was allowed", async () => {
    const signal = AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(
      runSavedJoin({
        sql: "SELECT 1",
        saved: [],
        page,
        signal,
        limits: { ...limits, timeoutMs: 30 },
        runSource: async () => ({ fields: [], rows: [] }),
      }),
    ).rejects.toThrow("longer than 1 seconds");
  });
});
