import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CacheResults } from "@/components/query-cache/CacheResults";
import { QUERY_CACHE_MAX_ROWS } from "@/lib/query-cache/limits";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

const SOURCE: DatabaseConnection = {
  id: "c1",
  name: "App",
  type: "postgres",
  createdAt: new Date(0),
};

const RESULT: QueryResult = {
  fields: ["id", "name"],
  rows: [{ id: 1, name: "Ada" }],
  rowCount: 1,
  executionTime: 4,
};

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  body?: unknown;
}

function isSourceQuery(url: string): boolean {
  return url.includes("/api/db/query") && !url.includes("/api/db/query-cache");
}

function renderCache(
  props: Partial<Parameters<typeof CacheResults>[0]> = {},
  respond: (call: Call) => { ok?: boolean; status?: number; json: unknown } = () => ({ json: { tables: [] } }),
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined };
    calls.push(call);
    const answer = respond(call);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? (answer.ok === false ? 400 : 200) });
  }) as unknown as typeof fetch;
  render(
    <CacheResults
      result={props.result ?? RESULT}
      sql={props.sql ?? "SELECT id, name FROM orders"}
      source={props.source === undefined ? SOURCE : props.source}
      connections={props.connections ?? [SOURCE]}
      onCached={props.onCached}
    />,
  );
  return calls;
}

describe("CacheResults", () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  test("stays hidden without a source or without rows", () => {
    const { container, rerender } = render(<CacheResults result={RESULT} sql="SELECT 1" source={null} />);
    expect(container.textContent).toBe("");
    rerender(<CacheResults result={{ ...RESULT, rows: [] }} sql="SELECT 1" source={SOURCE} />);
    expect(container.textContent).toBe("");
  });

  test("caches the loaded rows and says when the table already exists", async () => {
    renderCache({}, (call) =>
      call.url.includes("query-cache") && call.body === undefined
        ? {
            json: {
              tables: [
                {
                  tableName: "orders",
                  sourceName: "App",
                  sourceSql: "SELECT 1",
                  sourceConnectionId: "c1",
                  rowCount: 3,
                  cachedAt: "t",
                },
              ],
            },
          }
        : { json: { tableName: "orders", rowCount: 1, replaced: true } },
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("3 rows from App"));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    expect(document.body.textContent).toContain("Replace cached table");
    expect(document.body.textContent).toContain("Replace overwrites the rows in orders");
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Replaced orders with 1 rows"));
  });

  test("a new table is cached, and a query-cache source says so", async () => {
    const calls = renderCache(
      { source: { id: "query-cache", name: "Query cache", type: "duckdb", createdAt: new Date(0) } },
      () => ({ json: { tableName: "notes", rowCount: 1, replaced: false } }),
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    expect(document.body.textContent).toContain("already in Query cache");
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "notes" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Cached 1 rows as notes"));
    expect(calls.some((call) => call.url.includes("query-cache") && call.body !== undefined)).toBe(true);
  });

  test("says when only part of the result is loaded", async () => {
    renderCache(
      {
        result: {
          ...RESULT,
          pagination: { limit: 1, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
        },
      },
      () => ({
        json: {
          tables: [
            {
              tableName: "orders",
              sourceName: "App",
              sourceSql: "SELECT 1",
              sourceConnectionId: "c1",
              rowCount: 1,
              cachedAt: "t",
            },
          ],
        },
      }),
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    expect(document.body.textContent).toContain("Only the rows loaded so far are cached");
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
  });

  test("refuses a name and a result that is too large", async () => {
    renderCache({}, () => ({
      json: {
        tables: [
          {
            tableName: "kept",
            sourceName: "App",
            sourceSql: "SELECT 1",
            sourceConnectionId: "c1",
            rowCount: 1,
            cachedAt: "t",
          },
        ],
      },
    }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    expect(document.body.textContent).toContain("Enter a table name");
    const huge = {
      ...RESULT,
      rows: Array.from({ length: QUERY_CACHE_MAX_ROWS + 1 }, () => ({ id: 1, name: "Ada" })),
    };
    cleanup();
    renderCache({ result: huge }, () => ({
      json: {
        tables: [
          {
            tableName: "kept",
            sourceName: "App",
            sourceSql: "SELECT 1",
            sourceConnectionId: "c1",
            rowCount: 1,
            cachedAt: "t",
          },
        ],
      },
    }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    expect(document.body.textContent).toContain("10,000");
  });

  test("reports a failed cache and a failed list", async () => {
    renderCache({}, () => ({ ok: false, json: { error: "disk full" } }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("disk full"));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("disk full"));
  });

  test("refreshes a cached table from its source and overwrites the rows", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT id, name FROM orders",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    const calls = renderCache({}, (call) => {
      if (isSourceQuery(call.url)) return { json: { rows: [{ id: 2, name: "Bea" }], fields: RESULT.fields } };
      if (call.body === undefined) return { json: { tables: [entry] } };
      return { json: { tableName: "orders", rowCount: 1, replaced: true } };
    });
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("1 rows from App"));
    const refresh = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Refresh");
    fireEvent.click(refresh as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Replaced orders with 1 rows"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "orders",
      ) as HTMLButtonElement,
    );
    expect((document.getElementById("query-cache-table") as HTMLInputElement).value).toBe("orders");
    const query = calls.find((call) => isSourceQuery(call.url));
    expect(query?.body).toMatchObject({ sql: entry.sourceSql, options: { limit: QUERY_CACHE_MAX_ROWS } });
    const write = calls.find((call) => call.url.includes("query-cache") && call.body !== undefined);
    expect(write?.body).not.toHaveProperty("refreshSeconds");
  });

  test("a refresh that writes a new table says how many rows were cached", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    renderCache({}, (call) => {
      if (isSourceQuery(call.url)) return { json: { rows: [{ id: 2 }], fields: RESULT.fields } };
      if (call.body === undefined) return { json: { tables: [entry] } };
      return { json: {} };
    });
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Cached 1 rows as orders"));
  });

  test("tells the user to run the query when the source is not open or is a join", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "gone",
      rowCount: 1,
      cachedAt: "t",
    };
    renderCache({}, () => ({ json: { tables: [entry] } }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("not open here"));
    cleanup();
    renderCache(
      {
        connections: [SOURCE, { id: "cross-db-joins", name: "Cross_DB_Joins", type: "duckdb", createdAt: new Date(0) }],
      },
      () => ({
        json: {
          tables: [{ ...entry, sourceConnectionId: "cross-db-joins", sourceName: "Cross_DB_Joins" }],
        },
      }),
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Run the join again"));
  });

  test("stops a refresh that the source refuses or that is larger than the cache", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    renderCache({}, (call) =>
      isSourceQuery(call.url) ? { ok: false, json: { error: "warehouse off" } } : { json: { tables: [entry] } },
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("warehouse off"));
    cleanup();
    renderCache({}, (call) =>
      isSourceQuery(call.url)
        ? { json: { rows: [{ id: 1 }], pagination: { hasMore: true } } }
        : { json: { tables: [entry] } },
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("10,000"));
  });

  test("a list that is not a list is empty, and closing the panel hides it", async () => {
    renderCache({}, () => ({ json: { tables: "nope" } }));
    const open = document.querySelector("button") as HTMLButtonElement;
    fireEvent.click(open);
    await waitFor(() => expect(document.getElementById("query-cache-table")).not.toBeNull());
    fireEvent.click(open);
    expect(document.getElementById("query-cache-table")).toBeNull();
  });

  test("a refresh whose response is not a result is an error", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    renderCache({}, (call) => (isSourceQuery(call.url) ? { json: { fields: ["id"] } } : { json: { tables: [entry] } }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("The source query failed."));
  });

  test("a thrown fetch is shown as a message", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("offline"));
  });

  test("a thrown value that is not an error still shows", async () => {
    globalThis.fetch = mock(() => Promise.reject("offline")) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The query cache could not be read."));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The rows could not be cached."));
  });

  test("an unreadable cache list is a message", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The query cache could not be read."));
  });

  test("a response that is not JSON is still a message", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (isSourceQuery(target)) return new Response("nope", { status: 500 });
      if (init?.body !== undefined) return new Response("nope", { status: 400 });
      return new Response(JSON.stringify({ tables: [entry] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The rows could not be cached."));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("The source query failed."));
  });

  test("a refresh that throws something other than an error says the source failed", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
    };
    globalThis.fetch = mock(async (url: string) => {
      if (isSourceQuery(String(url))) return Promise.reject("down");
      return new Response(JSON.stringify({ tables: [entry] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Refresh"));
    fireEvent.click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Refresh",
      ) as HTMLButtonElement,
    );
    await waitFor(() => expect(document.body.textContent).toContain("The source query failed."));
  });

  function buttonNamed(text: string, root: ParentNode = document): HTMLButtonElement {
    const found = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim() === text);
    if (found === undefined) throw new Error(`missing button ${text}`);
    return found as HTMLButtonElement;
  }

  test("caching rows leaves the schedule alone", async () => {
    const onCached = mock(() => {});
    const recorded = renderCache({ onCached }, () => ({ json: { tables: [], replaced: false, rowCount: 1 } }));
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.getElementById("query-cache-table")).not.toBeNull());
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("Cached 1 rows as orders"));
    const write = recorded.find((call) => call.body !== undefined);
    expect(write?.body).toMatchObject({ tableName: "orders" });
    expect(write?.body).not.toHaveProperty("refreshSeconds");
    expect(write?.body).not.toHaveProperty("every");
    expect(onCached).toHaveBeenCalled();
  });

  test("saves a daily calendar schedule and fills it from the list", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 4,
      cachedAt: "t",
      refreshSeconds: 24 * 60 * 60,
      refreshMinute: 600,
      refreshStartsOn: "2026-11-20",
    };
    let paused = false;
    const calls = renderCache({}, (call) => {
      if (call.url.includes("/schedule")) {
        const body = call.body as { paused?: boolean };
        if (body.paused === true) paused = true;
        if (body.paused === false) paused = false;
        return { json: { tableName: "orders" } };
      }
      return { json: { tables: [{ ...entry, ...(paused ? { refreshPaused: true } : {}) }] } };
    });
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[aria-label='Saved runs']")).not.toBeNull());
    const runLabel = "orders · Daily at 10:00 AM · Nov 20";
    fireEvent.click(document.querySelector(`[aria-label='Pause ${runLabel}']`) as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("orders is paused."));
    expect(calls.some((call) => (call.body as { paused?: boolean } | undefined)?.paused === true)).toBe(true);
    fireEvent.click(document.querySelector(`[aria-label='Resume ${runLabel} · Paused']`) as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("orders will run again."));
    expect(calls.some((call) => (call.body as { paused?: boolean } | undefined)?.paused === false)).toBe(true);
    fireEvent.click(buttonNamed("orders"));
    await waitFor(() => expect(document.body.textContent).toContain("Save schedule"));
    const start = document.querySelector("[aria-label='Start time']") as HTMLSelectElement;
    expect(start.value).toBe("600");
    fireEvent.change(start, { target: { value: "540" } });
    fireEvent.keyDown(start, { key: "a" });
    fireEvent.click(document.querySelector("[aria-label='Next month']") as HTMLButtonElement);
    fireEvent.click(document.querySelector("[aria-label='Previous month']") as HTMLButtonElement);
    const day = Array.from(document.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-pressed") === "false" && button.getAttribute("aria-label")?.includes(","),
    );
    fireEvent.click(day as HTMLButtonElement);
    window.dispatchEvent(new Event("resize"));
    fireEvent.click(buttonNamed("Save schedule"));
    await waitFor(() => expect(document.body.textContent).toContain("refreshes daily at 9:00 AM"));
    const saved = calls.find((call) => (call.body as { every?: string } | undefined)?.every === "daily");
    expect(saved?.body).toMatchObject({ every: "daily", minuteOfDay: 540, tableName: "orders" });

    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.change(document.querySelector("[aria-label='Schedule interval']") as HTMLSelectElement, {
      target: { value: "hourly" },
    });
    expect(document.querySelector("[aria-label='Start time']")).toBeNull();
    fireEvent.keyDown(document.querySelector("[aria-label='Schedule interval']") as HTMLSelectElement, {
      key: "Enter",
    });
    await waitFor(() => expect(document.body.textContent).toContain("refreshes hourly"));
    expect(calls.some((call) => (call.body as { every?: string } | undefined)?.every === "hourly")).toBe(true);

    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.change(document.querySelector("[aria-label='Schedule interval']") as HTMLSelectElement, {
      target: { value: "off" },
    });
    fireEvent.change(document.querySelector("[aria-label='Schedule interval']") as HTMLSelectElement, {
      target: { value: "weekly" },
    });
    fireEvent.click(buttonNamed("Save schedule"));
    await waitFor(() => expect(document.body.textContent).toContain("refreshes only when you ask"));

    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.click(buttonNamed("Cancel", document.querySelector("[aria-label='Schedule']") as HTMLElement));
    expect(document.body.textContent).not.toContain("Save schedule");
    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.click(document.querySelector("[aria-label='Close schedule']") as HTMLButtonElement);
    expect(document.body.textContent).not.toContain("Save schedule");

    const cancelRun = document.querySelector("[aria-label^='Cancel orders']") as HTMLButtonElement;
    fireEvent.click(cancelRun);
    await waitFor(() =>
      expect(calls.filter((call) => (call.body as { every?: string } | undefined)?.every === "off").length).toBe(2),
    );
    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "" } });
    fireEvent.click(buttonNamed("Save schedule"));
    expect(document.body.textContent).toContain("Enter a table name");
  });

  test("a pause the server refuses is a message", async () => {
    const entry = {
      tableName: "orders",
      sourceName: "App",
      sourceSql: "SELECT 1",
      sourceConnectionId: "c1",
      rowCount: 1,
      cachedAt: "t",
      refreshSeconds: 60 * 60,
    };
    let mode: "text" | "throw" = "text";
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.body !== undefined && String(url).includes("/schedule")) {
        if (mode === "throw") return Promise.reject("offline");
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify({ tables: [entry] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[aria-label='Pause orders · Hourly']")).not.toBeNull());
    fireEvent.click(document.querySelector("[aria-label='Pause orders · Hourly']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The run could not be changed."));
    mode = "throw";
    fireEvent.click(document.querySelector("[aria-label='Pause orders · Hourly']") as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain("The run could not be changed."));
  });

  test("a schedule the server refuses is a message", async () => {
    renderCache({}, (call) =>
      call.url.includes("/schedule")
        ? { json: { error: "Cache the table before scheduling a refresh." }, status: 404 }
        : { json: { tables: [] } },
    );
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.getElementById("query-cache-table")).not.toBeNull());
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.click(buttonNamed("Save schedule"));
    await waitFor(() => expect(document.body.textContent).toContain("Cache the table before scheduling a refresh."));
  });

  test("a schedule answer that is not JSON, or a thrown value, is a message", async () => {
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.body !== undefined && String(url).includes("/schedule")) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<CacheResults result={RESULT} sql="SELECT 1" source={SOURCE} connections={[SOURCE]} />);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(document.getElementById("query-cache-table")).not.toBeNull());
    fireEvent.change(document.getElementById("query-cache-table") as HTMLInputElement, { target: { value: "orders" } });
    fireEvent.click(buttonNamed("Schedule"));
    fireEvent.click(buttonNamed("Save schedule"));
    await waitFor(() => expect(document.body.textContent).toContain("The refresh interval could not be saved."));

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.body !== undefined) return Promise.reject("offline");
      return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    fireEvent.click(buttonNamed("Save schedule"));
    await waitFor(() => expect(document.body.textContent).toContain("The refresh interval could not be saved."));
  });
});
