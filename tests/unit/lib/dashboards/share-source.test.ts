import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockProvider } from "../../../helpers/mock-provider";
import { mockSelectResult } from "../../../fixtures/query-results";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { queryEventRequest } from "@/lib/query-events/route-events";
import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";

let provider: DatabaseProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => provider);

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
}));

const { ShareError, shareRowLimitMessage } = await import("@/lib/dashboards/share-limits");
const { runShareSource } = await import("@/lib/dashboards/share-source");

const connection = { id: "c1", type: "postgres", name: "App" } as DatabaseConnection;
const events = queryEventRequest(
  "editor",
  { role: "user", username: "ada" },
  new Request("http://localhost/api/share"),
);

describe("runShareSource", () => {
  beforeEach(() => {
    provider = createMockProvider();
    mockGetOrCreateProvider.mockReset();
    mockGetOrCreateProvider.mockImplementation(async () => provider);
  });

  test("copies a read and refuses a write before anything runs", async () => {
    const copied = await runShareSource(
      events.principal as never,
      connection,
      "SELECT region FROM sales",
      'Chart "Revenue"',
      AbortSignal.timeout(1000),
      events,
    );
    expect(copied.fields).toEqual(mockSelectResult.fields);
    expect(copied.rows).toHaveLength(3);
    await expect(
      runShareSource(
        events.principal as never,
        connection,
        "DELETE FROM sales",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toThrow(/has to be a read/);
  });

  test("refuses a result past the row cap, a result with no columns, and a failed query", async () => {
    provider = createMockProvider({
      queryResult: { ...mockSelectResult, rows: Array.from({ length: 51 }, (_, index) => ({ id: index })) },
    });
    await expect(
      runShareSource(
        { username: "ada", role: "user" },
        connection,
        "SELECT id FROM sales",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toThrow(shareRowLimitMessage('Chart "Revenue"'));

    provider = createMockProvider({ queryResult: { rows: [], fields: [], rowCount: 0, executionTime: 1 } });
    await expect(
      runShareSource(
        { username: "ada", role: "user" },
        connection,
        "SELECT 1",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toThrow(/no columns/);

    provider = createMockProvider();
    provider.query = mock(async () => {
      throw new Error("down");
    });
    await expect(
      runShareSource(
        { username: "ada", role: "user" },
        connection,
        "SELECT 1",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toThrow('Chart "Revenue": down');

    provider.query = mock(async () => {
      throw "down";
    });
    await expect(
      runShareSource(
        { username: "ada", role: "user" },
        connection,
        "SELECT 1",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toThrow('Chart "Revenue": The query failed.');
  });

  test("a seed refusal is recorded and returned as itself", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new SeedConnectionError(
        "Connection not found: it does not exist or is not granted to you",
        404,
        "CONNECTION_NOT_FOUND",
      );
    });
    await expect(
      runShareSource(
        { username: "ada", role: "user" },
        connection,
        "SELECT 1",
        'Chart "Revenue"',
        AbortSignal.timeout(1000),
        events,
      ),
    ).rejects.toBeInstanceOf(SeedConnectionError);
    expect(new ShareError("x").name).toBe("ShareError");
  });
});
