import { describe, expect, test } from "bun:test";
import { ASSIST_SCHEMA_CAP } from "@/lib/ai/assist-plan";
import {
  blockFrameSize,
  chartFrameSize,
  chartLabel,
  CUSTOM_FILTER_SCRIPT,
  DASHBOARD_ASSIST_GUIDE,
  dashboardAssistContext,
  dashboardEditorSql,
  dashboardName,
  dashboardVariables,
  DEFAULT_DASHBOARD_BLOCK_WIDTH,
  DEFAULT_DASHBOARD_NOTE_HEIGHT,
  dragBlockResize,
  dragResize,
  filterChoices,
  filterValueList,
  filterControlPatch,
  filterFrameDocument,
  filterFrameMessage,
  filterLabel,
  filterReference,
  filterSlider,
  freshDashboard,
  freshDashboardChart,
  insertQueryVariable,
  MAX_DASHBOARD_CHART_HEIGHT,
  MIN_DASHBOARD_CHART_HEIGHT,
  MIN_DASHBOARD_CHART_WIDTH,
  placeSavedComponent,
  queryWithDashboardFilters,
  savedComponentFromFilter,
  withChart,
  withFilter,
  withFilterFields,
  withFrame,
  MIN_DASHBOARD_BLOCK_HEIGHT,
  MAX_DASHBOARD_BLOCK_HEIGHT,
  schemaWithDashboard,
  withName,
  withNote,
  withNoteFrame,
  withNoteText,
  withoutChart,
  withoutFilter,
  withoutNote,
} from "@/lib/dashboards/dashboard";
import type { SavedDashboard } from "@/lib/types";

function board(charts: SavedDashboard["charts"] = []): SavedDashboard {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return { id: "d1", name: "Board", charts, createdAt: now, updatedAt: now };
}

describe("dashboard layout", () => {
  test("sizes a chart to the board and refuses a size that is not a number", () => {
    expect(chartFrameSize(480, 320, 800)).toEqual({ width: 480, height: 320 });
    expect(chartFrameSize(2000, 20, 400)).toEqual({ width: 400, height: MIN_DASHBOARD_CHART_HEIGHT });
    expect(chartFrameSize(2000, 4000, 100)).toEqual({ width: 1600, height: MAX_DASHBOARD_CHART_HEIGHT });
    expect(chartFrameSize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toEqual({
      width: MIN_DASHBOARD_CHART_WIDTH,
      height: MIN_DASHBOARD_CHART_HEIGHT,
    });
    expect(dragResize({ width: 480, height: 320 }, -400, 40, 800)).toEqual({
      width: MIN_DASHBOARD_CHART_WIDTH,
      height: 360,
    });
    expect(blockFrameSize(576, 220, 800)).toEqual({ width: 576, height: 220 });
    expect(blockFrameSize(2000, 20, 400)).toEqual({ width: 400, height: MIN_DASHBOARD_BLOCK_HEIGHT });
    expect(blockFrameSize(2000, 4000, 100)).toEqual({
      width: 1600,
      height: MAX_DASHBOARD_BLOCK_HEIGHT,
    });
    expect(blockFrameSize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toEqual({
      width: DEFAULT_DASHBOARD_BLOCK_WIDTH,
      height: DEFAULT_DASHBOARD_NOTE_HEIGHT,
    });
    expect(dragBlockResize({ width: 576, height: 220 }, -400, 40, 800)).toEqual({
      width: 240,
      height: 260,
    });
  });

  test("names the next dashboard, and skips a name that is already used", () => {
    expect(dashboardName([])).toBe("Dashboard 1");
    expect(dashboardName([{ name: "Dashboard 2" }])).toBe("Dashboard 3");
  });

  test("places, renames, resizes, and removes a chart", () => {
    expect(freshDashboard("Dashboard 1").id).toBeTypeOf("string");
    const created = freshDashboard("Dashboard 1", "d1");
    expect(created.charts).toEqual([]);
    expect(created.createdAt).toBeInstanceOf(Date);
    const placed = withChart(created, "c1", 800);
    expect(placed.charts).toEqual([{ chartId: "c1", width: 480, height: 320 }]);
    expect(withChart(placed, "c1", 800)).toBe(placed);
    const narrow = withChart(board(), "c1", 300);
    expect(narrow.charts[0]?.width).toBe(300);
    const renamed = withName(placed, "Sales");
    expect(renamed.name).toBe("Sales");
    const sized = withFrame(renamed, "c1", { width: 500, height: 280 });
    expect(sized.charts[0]).toEqual({ chartId: "c1", width: 500, height: 280 });
    expect(withFrame(sized, "missing", { width: 1, height: 1 }).charts).toHaveLength(1);
    expect(withoutChart(sized, "c1").charts).toEqual([]);
  });

  test("names a new chart and a new filter without repeating a name", () => {
    expect(chartLabel([])).toBe("Chart");
    expect(chartLabel([{ name: "Chart" }])).toBe("Chart 2");
    expect(chartLabel([{ name: "Chart" }, { name: "Chart 2" }])).toBe("Chart 3");
    expect(filterLabel([])).toBe("filter");
    expect(filterLabel([{ name: "filter" }, { name: "filter2" }])).toBe("filter3");
  });

  test("starts a chart from scratch and keeps a connection when one is given", () => {
    const blank = freshDashboardChart([], undefined, "chart-1");
    expect(blank).toMatchObject({ id: "chart-1", name: "Chart", query: "", xAxis: "", yAxis: [] });
    expect(blank.connectionId).toBeUndefined();
    expect(freshDashboardChart([{ name: "Chart" }], "c1", "chart-2").connectionId).toBe("c1");
    expect(freshDashboardChart([], "").connectionId).toBeUndefined();
  });

  test("adds, edits, and removes a note and a filter", () => {
    const noted = withNote(board(), "n1");
    expect(noted.notes).toEqual([{ id: "n1", text: "" }]);
    const written = withNoteText(noted, "n1", "Hello");
    expect(written.notes?.[0]?.text).toBe("Hello");
    expect(withNoteText(written, "missing", "x").notes).toEqual(written.notes);
    const sized = withNoteFrame(written, "n1", { width: 400, height: 180 });
    expect(sized.notes?.[0]).toMatchObject({ text: "Hello", width: 400, height: 180 });
    expect(withNoteFrame(sized, "missing", { width: 1, height: 1 }).notes).toEqual(sized.notes);
    expect(withoutNote(written, "n1").notes).toEqual([]);
    expect(withoutNote(board(), "n1").notes).toEqual([]);
    const filtered = withFilter(board(), "c1", "f1");
    expect(filtered.filters).toEqual([{ id: "f1", name: "filter", query: "", value: "", connectionId: "c1" }]);
    expect(withFilter(board(), "").filters?.[0]?.connectionId).toBeUndefined();
    const renamed = withFilterFields(filtered, "f1", {
      name: "region",
      query: "SELECT region FROM sales",
      value: "east",
    });
    expect(renamed.filters?.[0]).toMatchObject({ name: "region", value: "east" });
    expect(withFilterFields(renamed, "missing", { value: "west" }).filters).toEqual(renamed.filters);
    expect(withoutFilter(renamed, "f1").filters).toEqual([]);
    expect(withoutFilter(board(), "f1").filters).toEqual([]);
  });

  test("reads filter choices and writes a selection into a query placeholder", () => {
    expect(filterReference(" region ")).toBe("{{region}}");
    expect(filterReference("1region")).toBeNull();
    expect(filterReference("")).toBeNull();
    const rows = [
      { region: " east " },
      { region: "east" },
      { region: "" },
      { region: "   " },
      { region: 4 },
      { region: Number.NaN },
      { region: true },
      { region: false },
      { region: null },
      { region: { city: "east" } },
    ];
    expect(filterChoices(rows, ["region"])).toEqual(["east", "4", "true", "false"]);
    expect(filterValueList(" east \n\nwest\neast\n")).toEqual(["east", "west"]);
    expect(filterValueList("")).toEqual([]);
    expect(filterValueList(Array.from({ length: 30 }, (_, index) => `r${index}`).join("\n"))).toHaveLength(24);
    expect(filterChoices(rows, [])).toEqual([]);
    expect(filterChoices(rows, [""])).toEqual([]);
    expect(
      filterChoices(
        Array.from({ length: 30 }, (_, index) => ({ region: `r${index}` })),
        ["region"],
      ),
    ).toHaveLength(24);
    const sql = "SELECT * FROM sales WHERE region = {{region}} AND kind = {{kind:book}}";
    expect(queryWithDashboardFilters(sql, [{ name: "region", value: "east" }])).toBe(
      "SELECT * FROM sales WHERE region = {{region:east}} AND kind = {{kind:book}}",
    );
    expect(queryWithDashboardFilters(sql, [{ name: "missing", value: "east" }])).toBe(sql);
    expect(queryWithDashboardFilters(sql, [{ name: "region", value: "  " }])).toBe(sql);
    expect(queryWithDashboardFilters(sql, [{ name: "bad name", value: "east" }])).toBe(sql);
  });

  test("sizes a slider and starts a custom filter from the stock script", () => {
    expect(filterSlider({ value: "12", min: 5, max: 5, step: 0 })).toEqual({ min: 5, max: 105, step: 1, value: "12" });
    expect(filterSlider({ value: "nope" })).toEqual({ min: 0, max: 100, step: 1, value: "0" });
    expect(filterSlider({ value: "3", min: Number.NaN, max: Number.POSITIVE_INFINITY, step: -2 })).toEqual({
      min: 0,
      max: 100,
      step: 1,
      value: "3",
    });
    expect(filterControlPatch("slider", { value: "east" })).toEqual({
      control: "slider",
      min: 0,
      max: 100,
      step: 1,
      value: "0",
    });
    expect(filterControlPatch("search", { value: "" })).toEqual({ control: "search" });
    expect(filterControlPatch("custom", { value: "", script: "  " }).script).toBe(CUSTOM_FILTER_SCRIPT);
    expect(filterControlPatch("custom", { value: "", script: "setValue(value);" })).toEqual({ control: "custom" });
  });

  test("builds a sandboxed filter document and reads only its own messages", () => {
    const document = filterFrameDocument("f1", 'setValue("</script>")', "east", ["a<b"]);
    expect(document).toContain("\\u003c");
    expect(document.match(/<\/script>/g)?.length).toBe(2);
    expect(document).toContain(String.raw`<\/script>`);
    expect(document).toContain('"id":"f1"');
    expect(filterFrameMessage(null)).toBeNull();
    expect(filterFrameMessage("nope")).toBeNull();
    expect(filterFrameMessage({ source: "other", id: "f1", value: "east" })).toBeNull();
    expect(filterFrameMessage({ source: "libredb-filter", id: "", value: "east" })).toBeNull();
    expect(filterFrameMessage({ source: "libredb-filter", id: "f1", value: 1 })).toBeNull();
    expect(filterFrameMessage({ source: "libredb-filter", id: "f1", value: "east" })).toEqual({
      id: "f1",
      value: "east",
    });
  });

  test("lists a dashboard's variable ids and writes one into a query", () => {
    expect(
      dashboardVariables(
        [
          { id: "a", name: "region", label: " Region ", query: "", value: "" },
          { id: "b", name: "1bad", query: "", value: "" },
          { id: "c", name: "kind", query: "", value: "" },
          { id: "d", name: "city", query: "", value: "" },
        ],
        "c",
      ),
    ).toEqual([
      { id: "a", label: "Region", token: "{{region}}" },
      { id: "d", label: "city", token: "{{city}}" },
    ]);
    expect(dashboardVariables([])).toEqual([]);
    expect(insertQueryVariable("", "{{region}}")).toBe("{{region}}");
    expect(insertQueryVariable("   ", "{{region}}")).toBe("{{region}}");
    expect(insertQueryVariable("SELECT ", "{{region}}")).toBe("SELECT {{region}}");
    expect(insertQueryVariable("SELECT\n", "{{region}}")).toBe("SELECT\n{{region}}");
    expect(insertQueryVariable("SELECT", "{{region}}")).toBe("SELECT {{region}}");
  });

  test("saves a component design and places a fresh copy", () => {
    const full = savedComponentFromFilter(
      {
        id: "f1",
        componentId: "lib",
        name: " region ",
        label: " Region ",
        placeholder: "Find",
        query: "SELECT 1",
        connectionId: "c1",
        value: "east",
        control: "search",
        choiceSource: "values",
        valuesText: "east\nwest",
        min: 1,
        max: 9,
        step: 2,
        script: "setValue(value);",
      },
      "lib",
    );
    expect(full.name).toBe("Region");
    expect(full.filter).toEqual({
      name: " region ",
      label: " Region ",
      placeholder: "Find",
      query: "SELECT 1",
      connectionId: "c1",
      value: "east",
      control: "search",
      choiceSource: "values",
      valuesText: "east\nwest",
      min: 1,
      max: 9,
      step: 2,
      script: "setValue(value);",
    });
    const named = savedComponentFromFilter({ id: "f", name: "region", label: "  ", query: "", value: "" }, "c");
    expect(named.name).toBe("region");
    expect(named.filter).toEqual({ name: "region", label: "  ", query: "", value: "" });
    const blank = savedComponentFromFilter({ id: "f", name: "  ", query: "", value: "" }, "lib2");
    expect(blank.name).toBe("Component");
    const placed = placeSavedComponent(board(), full, "new");
    expect(placed.filters?.[0]).toMatchObject({ id: "new", name: "region", query: "SELECT 1", componentId: "lib" });
    expect(placeSavedComponent(placed, full, "newer").filters?.[1]?.name).toBe("region2");
    expect(placeSavedComponent(board(), blank, "b").filters?.[0]?.name).toBe("filter");
  });

  test("describes the board for the assistant and keeps it inside the schema", () => {
    expect(dashboardEditorSql(null, [])).toBe("");
    const empty = board();
    expect(dashboardEditorSql(empty, [])).toBe("");
    const withCharts = board([
      { chartId: "gone", width: 1, height: 1 },
      { chartId: "plain", width: 1, height: 1 },
      { chartId: "revenue", width: 1, height: 1 },
    ]);
    const charts = [
      { id: "plain", name: "Plain" },
      { id: "revenue", name: "Revenue", query: " SELECT 1 " },
    ];
    expect(dashboardEditorSql(withCharts, charts)).toBe(" SELECT 1 ");
    expect(dashboardEditorSql(board([{ chartId: "plain", width: 1, height: 1 }]), charts)).toBe("");
    const noted = withNoteText(withNote(withCharts, "n1"), "n1", "  Hello  ");
    const described = dashboardAssistContext(
      {
        ...noted,
        filters: [
          { id: "f1", name: "region", label: " Area ", query: "", value: "east", control: "select" },
          { id: "f2", name: "  ", query: "", value: "" },
        ],
      },
      charts,
    );
    expect(described).toBe(
      [
        DASHBOARD_ASSIST_GUIDE,
        "Dashboard: Board",
        "Chart Plain: (no query)",
        "Chart Revenue: SELECT 1",
        "Text: Hello",
        "Component Area (select) = east",
        "Component Component (unset) = ",
      ].join("\n"),
    );
    expect(dashboardAssistContext(null, [])).toBe(DASHBOARD_ASSIST_GUIDE);
    expect(schemaWithDashboard("[]", "  ")).toBe("[]");
    expect(schemaWithDashboard("[]", "Dashboard: Board")).toBe("[]\n\nDashboard:\nDashboard: Board");
    expect(schemaWithDashboard("x".repeat(ASSIST_SCHEMA_CAP), "Dashboard: Board")).toBe("x".repeat(ASSIST_SCHEMA_CAP));
    const near = "y".repeat(ASSIST_SCHEMA_CAP - 10);
    expect(schemaWithDashboard(near, "Dashboard: Board")).toBe(`${near}\n\nDashboar`);
  });
});
