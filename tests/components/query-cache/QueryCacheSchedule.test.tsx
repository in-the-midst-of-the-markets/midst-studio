import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryCacheSchedule } from "@/components/query-cache/QueryCacheSchedule";
import type { DatabaseConnection } from "@/lib/types";

const SOURCE: DatabaseConnection = {
  id: "c1",
  name: "App",
  type: "postgres",
  createdAt: new Date(0),
};

const DUE = {
  tableName: "orders",
  sourceName: "App",
  sourceSql: "SELECT 1",
  sourceConnectionId: "c1",
  rowCount: 1,
  cachedAt: "2000-01-01T00:00:00.000Z",
  refreshSeconds: 60,
};

const realFetch = globalThis.fetch;

function answer(url: string, init?: RequestInit): Response {
  if (url.includes("query-cache") && init?.body === undefined) {
    return new Response(JSON.stringify({ tables: [DUE] }), { status: 200 });
  }
  if (url.includes("/api/db/query") && !url.includes("query-cache")) {
    return new Response(JSON.stringify({ rows: [{ id: 1 }], fields: ["id"] }), { status: 200 });
  }
  return new Response(JSON.stringify({ replaced: true }), { status: 200 });
}

describe("QueryCacheSchedule", () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  test("reruns a due table and tells the shell, then stops when the shell unmounts", async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) =>
      Promise.resolve(answer(String(url), init)),
    ) as unknown as typeof fetch;
    const onRefreshed = mock(() => {});
    const { unmount } = render(<QueryCacheSchedule connections={[SOURCE]} onRefreshed={onRefreshed} intervalMs={20} />);
    await waitFor(() => expect(onRefreshed).toHaveBeenCalled());
    unmount();
  });

  test("renders with the page poll and does nothing while nothing is due", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ tables: [{ ...DUE, cachedAt: "2999-01-01T00:00:00.000Z" }] })),
    ) as unknown as typeof fetch;
    const onRefreshed = mock(() => {});
    const { unmount } = render(<QueryCacheSchedule connections={[SOURCE]} onRefreshed={onRefreshed} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(onRefreshed).not.toHaveBeenCalled();
    unmount();
  });

  test("a failed list is ignored, and a refresh that finishes after unmount does not notify", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    const failed = render(<QueryCacheSchedule connections={[SOURCE]} intervalMs={20} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    failed.unmount();

    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const onRefreshed = mock(() => {});
    globalThis.fetch = mock(() => {
      calls += 1;
      if (calls === 1) return gate;
      return Promise.resolve(answer("/api/db/query"));
    }) as unknown as typeof fetch;
    const view = render(<QueryCacheSchedule connections={[SOURCE]} onRefreshed={onRefreshed} intervalMs={15} />);
    await waitFor(() => expect(calls).toBe(1));
    view.unmount();
    release(new Response(JSON.stringify({ tables: [DUE] }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  test("a tick that is already running does not start another", async () => {
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls += 1;
      if (calls === 1) return gate;
      return Promise.resolve(new Response(JSON.stringify({ tables: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const { unmount } = render(<QueryCacheSchedule connections={[SOURCE]} intervalMs={15} />);
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    release(new Response(JSON.stringify({ tables: [] }), { status: 200 }));
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    unmount();
  });
});
