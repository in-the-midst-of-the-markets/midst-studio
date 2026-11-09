import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import { NotionProvider, notionApiHost, notionToken } from "@/lib/db/providers/sql/notion";
import type { DatabaseConnection } from "@/lib/types";

const TOKEN = "ntn_notiontoken";

const connection = {
  id: "notion",
  name: "notion",
  type: "notion",
  host: "api.notion.com",
  password: TOKEN,
  createdAt: new Date(0),
} as DatabaseConnection;

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: { url: string; method: string; body: string }[];
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string; body: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, body: request.body ?? "" });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? JSON.stringify(next.body ?? {});
        return { status: next.status ?? 200, contentType: "application/json", retryAfter: null, text };
      },
      close() {
        state.closed += 1;
      },
    };
  };
  return {
    createTransport,
    requests,
    get options() {
      return state.options;
    },
    get closed() {
      return state.closed;
    },
  };
}

function source(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    object: "data_source",
    id,
    title: [{ plain_text: title }],
    properties: {
      Name: { type: "title" },
      Estimate: { type: "number" },
      ID: { type: "unique_id" },
      Done: { type: "checkbox" },
      Due: { type: "date" },
      Created: { type: "created_time" },
      Edited: { type: "last_edited_time" },
      constructor: { type: "rich_text" },
      Skip: { type: "" },
      ...extra,
    },
    ...extra,
  };
}

function search(results: unknown[], more?: string) {
  return { results, has_more: more !== undefined, next_cursor: more ?? null };
}

const PAGE_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function page(name: string) {
  return {
    object: "page",
    id: PAGE_ID,
    properties: { Name: { type: "title", title: [{ plain_text: name }] } },
  };
}

describe("NotionProvider", () => {
  test("requires a token and accepts only api.notion.com", () => {
    expect(() => new NotionProvider(connection)).not.toThrow();
    expect(() => new NotionProvider({ ...connection, host: "", password: "census" })).not.toThrow();
    expect(() => new NotionProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    expect(notionApiHost({ ...connection, host: " https://API.notion.com/v1 " })).toBe("api.notion.com");
    expect(notionApiHost({ ...connection, host: "" })).toBe("api.notion.com");
    const injected = `${TOKEN}\r\nX-Injected: 1`;
    try {
      notionToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain(TOKEN);
    }
    expect(() => notionToken({ ...connection, password: "x".repeat(1018) })).toThrow(/single line/);
    expect(notionToken({ ...connection, password: "x".repeat(1017) })).toHaveLength(1017);
    for (const host of [
      "evil.example",
      "https://user:secret@api.notion.com",
      "files.notion.com",
    ]) {
      expect(() => notionApiHost({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        notionApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain("secret");
        expect(message).not.toContain(host);
      }
    }
  });

  test("lists shared databases and reads one SELECT", async () => {
    const wire = scripted([
      {
        body: search([
          source(SOURCE_ID, "Tasks"),
          source("cccccccc-cccc-cccc-cccc-cccccccccccc", ""),
          {
            object: "data_source",
            id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            title: [],
            in_trash: true,
            properties: {},
          },
          { object: "page", id: "not-a-source" },
          { object: "data_source" },
        ]),
      },
      { body: { results: [page("Alpha"), { object: "data_source", id: "skip" }], has_more: false } },
      { body: { results: [page("Alpha")], has_more: false } },
    ]);
    const provider = new NotionProvider(connection, {}, wire.createTransport);
    expect(provider.getCapabilities().supportsResultPagination).toBe(true);
    expect(provider.getCapabilities().identifierQuoting).toBe("double");
    expect(provider.getLabels().entityName).toBe("Database");
    await provider.connect();
    await provider.connect();
    expect(wire.requests).toHaveLength(1);
    expect(wire.options?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(wire.options?.headers?.["Notion-Version"]).toBe("2026-03-11");
    expect(wire.options?.refusesLinkLocal).toBe(true);
    const containers = await provider.listContainers();
    expect(containers).toEqual([{ path: ["workspace"], name: "workspace", level: 0 }]);
    expect(await provider.listContainers(["workspace"])).toEqual([]);
    expect(await provider.countObjects(["workspace"])).toEqual({ table: { count: 2 } });
    const objects = await provider.listObjects(["workspace"], "table");
    expect(objects.map((object) => object.name)).toEqual(["Tasks", "cccccccc-cccc-cccc-cccc-cccccccccccc"]);
    const detail = await provider.describeObject(["workspace", "tasks"], "table");
    expect(detail.columns.map((column) => column.name)).toContain("_id");
    expect(detail.columns.find((column) => column.name === "Estimate")?.type).toBe("double");
    expect(detail.columns.find((column) => column.name === "ID")?.type).toBe("bigint");
    expect(detail.columns.find((column) => column.name === "Done")?.type).toBe("boolean");
    expect(detail.columns.find((column) => column.name === "Due")?.type).toBe("timestamptz");
    expect(detail.columns.find((column) => column.name === "Created")?.type).toBe("timestamptz");
    expect(detail.columns.map((column) => column.name)).not.toContain("constructor");
    const batch = await provider.describeObjects(["workspace"], "table", 1);
    expect(batch.details).toHaveLength(1);
    const result = await provider.query("SELECT Name FROM Tasks WHERE Name = 'Alpha' ORDER BY Name LIMIT 10");
    expect(result.fields).toEqual(["Name"]);
    expect(result.rows).toEqual([{ Name: "Alpha" }]);
    const counted = await provider.query("SELECT COUNT(*) FROM Tasks");
    expect(counted.rows).toEqual([{ count: 1 }]);
    expect(counted.fields).toEqual(["count"]);
    const sent = JSON.parse(wire.requests[1]?.body ?? "{}") as { filter: unknown; sorts: unknown; page_size: number };
    expect(sent.page_size).toBe(10);
    expect(sent.filter).toEqual({ property: "Name", title: { equals: "Alpha" } });
    expect(sent.sorts).toEqual([{ property: "Name", direction: "ascending" }]);
    expect(wire.requests[1]?.url).toContain(encodeURIComponent(SOURCE_ID));
    expect(await provider.getOverview()).toMatchObject({ tableCount: 2, version: "Notion 2026-03-11" });
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await expect(provider.runMaintenance()).rejects.toThrow(/maintenance/);
    await provider.disconnect();
    expect(wire.closed).toBe(1);
    await expect(provider.query("SELECT * FROM Tasks")).rejects.toThrow(/Not connected/);
  });

  test("pages the catalog and the query, and caps a read at 1000 rows", async () => {
    const first = Array.from({ length: 100 }, (_, index) => source(`id-${index}`, `Db ${index}`));
    const wire = scripted([
      { body: search(first, "cursor-1") },
      { body: search([source(SOURCE_ID, "Last"), source("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Last")]) },
      { body: { results: [page("One")], has_more: true, next_cursor: "page-2" } },
      { body: { results: [page("Two")], has_more: true, next_cursor: "" } },
    ]);
    const provider = new NotionProvider({ ...connection, host: undefined }, {}, wire.createTransport);
    await provider.connect();
    expect((await provider.listObjects(["workspace"], "table")).map((object) => object.name)).toEqual([
      ...first.map((item) => item.title[0]?.plain_text),
      "Last (aaaaaaaa)",
      "Last (bbbbbbbb)",
    ]);
    const wide = await provider.query('SELECT * FROM "Last (aaaaaaaa)" LIMIT 5000');
    expect(wide.warnings?.[0]?.message).toContain("1000");
    expect(wide.rows).toHaveLength(2);
    expect(wide.rows[0]).toMatchObject({ _id: PAGE_ID, Name: "One" });
    expect(wire.requests).toHaveLength(4);
  });

  test("stops walking the catalog at 1000 data sources", async () => {
    const pages = Array.from({ length: 10 }, (_, page) => ({
      body: search(
        Array.from({ length: 100 }, (_, index) => source(`p${page}-${index}`, `N ${page}-${index}`)),
        "next",
      ),
    }));
    const wire = scripted(pages);
    const provider = new NotionProvider(connection, {}, wire.createTransport);
    await provider.connect();
    expect(await provider.countObjects(["workspace"])).toEqual({ table: { count: 1000 } });
    expect(wire.requests).toHaveLength(10);
  });

  test("warns when an OFFSET passes the row cap and when a page is not a page", async () => {
    const wire = scripted([{ body: search([source(SOURCE_ID, "Tasks")]) }]);
    const provider = new NotionProvider(connection, {}, wire.createTransport);
    await provider.connect();
    const skipped = await provider.query("SELECT * FROM Tasks OFFSET 1000");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("OFFSET");
    expect(wire.requests).toHaveLength(1);
    await expect(provider.query("SELECT Missing FROM Tasks")).rejects.toThrow(/no property/);
    await expect(provider.query("SELECT * FROM Missing", ["x"])).rejects.toThrow(/parameters/);
    await expect(provider.query("SELECT * FROM Nowhere")).rejects.toThrow(/no database/);
    await expect(provider.listObjects(["workspace"], "view")).rejects.toThrow(/object kind/);
    await expect(provider.describeObjects(["workspace"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(provider.listObjects(["workspace", "extra"], "table")).rejects.toThrow(QueryError);
  });

  test("turns Notion and transport failures into query errors that hide the token", async () => {
    const cases: ScriptedPage[] = [
      { status: 401, body: { message: `bad ${TOKEN}` } },
      { status: 403, body: {} },
      { status: 429, body: {} },
      { status: 302, text: "" },
      { status: 400, body: { message: `token ${TOKEN} leaked` } },
      { status: 400, body: {} },
      { status: 200, text: "not-json" },
      { status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) },
      { status: 200, body: { object: "error", message: `still ${TOKEN}` } },
      { status: 200, body: { results: "nope" } },
      { throw: new TransportError("redirect", "go") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${TOKEN}`) },
      { throw: new DatabaseConfigError("kept", "notion") },
      { throw: "plain" },
    ];
    for (const failure of cases) {
      const wire = scripted([failure]);
      const provider = new NotionProvider(connection, {}, wire.createTransport);
      try {
        await provider.connect();
        throw new Error("connect should have failed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(TOKEN);
        if (failure.status === 401) expect(error).toBeInstanceOf(AuthenticationError);
        if (failure.status === 403) expect(error).toBeInstanceOf(PermissionDeniedError);
        if (failure.status === 429) expect(error).toBeInstanceOf(QueryError);
        if (failure.throw instanceof DatabaseConfigError) expect(error).toBeInstanceOf(DatabaseConfigError);
      }
      expect(wire.closed).toBe(1);
    }
  });

  test("reports a bad query page after the catalog loaded", async () => {
    const wire = scripted([{ body: search([source(SOURCE_ID, "Tasks")]) }, { body: { has_more: true } }]);
    const provider = new NotionProvider(connection, {}, wire.createTransport);
    await provider.connect();
    await expect(provider.query("SELECT * FROM Tasks")).rejects.toThrow(/not a list of pages/);
  });
});
