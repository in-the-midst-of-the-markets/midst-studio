import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runImpl: (sql: string) => Promise<{ rows: Record<string, unknown>[]; columnNames: string[] }> = async () => ({
  rows: [],
  columnNames: [],
});

mock.module("@/lib/db/providers/sql/duckdb/client", () => ({
  openDuckDBClient: mock(async () => ({
    readOnly: true,
    run: (sql: string) => runImpl(sql),
    interrupt: () => undefined,
    close: () => undefined,
    endOpenTransaction: async () => false,
  })),
}));

const { queryShareFile } = await import("@/lib/dashboards/share-file");

const ID = "ab".repeat(16);
let directory = "";

function useDataDir(): void {
  directory = mkdtempSync(join(tmpdir(), "share-parse-"));
  process.env.STORAGE_SQLITE_PATH = join(directory, "libredb.db");
  const dir = join(directory, "dashboard-shares");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID}.duckdb`), "");
}

function astOf(ast: unknown): { rows: Record<string, unknown>[]; columnNames: string[] } {
  return { rows: [{ ast: JSON.stringify(ast) }], columnNames: ["ast"] };
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("snapshot parser edges", () => {
  test("wraps a serializer that throws or returns something that is not one statement", async () => {
    useDataDir();
    runImpl = async (sql) => {
      if (sql.includes("json_serialize_sql")) throw new Error("engine blew up");
      return { rows: [], columnNames: [] };
    };
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow("engine blew up");

    runImpl = async (sql) => {
      if (sql.includes("json_serialize_sql")) throw "plain";
      return { rows: [], columnNames: [] };
    };
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow("The statement could not be read.");

    runImpl = async (sql) =>
      sql.includes("json_serialize_sql")
        ? { rows: [{ ast: "{" }], columnNames: ["ast"] }
        : { rows: [], columnNames: [] };
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow("could not be read");

    runImpl = async (sql) =>
      sql.includes("json_serialize_sql") ? { rows: [], columnNames: [] } : { rows: [], columnNames: [] };
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow("could not be read");

    for (const ast of [
      { error: true },
      { error: true, error_message: 12 },
      { statements: [] },
      { statements: [null] },
      { statements: [{ node: null }] },
      {},
    ]) {
      runImpl = async (sql) => (sql.includes("json_serialize_sql") ? astOf(ast) : { rows: [], columnNames: [] });
      await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow(/could not be read|one statement/);
    }
  });

  test("refuses a table with no name and a hidden function named only in the tree", async () => {
    useDataDir();
    const table = {
      error: false,
      statements: [{ node: { type: "BASE_TABLE", schema_name: "main", table_name: "", catalog_name: "" } }],
    };
    runImpl = async (sql) => (sql.includes("json_serialize_sql") ? astOf(table) : { rows: [], columnNames: [] });
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow(/snapshot/);

    const hidden = {
      error: false,
      statements: [
        { node: { type: "FUNCTION", function_name: "query", child: { type: "BASE_TABLE", table_name: "c_abc12345" } } },
      ],
    };
    runImpl = async (sql) => (sql.includes("json_serialize_sql") ? astOf(hidden) : { rows: [], columnNames: [] });
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow(/hidden/);
  });
});
