import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryShareFile, writeShareTables } from "@/lib/dashboards/share-file";
import { ShareError, ShareNotFoundError } from "@/lib/dashboards/share-limits";
import {
  deleteShare,
  newShareId,
  ownerSession,
  publicShare,
  readShare,
  shareJsonPath,
  writeShare,
  type ShareRecord,
} from "@/lib/dashboards/share-record";

const ID = "cd".repeat(16);
let directory = "";

function useDataDir(): void {
  directory = mkdtempSync(join(tmpdir(), "share-file-"));
  process.env.STORAGE_SQLITE_PATH = join(directory, "libredb.db");
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: ID,
    name: "Sales",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    refreshedAt: "2026-01-01T00:00:00.000Z",
    ownerKey: "ada",
    owner: { username: "ada", role: "user", idpSubject: "sub", idpIssuer: "https://idp.example" },
    dashboard: { id: "dash", name: "Sales", charts: [], createdAt: now, updatedAt: now },
    charts: [],
    sources: [{ table: "c_abc12345", connectionId: "c1", sql: "SELECT 1" }],
    tables: ["c_abc12345"],
    refreshSeconds: 60,
    ...overrides,
  };
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("snapshot file", () => {
  test("writes the copied rows and answers one SELECT against them", async () => {
    useDataDir();
    await writeShareTables(ID, [
      {
        table: "c_abc12345",
        fields: ["region", "total", "open", "when", "meta", "n", "f", "blank"],
        rows: [
          {
            region: "east",
            total: 10,
            open: true,
            when: new Date("2026-01-02T00:00:00.000Z"),
            meta: { a: 1 },
            n: BigInt(1),
            f: 1.5,
            blank: null,
          },
          { region: "west", total: "3", open: false, when: null, meta: null, n: 2, f: 2, blank: Number.NaN },
        ],
      },
      { table: "f_empty", fields: ["id"], rows: [] },
    ]);
    const rows = await queryShareFile(ID, "SELECT region, total FROM \"c_abc12345\" WHERE region = 'east'", [
      "c_abc12345",
      "f_empty",
    ]);
    expect(rows.rowCount).toBe(1);
    expect(String(rows.rows[0]?.region)).toBe("east");
    const cte = await queryShareFile(ID, 'WITH picked AS (SELECT region FROM "c_abc12345") SELECT region FROM picked', [
      "c_abc12345",
    ]);
    expect(cte.rows).toHaveLength(2);
    const named = await queryShareFile(ID, 'SELECT * FROM "C_ABC12345"', ["c_abc12345"]);
    expect(named.rowCount).toBe(2);
  });

  test("refuses a write, a foreign table, a second statement, and a missing file", async () => {
    useDataDir();
    await expect(writeShareTables(ID, [{ table: "c_abc12345", fields: [], rows: [] }])).rejects.toThrow(/no columns/);
    await writeShareTables(ID, [{ table: "c_abc12345", fields: ["region"], rows: [{ region: "east" }] }]);
    await expect(queryShareFile(ID, "COPY \"c_abc12345\" TO '/tmp/x'", ["c_abc12345"])).rejects.toThrow(ShareError);
    await expect(queryShareFile(ID, "SELECT * FROM other", ["c_abc12345"])).rejects.toThrow(/snapshot/);
    await expect(queryShareFile(ID, "SELECT 1; SELECT 2", ["c_abc12345"])).rejects.toThrow(/one statement/);
    await expect(queryShareFile(ID, "SELECT current_setting('memory_limit')", ["c_abc12345"])).rejects.toThrow(
      /settings/,
    );
    await expect(queryShareFile(ID, "SELECT 1", ["c_abc12345"])).rejects.toThrow(/snapshot/);
    await expect(queryShareFile(ID, "SELECT * FROM read_csv_auto('x')", ["c_abc12345"])).rejects.toThrow(/snapshot/);
    await expect(
      queryShareFile(ID, `SELECT json_execute_serialized_sql(json_serialize_sql('SELECT 1')) FROM "c_abc12345"`, [
        "c_abc12345",
      ]),
    ).rejects.toThrow(/hidden/);
    await expect(queryShareFile(ID, "SELECT * FROM other.thing", ["c_abc12345"])).rejects.toThrow(/snapshot/);
    await expect(queryShareFile(ID, "SELECT * FROM mem.main.thing", ["c_abc12345"])).rejects.toThrow(/snapshot/);
    await expect(queryShareFile(ID, `SELECT * FROM "c_abc12345" AT (VERSION => 1)`, ["c_abc12345"])).rejects.toThrow(
      /snapshot/,
    );
    await expect(queryShareFile(ID, "SELECT FROM", ["c_abc12345"])).rejects.toThrow(
      /snapshot|could not be read|syntax/i,
    );
    await expect(queryShareFile("nope", "SELECT 1", [])).rejects.toBeInstanceOf(ShareNotFoundError);
    await expect(queryShareFile("ab".repeat(16), "SELECT 1", [])).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  test("refuses a result larger than the snapshot will show", async () => {
    useDataDir();
    const rows = Array.from({ length: 10_001 }, (_, index) => ({ n: index }));
    await writeShareTables(ID, [{ table: "c_abc12345", fields: ["n"], rows }]);
    await expect(queryShareFile(ID, 'SELECT n FROM "c_abc12345"', ["c_abc12345"])).rejects.toThrow(/more rows/);
  });

  test("a record round-trips and the public view drops the sources and the owner", () => {
    useDataDir();
    const saved = record();
    writeShare(saved);
    const loaded = readShare(ID);
    expect(loaded?.owner.username).toBe("ada");
    expect(loaded?.owner.idpSubject).toBe("sub");
    expect(loaded?.dashboard.createdAt).toBeInstanceOf(Date);
    expect(ownerSession(saved).idpIssuer).toBe("https://idp.example");
    const view = publicShare(saved);
    expect(view).not.toHaveProperty("sources");
    expect(view).not.toHaveProperty("owner");
    expect(view.refreshSeconds).toBe(60);
    expect(publicShare(record({ refreshSeconds: undefined })).refreshSeconds).toBeUndefined();
    expect(newShareId()).toMatch(/^[a-f0-9]{32}$/);
    deleteShare(ID);
    expect(readShare(ID)).toBeNull();
    expect(readShare("../escape")).toBeNull();
    expect(() => deleteShare("nope")).toThrow(ShareNotFoundError);
    expect(() => shareJsonPath("nope")).toThrow(ShareNotFoundError);
  });

  test("a broken record is ignored and a thin one is filled in", () => {
    useDataDir();
    const dir = join(directory, "dashboard-shares");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}.json`), "{");
    expect(readShare(ID)).toBeNull();
    writeFileSync(join(dir, `${ID}.json`), JSON.stringify({ id: ID }));
    expect(readShare(ID)).toBeNull();
    writeFileSync(
      join(dir, `${ID}.json`),
      JSON.stringify({
        id: ID,
        owner: { username: "ada", role: "nope" },
        dashboard: { id: "dash", name: "Sales", charts: [] },
        charts: [],
        sources: [],
      }),
    );
    expect(readShare(ID)).toBeNull();
    writeFileSync(
      join(dir, `${ID}.json`),
      JSON.stringify({
        id: ID,
        owner: { username: "ada", role: "admin" },
        dashboard: {
          id: "dash",
          name: "Sales",
          charts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        charts: [
          {
            id: "revenue",
            name: "Revenue",
            chartType: "bar",
            xAxis: "region",
            yAxis: ["total"],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sources: [{ table: "c_abc12345", connectionId: "c1", sql: "SELECT 1" }, { table: 1 }],
        tables: ["c_abc12345", 2],
      }),
    );
    const loaded = readShare(ID);
    expect(loaded?.name).toBe("Dashboard");
    expect(loaded?.owner.role).toBe("admin");
    expect(loaded?.sources).toHaveLength(1);
    expect(loaded?.tables).toEqual(["c_abc12345"]);
    expect(loaded?.refreshSeconds).toBeUndefined();
    expect(ownerSession(loaded!).idpSubject).toBeUndefined();
  });
});
