import { describe, expect, test } from "bun:test";
import { isPublicShareRequest, isShareId } from "@/lib/dashboards/share-access";
import {
  planDashboardShare,
  shareRefreshSeconds,
  snapshotQuery,
  sourceForFields,
  withSnapshotQueries,
  type ShareSourcePlan,
} from "@/lib/dashboards/share-plan";
import { readSharePublish, readShareQuery } from "@/lib/dashboards/share-request";
import type { DatabaseConnection, SavedChartConfig, SavedDashboard } from "@/lib/types";

const ID = "ab".repeat(16);

function board(overrides: Partial<SavedDashboard> = {}): SavedDashboard {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "dash",
    name: "Sales",
    charts: [{ chartId: "revenue", width: 480, height: 320 }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function chart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "revenue",
    token: "c_abc12345",
    name: "Revenue",
    chartType: "bar",
    xAxis: "region",
    yAxis: ["total"],
    query: "SELECT region, total FROM sales",
    connectionId: "c1",
    typeId: "bar",
    variationId: "basic",
    selection: { category: ["region"], values: ["total"] },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const connection: Pick<DatabaseConnection, "id" | "type"> = { id: "c1", type: "postgres" };

describe("share access", () => {
  test("a snapshot id is 32 hex characters", () => {
    expect(isShareId(ID)).toBe(true);
    expect(isShareId(`${ID}0`)).toBe(false);
    expect(isShareId("not-a-share")).toBe(false);
  });

  test("only the snapshot page, its description, and its query are public", () => {
    expect(isPublicShareRequest("GET", `/share/${ID}`)).toBe(true);
    expect(isPublicShareRequest("GET", `/api/share/${ID}`)).toBe(true);
    expect(isPublicShareRequest("POST", `/api/share/${ID}/query`)).toBe(true);
    expect(isPublicShareRequest("POST", "/api/share")).toBe(false);
    expect(isPublicShareRequest("POST", `/api/share/${ID}/refresh`)).toBe(false);
    expect(isPublicShareRequest("DELETE", `/api/share/${ID}`)).toBe(false);
    expect(isPublicShareRequest("GET", "/share/short")).toBe(false);
    expect(isPublicShareRequest("PUT", `/api/share/${ID}/query`)).toBe(false);
  });
});

describe("planDashboardShare", () => {
  test("copies a chart into one snapshot table and leaves a column filter open", () => {
    const saved = chart({ query: "SELECT region, total FROM sales WHERE region = {{region}}" });
    const dashboard = board({
      filters: [{ id: "filter-1", name: "region", label: "Region", query: "", value: "east", control: "select" }],
    });
    const plan = planDashboardShare(dashboard, [saved], [connection]);
    expect(typeof plan).not.toBe("string");
    if (typeof plan === "string") return;
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]?.openedSql).toBe("SELECT region, total FROM sales");
    expect(plan.sources[0]?.bakedSql).toContain("'east'");
    expect(plan.sources[0]?.interactive).toEqual([{ name: "region", compare: "=", value: "east" }]);
    expect(plan.dashboard.filters?.[0]?.script).toBeUndefined();
    expect(plan.dashboard.instructions).toBeUndefined();

    const finished = withSnapshotQueries(plan, new Map([["c_abc12345", ["region", "total"]]]));
    expect(finished.charts[0]?.query).toBe('SELECT * FROM "c_abc12345" WHERE region = {{region:east}}');
    expect(finished.sources[0]?.sql).toBe("SELECT region, total FROM sales");
    expect(finished.charts[0]?.connectionId).toBeUndefined();
    expect(finished.charts[0]?.refreshSeconds).toBeUndefined();
  });

  test("keeps the current result when the filter is not a column in the result", () => {
    const saved = chart({ query: "SELECT total FROM sales WHERE region = {{region}}" });
    const dashboard = board({
      filters: [{ id: "filter-1", name: "region", query: "", value: "east" }],
    });
    const plan = planDashboardShare(dashboard, [saved], [connection]);
    if (typeof plan === "string") throw new Error(plan);
    const finished = withSnapshotQueries(plan, new Map([["c_abc12345", ["total"]]]));
    expect(finished.sources[0]?.sql).toContain("'east'");
    expect(finished.charts[0]?.query).toBe('SELECT * FROM "c_abc12345"');
    expect(finished.frozen.some((note) => note.reason.includes("not a column"))).toBe(true);
  });

  test("bakes a vector query and drops the vector control", () => {
    const saved = chart({ query: "SELECT * FROM docs WHERE knn(body, {{search:car}}, 5)" });
    const dashboard = board({
      filters: [{ id: "filter-1", name: "search", query: "", value: "car", control: "vector" }],
    });
    const plan = planDashboardShare(dashboard, [saved], [connection]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.sources[0]?.interactive).toEqual([]);
    expect(plan.dashboard.filters).toBeUndefined();
    expect(plan.frozen.some((note) => note.reason.includes("vector"))).toBe(true);
  });

  test("copies a filter's choice query and a note, and refuses a missing chart", () => {
    const dashboard = board({
      filters: [
        {
          id: "filter-1",
          name: "region",
          query: "SELECT region FROM sales",
          value: "",
          connectionId: "c1",
          choiceSource: "query",
        },
      ],
      notes: [{ id: "note-1", text: "Hello", query: "SELECT 'hi'", connectionId: "c1", script: "alert(1)" }],
    });
    const plan = planDashboardShare(dashboard, [chart({ query: "" })], [connection]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.sources.map((source) => source.table).some((table) => table.startsWith("f_"))).toBe(true);
    expect(plan.sources.map((source) => source.table).some((table) => table.startsWith("n_"))).toBe(true);
    expect(plan.dashboard.notes?.[0]?.script).toBeUndefined();
    const quiet = planDashboardShare(
      board({ notes: [{ id: "note-2", text: "Just words", width: 200 }] }),
      [chart()],
      [connection],
    );
    if (typeof quiet === "string") throw new Error(quiet);
    expect(quiet.dashboard.notes?.[0]?.query).toBeUndefined();
    expect(quiet.dashboard.notes?.[0]?.width).toBe(200);
    expect(plan.dashboard.notes?.[0]?.query).toContain("SELECT * FROM");
    expect(planDashboardShare(board(), [], [connection])).toBe("A chart on this dashboard is no longer saved.");
  });

  test("refuses a chart with no connection, a cross-database join, a write, and too many queries", () => {
    expect(planDashboardShare(board(), [chart({ connectionId: undefined })], [])).toContain("no connection");
    expect(planDashboardShare(board(), [chart({ connectionId: "cross-db-joins" })], [])).toContain("Cross_DB_Joins");
    expect(planDashboardShare(board(), [chart({ connectionId: "missing" })], [connection])).toContain(
      "no longer available",
    );
    expect(planDashboardShare(board(), [chart({ query: "DELETE FROM sales" })], [connection])).toContain(
      "has to be a read",
    );
    const many = board({
      charts: Array.from({ length: 25 }, (_, index) => ({ chartId: `c${index}`, width: 1, height: 1 })),
    });
    const charts = Array.from({ length: 25 }, (_, index) =>
      chart({ id: `c${index}`, token: `c_${index.toString(16).padStart(8, "0")}`, name: `C${index}` }),
    );
    expect(planDashboardShare(many, charts, [connection])).toContain("at most");
  });

  test("a filter that is not a comparison stays frozen, and a custom filter becomes a search box", () => {
    const saved = chart({ query: "SELECT region, total FROM sales WHERE note = {{region}}" });
    const dashboard = board({
      filters: [
        {
          id: "filter-1",
          name: "region",
          query: "",
          value: "east",
          control: "custom",
          script: "setValue('x')",
        },
      ],
    });
    const plan = planDashboardShare(dashboard, [saved], [connection]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.frozen.some((note) => note.reason.includes("not a column comparison"))).toBe(true);
    expect(plan.dashboard.filters?.[0]?.control).toBe("search");
    expect(plan.dashboard.filters?.[0]?.script).toBeUndefined();
  });

  test("the shortest refresh on the board is the snapshot schedule", () => {
    expect(
      shareRefreshSeconds([chart({ refreshSeconds: 120 }), chart({ id: "other", refreshSeconds: 90 })], ["revenue"]),
    ).toBe(120);
    expect(shareRefreshSeconds([chart()], ["revenue"])).toBeUndefined();
    expect(shareRefreshSeconds([chart({ refreshSeconds: 1 })], ["revenue"])).toBe(60);
  });

  test("sourceForFields uses the opened rows only when every filter column was copied", () => {
    const source: ShareSourcePlan = {
      table: "c_abc12345",
      connectionId: "c1",
      label: 'Chart "Revenue"',
      chartName: "Revenue",
      openedSql: "SELECT region FROM sales",
      bakedSql: "SELECT region FROM sales WHERE region = 'east'",
      interactive: [{ name: "region", compare: "=", value: "east" }],
    };
    expect(sourceForFields(source, ["region"]).sql).toBe(source.openedSql);
    expect(sourceForFields(source, ["total"]).sql).toBe(source.bakedSql);
    expect(snapshotQuery("c_abc12345", [])).toBe('SELECT * FROM "c_abc12345"');
  });

  test("a dashboard that is not an object is refused, and a query body must be text", () => {
    expect(readSharePublish({})).toBe("The dashboard is not valid.");
    expect(readSharePublish({ dashboard: { name: "Sales", charts: [] }, charts: [], connections: [] })).toMatchObject({
      dashboard: { name: "Sales" },
    });
    expect(
      readSharePublish({ dashboard: { name: "Sales", charts: [] }, charts: [], connections: [], id: "nope" }),
    ).toBe("That share link is not valid.");
    expect(
      readSharePublish({
        dashboard: { name: "Sales", charts: [{ chartId: "revenue" }] },
        charts: [{ id: "revenue" }, "nope"],
        connections: [{ id: "c1", type: "postgres" }, { id: 1 }],
        id: ID,
      }),
    ).toMatchObject({ id: ID, connections: [{ id: "c1" }] });
    expect(readShareQuery({})).toBeNull();
    expect(readShareQuery({ sql: "SELECT 1" })).toBe("SELECT 1");
    expect(planDashboardShare(board({ charts: [null as unknown as SavedDashboard["charts"][number]] }), [], [])).toBe(
      "The dashboard is not valid.",
    );
  });
});
