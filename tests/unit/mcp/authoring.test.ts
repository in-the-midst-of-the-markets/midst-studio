/**
 * The MCP authoring tools: a DuckDB query, a dashboard, its SQL or JavaScript, an interactive
 * filter, and a share link, filed under the token's storage owner.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { CUSTOM_FILTER_SCRIPT } from "@/lib/dashboards/dashboard";
import { ShareError } from "@/lib/dashboards/share-limits";
import type { SharePlan } from "@/lib/dashboards/share-plan";
import type { ShareRecord } from "@/lib/dashboards/share-record";
import { CROSS_DB_JOINS_ID } from "@/lib/saved-join/connection";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { ServerStorageProvider } from "@/lib/storage/types";
import type { DashboardFilter, DatabaseConnection, SavedChartConfig, SavedDashboard, SavedQuery } from "@/lib/types";
import type { McpConnectionContext, McpToolCall } from "@/lib/mcp/context";
import type { ShareDeps } from "@/lib/mcp/tools/authoring";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";

const runShareSource = mock(async () => ({ fields: ["n"], rows: [{ n: 1 }] }));
mock.module("@/lib/dashboards/share-source", () => ({ runShareSource }));

delete process.env.STORAGE_PROVIDER;

const tools = await import("@/lib/mcp/tools/authoring");

const SHARE = "ab".repeat(16);
const NOW = new Date("2026-01-01T00:00:00.000Z");

class Memory {
  readonly data = new Map<string, unknown>();
  throwOnGet: string | null = null;
  throwOnSet: string | null = null;

  async getCollection(_user: string, collection: string): Promise<unknown> {
    if (this.throwOnGet === collection) throw new Error("unreadable");
    return this.data.has(collection) ? this.data.get(collection) : null;
  }

  async setCollection(_user: string, collection: string, value: unknown): Promise<void> {
    if (this.throwOnSet === collection) throw new Error("unwritable");
    this.data.set(collection, value);
  }

  list<T>(collection: string): T[] {
    const value = this.data.get(collection);
    return Array.isArray(value) ? (value as T[]) : [];
  }
}

function provider(memory: Memory): ServerStorageProvider {
  return memory as unknown as ServerStorageProvider;
}

function call(username = "ada", signal?: AbortSignal): McpToolCall {
  return {
    signal: signal ?? new AbortController().signal,
    context: { caller: { username, role: "user" } } as McpConnectionContext,
  };
}

function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

function body(result: ToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function connection(id: string, type: DatabaseConnection["type"] = "postgres"): DatabaseConnection {
  return { id, name: id, type } as DatabaseConnection;
}

function chart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "chart-1",
    token: "c_abc12345",
    name: "Revenue",
    chartType: "bar",
    xAxis: "",
    yAxis: [],
    query: "SELECT region, total FROM sales WHERE region = {{region}}",
    connectionId: "c1",
    createdAt: NOW,
    ...overrides,
  };
}

function board(overrides: Partial<SavedDashboard> = {}): SavedDashboard {
  return {
    id: "dash-1",
    name: "Sales",
    charts: [{ chartId: "chart-1", width: 480, height: 320 }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function query(overrides: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: "query-1",
    name: "Orders",
    tableId: "orders",
    query: "SELECT 1",
    connectionType: "duckdb",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seed(
  memory: Memory,
  lists: {
    queries?: SavedQuery[];
    charts?: SavedChartConfig[];
    dashboards?: SavedDashboard[];
    connections?: DatabaseConnection[];
  },
): void {
  if (lists.queries !== undefined) memory.data.set("saved_queries", lists.queries);
  if (lists.charts !== undefined) memory.data.set("saved_charts", lists.charts);
  if (lists.dashboards !== undefined) memory.data.set("saved_dashboards", lists.dashboards);
  if (lists.connections !== undefined) memory.data.set("connections", lists.connections);
}

describe("write_duckdb_query", () => {
  test("saves a read and derives a table id", async () => {
    const memory = new Memory();
    const result = await tools.writeDuckdbQuery(
      { name: "Monthly Active Users", sql: "SELECT 1" },
      call(),
      provider(memory),
    );
    expect(result.isError).toBeUndefined();
    expect(body(result).table_id).toBe("Monthly_Active_Users");
    expect(body(result).connection_type).toBe("duckdb");
    expect(memory.list<SavedQuery>("saved_queries")[0]?.query).toBe("SELECT 1");
  });

  test("uses a requested id, replaces a DuckDB query, and keeps its connection", async () => {
    const memory = new Memory();
    seed(memory, {
      queries: [query({ connectionId: "file" }), query({ id: "other", tableId: undefined, name: "Bare" })],
    });
    const result = await tools.writeDuckdbQuery(
      { name: "Orders", sql: "SELECT 2", query_id: "query-1", table_id: "orders" },
      call(),
      provider(memory),
    );
    expect(body(result).query_id).toBe("query-1");
    expect(body(result).table_id).toBe("orders");
    const saved = memory.list<SavedQuery>("saved_queries").find((item) => item.id === "query-1");
    expect(saved?.query).toBe("SELECT 2");
    expect(saved?.connectionId).toBe("file");
  });

  test("mints an id when the name cannot be a table or the derived id is taken", async () => {
    const memory = new Memory();
    seed(memory, { queries: [query({ tableId: "orders" })] });
    const minted = await tools.writeDuckdbQuery({ name: "123", sql: "SELECT 1" }, call(), provider(memory));
    expect(String(body(minted).table_id)).toStartWith("q_");
    const taken = await tools.writeDuckdbQuery({ name: "Orders", sql: "SELECT 1" }, call(), provider(memory));
    expect(String(body(taken).table_id)).toStartWith("q_");
  });

  test("refuses a missing query, a query that is not DuckDB, a taken id, and a bad id", async () => {
    const memory = new Memory();
    seed(memory, { queries: [query(), query({ id: "pg", connectionType: "postgres", tableId: "people" })] });
    const store = provider(memory);
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1", query_id: "missing" }, call(), store)),
    ).toContain("not on this account");
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1", query_id: "pg" }, call(), store))).toContain(
      "not a DuckDB query",
    );
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1", table_id: "orders" }, call(), store)),
    ).toContain("already a saved query");
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1", table_id: "1bad" }, call(), store)),
    ).toContain("letter or underscore");
  });

  test("refuses a write, a second statement, a file read, and an executed comment", async () => {
    const memory = new Memory();
    const store = provider(memory);
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "DELETE FROM t" }, call(), store))).toContain(
      "has to be a read",
    );
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1; SELECT 2" }, call(), store))).toContain(
      "one statement",
    );
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT read_csv('secret.csv')" }, call(), store)),
    ).toContain("READ_CSV");
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1 /*! DELETE FROM t */" }, call(), store)),
    ).toContain("comment the database executes");
    expect(memory.list("saved_queries")).toHaveLength(0);
  });

  test("refuses when the account cannot be stored", async () => {
    const memory = new Memory();
    memory.throwOnSet = "saved_queries";
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call(), provider(memory)))).toContain(
      "could not be read",
    );
  });
});

describe("the account gate", () => {
  test("refuses a cancelled call, server storage that is off, a reserved username, a bad collection, and a read that throws", async () => {
    const memory = new Memory();
    const store = provider(memory);
    expect(
      text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call("ada", AbortSignal.abort()), store)),
    ).toBe(MCP_CANCELLED_TEXT);
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call(), null))).toContain(
      "STORAGE_PROVIDER",
    );
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call("sub:ada"), store))).toContain(
      "sub:",
    );
    memory.data.set("saved_charts", { not: "a list" });
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call(), store))).toContain(
      "could not be read",
    );
    memory.throwOnGet = "saved_queries";
    expect(text(await tools.writeDuckdbQuery({ name: "A", sql: "SELECT 1" }, call(), store))).toContain(
      "could not be read",
    );
  });
});

describe("create_dashboard", () => {
  test("places a chart and a JavaScript note", async () => {
    const memory = new Memory();
    seed(memory, { connections: [connection("c1")] });
    const result = await tools.createDashboard(
      {
        name: "Sales",
        sql: "SELECT 1",
        chart_name: "Revenue",
        connection_id: "c1",
        note_text: "Hello",
        note_script: "setValue(1)",
        note_sql: "SELECT 2",
      },
      call(),
      provider(memory),
    );
    expect(result.isError).toBeUndefined();
    expect(body(result).chart_id).toEqual(expect.any(String));
    expect(body(result).note_id).toEqual(expect.any(String));
    const dashboard = memory.list<SavedDashboard>("saved_dashboards")[0];
    expect(dashboard?.charts).toHaveLength(1);
    expect(dashboard?.notes?.[0]?.script).toBe("setValue(1)");
    expect(dashboard?.notes?.[0]?.connectionId).toBe("c1");
    expect(memory.list<SavedChartConfig>("saved_charts")[0]?.name).toBe("Revenue");
  });

  test("creates an empty board, a note with only text, and a chart with no connection", async () => {
    const memory = new Memory();
    const store = provider(memory);
    const empty = await tools.createDashboard({ name: "Empty" }, call(), store);
    expect(body(empty).chart_id).toBeNull();
    expect(body(empty).note_id).toBeNull();
    const note = await tools.createDashboard({ name: "Noted", note_text: "Only text" }, call(), store);
    expect(body(note).note_id).toEqual(expect.any(String));
    const chartOnly = await tools.createDashboard({ name: "Joined", sql: "SELECT 1" }, call(), store);
    expect(memory.list<SavedChartConfig>("saved_charts").at(-1)?.connectionId).toBeUndefined();
    expect(body(chartOnly).chart_id).toEqual(expect.any(String));
  });

  test("refuses a write in the chart and in the note, including a MySQL executed comment", async () => {
    const memory = new Memory();
    seed(memory, { connections: [connection("c1", "mysql")] });
    const store = provider(memory);
    expect(
      text(await tools.createDashboard({ name: "A", sql: "DELETE FROM t", connection_id: "c1" }, call(), store)),
    ).toContain("has to be a read");
    expect(
      text(
        await tools.createDashboard(
          { name: "A", note_sql: "SELECT 1 /*! DELETE FROM t */", connection_id: "c1" },
          call(),
          store,
        ),
      ),
    ).toContain("comment the database executes");
    expect(memory.list("saved_dashboards")).toHaveLength(0);
    seed(memory, { connections: [connection("cache", "redis")] });
    expect(
      text(await tools.createDashboard({ name: "A", sql: "GET a\nGET b", connection_id: "cache" }, call(), store)),
    ).toContain("second command");
  });

  test("refuses when the chart list or the dashboard list cannot be stored", async () => {
    const charts = new Memory();
    charts.throwOnSet = "saved_charts";
    expect(text(await tools.createDashboard({ name: "A" }, call(), provider(charts)))).toContain("could not be read");
    const boards = new Memory();
    boards.throwOnSet = "saved_dashboards";
    expect(text(await tools.createDashboard({ name: "A" }, call(), provider(boards)))).toContain("could not be read");
  });

  test("treats a blank or unknown connection id as DuckDB", async () => {
    const memory = new Memory();
    const store = provider(memory);
    const blank = await tools.createDashboard({ name: "A", sql: "SELECT 1", connection_id: "" }, call(), store);
    expect(blank.isError).toBeUndefined();
    const unknown = await tools.createDashboard(
      { name: "B", sql: "SELECT 1", connection_id: "missing" },
      call(),
      store,
    );
    expect(unknown.isError).toBeUndefined();
    const joined = await tools.createDashboard(
      { name: "C", sql: "SELECT 1", connection_id: CROSS_DB_JOINS_ID },
      call(),
      store,
    );
    expect(joined.isError).toBeUndefined();
    seed(memory, { connections: [connection("cache", "redis")] });
    const redis = await tools.createDashboard({ name: "Keys", sql: "GET a", connection_id: "cache" }, call(), store);
    expect(redis.isError).toBeUndefined();
  });
});

describe("edit_dashboard_code", () => {
  test("replaces chart SQL, note JavaScript, and a filter script", async () => {
    const memory = new Memory();
    const note = { id: "note-1", text: "Hi" };
    const filter: DashboardFilter = {
      id: "filter-1",
      name: "region",
      query: "SELECT region FROM sales",
      value: "",
      control: "select",
    };
    seed(memory, {
      charts: [chart({ query: "SELECT 1" })],
      dashboards: [board({ notes: [note], filters: [filter] })],
      connections: [connection("c1")],
    });
    const store = provider(memory);
    const edited = await tools.editDashboardCode(
      { dashboard_id: "dash-1", kind: "chart", id: "chart-1", sql: "SELECT 2" },
      call(),
      store,
    );
    expect(body(edited).kind).toBe("chart");
    expect(memory.list<SavedChartConfig>("saved_charts")[0]?.query).toBe("SELECT 2");
    const noted = await tools.editDashboardCode(
      { dashboard_id: "dash-1", kind: "note", id: "note-1", script: "setValue(1)" },
      call(),
      store,
    );
    expect(body(noted).kind).toBe("note");
    const filtered = await tools.editDashboardCode(
      { dashboard_id: "dash-1", kind: "filter", id: "filter-1", script: "setValue(value)" },
      call(),
      store,
    );
    expect(memory.list<SavedDashboard>("saved_dashboards")[0]?.filters?.[0]?.control).toBe("custom");
    expect(body(filtered).id).toBe("filter-1");
  });

  test("replaces a note query and a filter query", async () => {
    const memory = new Memory();
    seed(memory, {
      charts: [chart()],
      dashboards: [
        board({
          notes: [{ id: "note-1", text: "", query: "SELECT 1", connectionId: "c1" }],
          filters: [{ id: "filter-1", name: "region", query: "SELECT 1", value: "", connectionId: "c1" }],
        }),
      ],
      connections: [connection("c1")],
    });
    const store = provider(memory);
    expect(
      (
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "note", id: "note-1", sql: "SELECT 2" },
          call(),
          store,
        )
      ).isError,
    ).toBeUndefined();
    expect(
      (
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "filter", id: "filter-1", sql: "SELECT 3" },
          call(),
          store,
        )
      ).isError,
    ).toBeUndefined();
    const dashboard = memory.list<SavedDashboard>("saved_dashboards")[0];
    expect(dashboard?.notes?.[0]?.query).toBe("SELECT 2");
    expect(dashboard?.filters?.[0]?.query).toBe("SELECT 3");
  });

  test("refuses a chart script, a missing piece, SQL that is not a read, and an empty chart query", async () => {
    const memory = new Memory();
    seed(memory, {
      charts: [
        chart({ id: "loose", query: undefined, connectionId: undefined }),
        chart({ id: "blank", query: undefined, connectionId: undefined }),
        chart({ query: "SELECT 1" }),
      ],
      dashboards: [
        board({
          charts: [
            { chartId: "chart-1", width: 1, height: 1 },
            { chartId: "blank", width: 1, height: 1 },
          ],
        }),
      ],
      connections: [connection("c1")],
    });
    const store = provider(memory);
    const who = call();
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "missing", kind: "chart", id: "chart-1", sql: "SELECT 1" },
          who,
          store,
        ),
      ),
    ).toContain("dashboard is not");
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "chart", id: "chart-1", script: "x" },
          who,
          store,
        ),
      ),
    ).toContain("not JavaScript");
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "chart", id: "loose", sql: "SELECT 1" },
          who,
          store,
        ),
      ),
    ).toContain("not on this dashboard");
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "chart", id: "chart-1", sql: "DELETE FROM t" },
          who,
          store,
        ),
      ),
    ).toContain("has to be a read");
    expect(
      text(await tools.editDashboardCode({ dashboard_id: "dash-1", kind: "chart", id: "loose" }, who, store)),
    ).toContain("not on this dashboard");
    expect(
      text(await tools.editDashboardCode({ dashboard_id: "dash-1", kind: "chart", id: "blank" }, who, store)),
    ).toContain("has to be a read");
    expect(
      text(
        await tools.editDashboardCode({ dashboard_id: "dash-1", kind: "note", id: "note-1", script: "x" }, who, store),
      ),
    ).toContain("note is not");
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "filter", id: "filter-1", script: "x" },
          who,
          store,
        ),
      ),
    ).toContain("filter is not");
  });

  test("refuses a note or filter write", async () => {
    const memory = new Memory();
    seed(memory, {
      charts: [chart()],
      dashboards: [
        board({
          notes: [{ id: "note-1", text: "", connectionId: "c1" }],
          filters: [{ id: "filter-1", name: "region", query: "SELECT 1", value: "", connectionId: "c1" }],
        }),
      ],
      connections: [connection("c1")],
    });
    const store = provider(memory);
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "note", id: "note-1", sql: "DELETE FROM t" },
          call(),
          store,
        ),
      ),
    ).toContain("has to be a read");
    expect(
      text(
        await tools.editDashboardCode(
          { dashboard_id: "dash-1", kind: "filter", id: "filter-1", sql: "DELETE FROM t" },
          call(),
          store,
        ),
      ),
    ).toContain("has to be a read");
  });
});

describe("create_dashboard_filter", () => {
  test("adds a select, a value list, a slider, and a custom filter", async () => {
    const memory = new Memory();
    seed(memory, { dashboards: [board({ charts: [] })], connections: [connection("c1")] });
    const store = provider(memory);
    const select = await tools.createDashboardFilter(
      {
        dashboard_id: "dash-1",
        name: "region",
        label: "Region",
        query: "SELECT region FROM sales",
        connection_id: "c1",
        value: "east",
      },
      call(),
      store,
    );
    expect(body(select).token).toBe("{{region}}");
    const values = await tools.createDashboardFilter(
      { dashboard_id: "dash-1", name: "kind", values: "a\nb", control: "select" },
      call(),
      store,
    );
    expect(body(values).name).toBe("kind");
    const slider = await tools.createDashboardFilter(
      { dashboard_id: "dash-1", name: "limit", control: "slider", min: 0, max: 10, step: 1 },
      call(),
      store,
    );
    expect(body(slider).token).toBe("{{limit}}");
    const custom = await tools.createDashboardFilter(
      { dashboard_id: "dash-1", name: "pick", control: "custom" },
      call(),
      store,
    );
    const scripted = await tools.createDashboardFilter(
      { dashboard_id: "dash-1", name: "drawn", script: "setValue(value)" },
      call(),
      store,
    );
    const filters = memory.list<SavedDashboard>("saved_dashboards")[0]?.filters ?? [];
    expect(filters.find((item) => item.name === "kind")?.choiceSource).toBe("values");
    expect(filters.find((item) => item.name === "limit")?.step).toBe(1);
    expect(filters.find((item) => item.name === "pick")?.script).toBe(CUSTOM_FILTER_SCRIPT);
    expect(filters.find((item) => item.name === "drawn")?.control).toBe("custom");
    expect(body(custom).filter_id).toEqual(expect.any(String));
    expect(body(scripted).name).toBe("drawn");
  });

  test("refuses a missing dashboard, a hyphenated name, a duplicate, and a write", async () => {
    const memory = new Memory();
    seed(memory, {
      dashboards: [board({ charts: [], filters: [{ id: "id_1", name: "region", query: "", value: "" }] })],
      connections: [connection("c1")],
    });
    const store = provider(memory);
    expect(
      text(await tools.createDashboardFilter({ dashboard_id: "missing", name: "region" }, call(), store)),
    ).toContain("dashboard is not");
    expect(
      text(await tools.createDashboardFilter({ dashboard_id: "dash-1", name: "Test-Dim" }, call(), store)),
    ).toContain("letter or underscore");
    expect(
      text(await tools.createDashboardFilter({ dashboard_id: "dash-1", name: "region" }, call(), store)),
    ).toContain("already has a filter");
    expect(
      text(
        await tools.createDashboardFilter(
          { dashboard_id: "dash-1", name: "other", query: "DELETE FROM t", connection_id: "c1" },
          call(),
          store,
        ),
      ),
    ).toContain("has to be a read");
  });
});

describe("share_dashboard", () => {
  function deps(overrides: Partial<ShareDeps> = {}): ShareDeps {
    return tools.shareDependencies({
      resolve: async (body) =>
        connection(body.connectionId ?? body.connection?.id ?? "c1", body.connection?.type ?? "postgres"),
      runSource: async () => ({ fields: ["total"], rows: [{ total: 1 }] }),
      writeTables: async () => {},
      writeRecord: () => {},
      readRecord: () => null,
      newId: () => SHARE,
      mcpUrl: () => ({ ok: true, value: "https://studio.example/api/mcp" }),
      ...overrides,
    });
  }

  test("copies a chart, bakes a filter the columns cannot answer, and reuses an owned link", async () => {
    const memory = new Memory();
    const saved = chart({ refreshSeconds: 60 });
    seed(memory, {
      charts: [saved],
      connections: [connection("c1")],
      dashboards: [
        board({
          shareId: SHARE,
          filters: [
            { id: "filter-1", name: "region", query: "", value: "east", control: "select" },
            { id: "filter-2", name: "kind", query: "SELECT 1", value: "", choiceSource: "values", connectionId: "c1" },
          ],
          notes: [{ id: "note-1", text: "", query: "SELECT 1", connectionId: "c1" }],
        }),
      ],
    });
    let published: ShareRecord | undefined;
    let runs = 0;
    const result = await tools.shareDashboard(
      { dashboard_id: "dash-1" },
      call(),
      provider(memory),
      deps({
        readRecord: () => ({ ownerKey: "ada", createdAt: "2020-01-01T00:00:00.000Z" }) as ShareRecord,
        writeRecord: (record) => {
          published = record;
        },
        runSource: async () => {
          runs += 1;
          return { fields: ["total"], rows: [{ total: 1 }] };
        },
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(body(result).url).toBe(`https://studio.example/share/${SHARE}`);
    expect(body(result).frozen).toEqual(expect.any(Array));
    expect(published?.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(published?.refreshSeconds).toBe(60);
    expect(runs).toBeGreaterThan(1);
    expect(memory.list<SavedDashboard>("saved_dashboards")[0]?.shareId).toBe(SHARE);
  });

  test("mints a link when the dashboard has none or the old record is gone", async () => {
    const memory = new Memory();
    seed(memory, { dashboards: [board({ charts: [], name: "   " })], charts: [] });
    const first = await tools.shareDashboard({ dashboard_id: "dash-1" }, call(), provider(memory), deps());
    expect(body(first).share_id).toBe(SHARE);
    expect(body(first).url).toContain("/share/");
    seed(memory, { dashboards: [board({ charts: [], shareId: "gone" })] });
    let minted = "";
    const second = await tools.shareDashboard(
      { dashboard_id: "dash-1" },
      call(),
      provider(memory),
      deps({
        readRecord: () => null,
        newId: () => {
          minted = "cd".repeat(16);
          return minted;
        },
      }),
    );
    expect(body(second).share_id).toBe(minted);
  });

  test("resolves a seed connection and refuses a missing one in either voice", async () => {
    const memory = new Memory();
    seed(memory, {
      charts: [chart({ connectionId: "seed:shop", query: "SELECT 1" })],
      dashboards: [board()],
    });
    let sawSeed = false;
    const shared = await tools.shareDashboard(
      { dashboard_id: "dash-1" },
      call(),
      provider(memory),
      deps({
        resolve: async (body) => {
          sawSeed = body.connectionId === "seed:shop";
          return connection("seed:shop", "sqlite");
        },
        runSource: async () => ({ fields: ["n"], rows: [] }),
      }),
    );
    expect(sawSeed).toBe(true);
    expect(shared.isError).toBeUndefined();

    seed(memory, {
      charts: [chart({ connectionId: "gone", query: "SELECT 1" })],
      dashboards: [board()],
      connections: [],
    });
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            resolve: async () => {
              throw new Error("nope");
            },
          }),
        ),
      ),
    ).toContain("not available to this token");
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            resolve: async () => {
              throw new SeedConnectionError("The seed file has no such connection.", 404);
            },
          }),
        ),
      ),
    ).toContain("seed file");
  });

  test("refuses a plan that cannot be shared, a link owned by someone else, and a source whose connection was not resolved", async () => {
    const memory = new Memory();
    seed(memory, { dashboards: [board()], charts: [] });
    expect(text(await tools.shareDashboard({ dashboard_id: "dash-1" }, call(), provider(memory), deps()))).toContain(
      "no longer saved",
    );
    seed(memory, {
      charts: [chart({ query: "SELECT 1", connectionId: undefined })],
      dashboards: [board()],
    });
    expect(text(await tools.shareDashboard({ dashboard_id: "dash-1" }, call(), provider(memory), deps()))).toContain(
      "no connection",
    );
    seed(memory, {
      charts: [chart({ query: "SELECT 1", connectionId: CROSS_DB_JOINS_ID })],
      dashboards: [board()],
      connections: [connection(CROSS_DB_JOINS_ID, "duckdb")],
    });
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            resolve: async () => connection(CROSS_DB_JOINS_ID, "duckdb"),
          }),
        ),
      ),
    ).toContain("Cross_DB_Joins");

    seed(memory, { dashboards: [board({ charts: [], shareId: SHARE })] });
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            readRecord: () => ({ ownerKey: "someone-else", createdAt: "2020-01-01T00:00:00.000Z" }) as ShareRecord,
          }),
        ),
      ),
    ).toContain("another account");

    const stray: SharePlan = {
      dashboard: board({ charts: [] }),
      charts: [],
      sources: [
        {
          table: "c_abc12345",
          connectionId: "missing",
          label: "Chart",
          openedSql: "SELECT 1",
          bakedSql: "SELECT 1",
          interactive: [],
        },
      ],
      frozen: [],
    };
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            plan: () => stray,
            readRecord: () => null,
          }),
        ),
      ),
    ).toContain("not available to this token");
    expect(text(await tools.shareDashboard({ dashboard_id: "missing" }, call(), provider(memory), deps()))).toContain(
      "dashboard is not",
    );
  });

  test("reports a snapshot failure, a missing public address, and a store that rejects the saved link", async () => {
    const memory = new Memory();
    seed(memory, {
      dashboards: [
        board({ charts: [], filters: [{ id: "v", name: "search", query: "", value: "", control: "vector" }] }),
      ],
    });
    const vector = await tools.shareDashboard({ dashboard_id: "dash-1" }, call(), provider(memory), deps());
    expect(JSON.stringify(body(vector).frozen)).toContain("vector");

    seed(memory, { dashboards: [board({ charts: [] })] });
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            writeTables: async () => {
              throw new ShareError("That chart returned more than 10,000 rows.");
            },
          }),
        ),
      ),
    ).toContain("10,000");
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            writeTables: async () => {
              throw new Error("disk");
            },
          }),
        ),
      ),
    ).toContain("could not be shared");
    expect(
      text(
        await tools.shareDashboard(
          { dashboard_id: "dash-1" },
          call(),
          provider(memory),
          deps({
            mcpUrl: () => ({ ok: false, problem: "MCP has no public address." }),
          }),
        ),
      ),
    ).toContain("public address");
    memory.throwOnSet = "saved_dashboards";
    expect(text(await tools.shareDashboard({ dashboard_id: "dash-1" }, call(), provider(memory), deps()))).toContain(
      "could not be read",
    );
  });

  test("the registered helpers call the share runner", async () => {
    const defaults = tools.shareDependencies();
    await defaults.runSource(
      { username: "ada", role: "user" },
      connection("c1"),
      "SELECT 1",
      "Chart",
      AbortSignal.timeout(1000),
    );
    expect(runShareSource).toHaveBeenCalled();
  });
});

describe("registration", () => {
  const registered: {
    name: string;
    annotations: unknown;
    handler: (args: Record<string, unknown>, ctx: { mcpReq: { signal: AbortSignal } }) => Promise<ToolResult>;
  }[] = [];

  beforeAll(() => {
    const server = {
      registerTool(name: string, config: { annotations?: unknown }, handler: (typeof registered)[number]["handler"]) {
        registered.push({ name, annotations: config.annotations, handler });
      },
    };
    tools.registerAuthoringTools(
      server as unknown as McpServer,
      { caller: { username: "ada", role: "user" } } as McpConnectionContext,
    );
  });

  test("registers the five tools as closed-world writes", () => {
    expect(registered.map((item) => item.name)).toEqual([...tools.AUTHORING_TOOLS]);
    for (const item of registered) expect(item.annotations).toEqual({ readOnlyHint: false, openWorldHint: false });
  });

  test("each registered tool refuses a cancelled call and a server with storage off", async () => {
    const cancelled = await Promise.all(
      registered.map((item) => item.handler({}, { mcpReq: { signal: AbortSignal.abort() } })),
    );
    const stored = await Promise.all(
      registered.map((item) => item.handler({}, { mcpReq: { signal: new AbortController().signal } })),
    );
    for (const result of cancelled) expect(text(result)).toBe(MCP_CANCELLED_TEXT);
    for (const result of stored) expect(text(result)).toContain("STORAGE_PROVIDER");
  });
});
