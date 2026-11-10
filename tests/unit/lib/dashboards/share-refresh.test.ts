import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShareRecord } from "@/lib/dashboards/share-record";
import type { DatabaseConnection } from "@/lib/types";

let stored: unknown = null;
let provider: { getCollection: (key: string, name: string) => Promise<unknown> } | null = null;

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => provider,
}));

const { queryShareFile } = await import("@/lib/dashboards/share-file");
const { ShareError } = await import("@/lib/dashboards/share-limits");
const { readShare, writeShare } = await import("@/lib/dashboards/share-record");
const { loadShareOwnerConnections, refreshShareIfDue, shareIsDue } = await import("@/lib/dashboards/share-refresh");

const connection = { id: "c1", type: "postgres" } as DatabaseConnection;
const ID = "ef".repeat(16);
let directory = "";

function useDataDir(): void {
  directory = mkdtempSync(join(tmpdir(), "share-refresh-"));
  process.env.STORAGE_SQLITE_PATH = join(directory, "libredb.db");
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: ID,
    ownerKey: "ada",
    owner: { username: "ada", role: "user" },
    name: "Sales",
    dashboard: { id: "dash", name: "Sales", charts: [], createdAt: now, updatedAt: now },
    charts: [],
    sources: [{ table: "c_abc12345", connectionId: "c1", sql: "SELECT 1" }],
    tables: ["c_abc12345"],
    refreshSeconds: 60,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    refreshedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
  provider = null;
  stored = null;
});

describe("share refresh", () => {
  test("a snapshot is due when the interval has passed, and an unreadable time is due", () => {
    const saved = record();
    expect(shareIsDue(saved, new Date("2026-01-01T00:00:30.000Z").getTime(), false)).toBe(false);
    expect(shareIsDue(saved, new Date("2026-01-01T00:01:00.000Z").getTime(), false)).toBe(true);
    expect(shareIsDue(saved, new Date("2026-01-01T00:00:00.000Z").getTime(), true)).toBe(true);
    expect(shareIsDue(record({ refreshSeconds: undefined }), Date.now(), false)).toBe(false);
    expect(shareIsDue(record({ refreshedAt: "never" }), Date.now(), false)).toBe(true);
    expect(shareIsDue(record({ sources: [] }), Date.now(), true)).toBe(false);
  });

  test("keeps the previous file when a source fails, and replaces it when the source answers", async () => {
    useDataDir();
    const saved = record();
    writeShare(saved);
    const kept = await refreshShareIfDue(
      saved,
      {
        now: () => new Date("2026-01-01T00:02:00.000Z").getTime(),
        loadConnections: async () => [connection],
        resolve: async (found) => found,
        run: async () => {
          throw new ShareError("Revenue: down");
        },
      },
      false,
    );
    expect(kept.refreshedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(readShare(ID)?.refreshedAt).toBe("2026-01-01T00:02:00.000Z");

    const replaced = await refreshShareIfDue(saved, {
      now: () => new Date("2026-01-01T00:03:00.000Z").getTime(),
      loadConnections: async () => [connection],
      resolve: async (found) => found,
      run: async () => ({ fields: ["n"], rows: [{ n: 1 }] }),
    });
    expect(replaced.refreshedAt).toBe("2026-01-01T00:03:00.000Z");
    const rows = await queryShareFile(ID, 'SELECT n FROM "c_abc12345"', ["c_abc12345"]);
    expect(rows.rowCount).toBe(1);
  });

  test("a forced refresh reports the failure, and a snapshot with no stored connections waits", async () => {
    useDataDir();
    await expect(
      refreshShareIfDue(
        record(),
        {
          now: () => Date.now(),
          loadConnections: async () => [connection],
          resolve: async (found) => found,
          run: async () => {
            throw "down";
          },
        },
        true,
      ),
    ).rejects.toBe("down");

    const saved = record();
    const waiting = await refreshShareIfDue(saved, {
      now: () => Date.now(),
      loadConnections: async () => null,
      resolve: async (found) => found,
      run: async () => ({ fields: [], rows: [] }),
    });
    expect(waiting).toBe(saved);

    const fresh = await refreshShareIfDue(saved, {
      now: () => new Date("2026-01-01T00:00:10.000Z").getTime(),
      loadConnections: async () => [connection],
      resolve: async (found) => found,
      run: async () => ({ fields: [], rows: [] }),
    });
    expect(fresh).toBe(saved);

    writeShare(saved);
    const missing = await refreshShareIfDue(
      saved,
      {
        now: () => new Date("2026-01-01T00:02:00.000Z").getTime(),
        loadConnections: async () => [],
        resolve: async (found) => found,
        run: async () => ({ fields: [], rows: [] }),
      },
      false,
    );
    expect(missing.refreshedAt).toBe("2026-01-01T00:02:00.000Z");

    const idle = await refreshShareIfDue(
      record({ sources: [] }),
      {
        now: () => Date.now(),
        loadConnections: async () => {
          throw new Error("should not load");
        },
        resolve: async (found) => found,
        run: async () => ({ fields: [], rows: [] }),
      },
      true,
    );
    expect(idle.sources).toEqual([]);
  });

  test("stored connections are read for the owner, and anything else waits", async () => {
    expect(await loadShareOwnerConnections("ada")).toBeNull();
    provider = { getCollection: mock(async () => stored) };
    stored = "nope";
    expect(await loadShareOwnerConnections("ada")).toBeNull();
    stored = [connection];
    expect(await loadShareOwnerConnections("ada")).toEqual([connection]);
  });
});
