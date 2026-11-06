import { describe, expect, test } from "bun:test";
import {
  blockFrameSize,
  chartFrameSize,
  chartLabel,
  CUSTOM_FILTER_SCRIPT,
  DASHBOARD_INSTRUCTIONS_CAP,
  dashboardAssistContext,
  dashboardName,
  dashboardVariables,
  DEFAULT_DASHBOARD_BLOCK_WIDTH,
  DEFAULT_DASHBOARD_NOTE_HEIGHT,
  dragBlockResize,
  dragResize,
  filterChoices,
  filterValueList,
  filterControlPatch,
  vectorFilterName,
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
  withInstructions,
  withName,
  noteFrameDocument,
  noteLook,
  noteTextFromRows,
  NOTE_FONTS,
  withNote,
  withNoteFields,
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
    const queried = withNoteFields(written, "n1", {
      query: "SELECT 'Hello'",
      connectionId: "c1",
      style: { fontFamily: "Georgia, serif", fontSize: 32 },
    });
    expect(queried.notes?.[0]).toMatchObject({
      text: "Hello",
      query: "SELECT 'Hello'",
      connectionId: "c1",
      style: { fontFamily: "Georgia, serif", fontSize: 32 },
    });
    expect(withNoteFields(queried, "missing", { query: "SELECT 2" }).notes).toEqual(queried.notes);
    expect(withNoteFields(board(), "n1", { query: "SELECT 1" }).notes).toEqual([]);
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
    const embedded = "SELECT {{embed question}} FROM sales WHERE region = {{region}}";
    expect(
      queryWithDashboardFilters(embedded, [
        { name: "question", value: "cats" },
        { name: "region", value: "east" },
      ]),
    ).toBe('SELECT {{embed "cats"}} FROM sales WHERE region = {{region:east}}');
    expect(queryWithDashboardFilters(embedded, [{ name: "question", value: "  " }])).toBe(embedded);
    const vector = '{"vector": {{vq_abc12345}}, "query": {"match": {"title": {{region}}}}}';
    expect(
      queryWithDashboardFilters(vector, [
        { name: "vq_abc12345", value: "a red mug" },
        { name: "region", value: "east" },
      ]),
    ).toBe('{"vector": {{embed "a red mug"}}, "query": {"match": {"title": {{region:east}}}}}');
    expect(queryWithDashboardFilters('{"vector": {{a red mug}}}', [{ name: "vq_abc12345", value: "ignored" }])).toBe(
      '{"vector": {{a red mug}}}',
    );
    expect(queryWithDashboardFilters('{"vector": {{vq_abc12345}}}', [{ name: "vq_abc12345", value: "  " }])).toBe(
      '{"vector": {{embed vq_abc12345}}}',
    );
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
    const generated = filterControlPatch("vector", { value: "", name: "filter" });
    expect(generated.control).toBe("vector");
    expect(generated.name).toMatch(/^vq_[a-f0-9]{10}$/);
    expect(generated.placeholder).toBe("Text to embed");
    expect(filterControlPatch("vector", { value: "", name: "vq_abc12345", placeholder: "Find" })).toEqual({
      control: "vector",
      name: "vq_abc12345",
    });
    expect(vectorFilterName()).toMatch(/^vq_[a-f0-9]{10}$/);
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
    expect(filterFrameMessage({ source: "libredb-filter", id: "f1", value: "x".repeat(2_500) })?.value).toHaveLength(
      2_000,
    );
    expect(document).toContain("default-src 'none'");
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
      { id: "a", label: "Region", token: "{{region}}", embedToken: "{{embed region}}" },
      { id: "d", label: "city", token: "{{city}}", embedToken: "{{embed city}}" },
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

  test("describes the board as a cell inventory and trusted examples", () => {
    expect(dashboardAssistContext(null, [])).toBe(
      ["Dashboard: (none)", "Instructions: (none)", "", "Cells:", "(none)"].join("\n"),
    );
    expect(dashboardAssistContext(board(), [])).toBe(
      ["Dashboard: Board", "Instructions: (none)", "", "Cells:", "(none)"].join("\n"),
    );
    const blankName = dashboardAssistContext({ ...board(), name: "  " }, []);
    expect(blankName.startsWith("Dashboard: Untitled")).toBe(true);
    const instructed = withInstructions(board(), "  Assume the latest month.\nAsk when the region is missing.  ");
    expect(instructed.instructions).toBe("  Assume the latest month.\nAsk when the region is missing.  ");
    expect(withInstructions(board(), "   ").instructions).toBeUndefined();
    expect(withInstructions(board(), "x".repeat(DASHBOARD_INSTRUCTIONS_CAP + 5)).instructions).toHaveLength(
      DASHBOARD_INSTRUCTIONS_CAP,
    );
    const withCharts = board([
      { chartId: "gone", width: 1, height: 1 },
      { chartId: "plain", width: 1, height: 1 },
      { chartId: "revenue", width: 1, height: 1 },
      { chartId: "axes", width: 1, height: 1 },
    ]);
    const noted = withNoteFields(withNoteText(withNote(withCharts, "n1"), "n1", "  Hello  "), "n1", {
      query: " SELECT 'Hello' WHERE region = {{region}} ",
      connectionId: "missing",
    });
    const described = dashboardAssistContext(
      {
        ...noted,
        instructions: "Assume the latest month.",
        notes: [
          ...(noted.notes ?? []),
          { id: "n2", text: "  ", query: " SELECT 2 ", script: " use text;\nreturn rows; ", connectionId: "c1" },
          { id: "n3", text: "", query: "   ", script: "   " },
        ],
        filters: [
          {
            id: "f1",
            name: "region",
            label: ' Area | "east" ',
            query: "SELECT region",
            value: "east",
            control: "select",
            connectionId: "c1",
          },
          { id: "f2", name: "  ", query: "", value: "  " },
          {
            id: "f3",
            name: "not valid",
            query: "",
            value: "x".repeat(90),
            choiceSource: "values",
            control: "custom",
            script: `setValue(${"v".repeat(130)});`,
          },
        ],
      },
      [
        { id: "plain", name: "  ", query: "   ", connectionId: "", typeId: "" },
        {
          id: "revenue",
          name: 'Revenue "east"',
          query: `SELECT 1 WHERE region = {{ region }} AND year = {{year:2024}} AND region = {{region:east|east,west}} ${"a".repeat(500)}`,
          connectionId: "c1",
          typeId: "bar",
          variationId: "stacked",
          metricName: " revenue ",
          title: "Revenue by region",
          selection: { category: ["region", "region"], values: ["total"] },
          xAxis: "ignored",
          yAxis: ["also"],
        },
        {
          id: "axes",
          name: "Axes",
          query: "",
          typeId: "nope",
          variationId: "basic",
          title: "Axes",
          metricName: " ",
          xAxis: " month ",
          yAxis: ["amount", ""],
        },
        { id: "bare", name: "Bare", typeId: "bar", variationId: "missing" },
      ],
      [
        { id: "c1", name: "Orders" },
        { id: "", name: "Blank" },
      ],
    );
    expect(described).toContain("Instructions: Assume the latest month.");
    expect(described).toContain(
      '1. component "Area / \'east\'" | select | publishes {{region}} | value east | choices from query | connection "Orders"',
    );
    expect(described).toContain('2. component "Component" | unset');
    expect(described).not.toContain("publishes {{not");
    expect(described).toContain("choices listed");
    expect(described).toContain("script preview:");
    expect(described).toContain('3. component "not valid" | custom | value ');
    expect(described).toContain("choices listed | script preview:");
    expect(described).not.toContain(". text |");
    expect(described).toContain('4. chart "Untitled" | empty');
    expect(described).toContain("question: Untitled");
    expect(described).toContain(
      '5. chart "Revenue \'east\'" | Bar / Stacked | connection "Orders" | metric "revenue" | shelves region, total | depends on {{region}}, {{year}} | ready',
    );
    expect(described).toContain("question: Revenue by region");
    expect(described).toContain("trusted sql: SELECT 1 WHERE region");
    expect(described).toContain("… truncated,");
    expect(described).not.toContain("ignored");
    expect(described).toContain('6. chart "Axes" | shelves month, amount | empty');
    expect(described).toContain("question: Axes");
    expect(described).not.toContain("nope");
    const shapeOnly = dashboardAssistContext(board([{ chartId: "bare", width: 1, height: 1 }]), [
      { id: "bare", name: "Bare", typeId: "bar", variationId: "missing", xAxis: "day" },
    ]);
    expect(shapeOnly).toContain('1. chart "Bare" | Bar | shelves day | empty');
    expect(shapeOnly).not.toContain("Bar /");
    const verbose = dashboardAssistContext(
      { ...board(), instructions: "i".repeat(DASHBOARD_INSTRUCTIONS_CAP + 20) },
      [],
    );
    expect(verbose).toContain("… truncated, 20 characters omitted");
    const frames = Array.from({ length: 30 }, (_, index) => ({ chartId: `c${index}`, width: 1, height: 1 }));
    const many = frames.map((frame) => ({
      id: frame.chartId,
      name: `Chart ${frame.chartId}`,
      query: "select region, total from sales ".repeat(8),
    }));
    const truncated = dashboardAssistContext(board(frames), many);
    expect(truncated.endsWith("characters omitted")).toBe(true);
    expect(truncated).toContain("… truncated,");
  });

  test("draws a text box from a usable font, size, color, and alignment", () => {
    const fallback = noteLook(undefined);
    expect(fallback).toEqual({
      fontFamily: NOTE_FONTS[0]?.id,
      fontSize: 14,
      align: "left",
      bold: false,
      italic: false,
    });
    expect(noteLook(null)).toEqual(fallback);
    expect(
      noteLook({
        fontFamily: "Georgia, serif",
        fontSize: 14.5,
        color: "#112233",
        background: "#ABCDEF",
        align: "center",
        bold: true,
        italic: true,
      }),
    ).toEqual({
      fontFamily: "Georgia, serif",
      fontSize: 15,
      color: "#112233",
      background: "#ABCDEF",
      align: "center",
      bold: true,
      italic: true,
    });
    expect(noteLook({ fontSize: 8 }).fontSize).toBe(8);
    expect(noteLook({ fontSize: 96 }).fontSize).toBe(96);
    expect(noteLook({ fontSize: 95.6 }).fontSize).toBe(96);
    expect(
      noteLook({
        fontFamily: "Comic Sans",
        fontSize: Number.NaN,
        color: "red",
        background: "#123",
        align: "nope" as "left",
        bold: false,
        italic: false,
      }),
    ).toEqual(fallback);
    expect(noteLook({ fontSize: 7 }).fontSize).toBe(14);
    expect(noteLook({ fontSize: 96.4 }).fontSize).toBe(14);
    expect(noteLook({ fontSize: Number.POSITIVE_INFINITY }).fontSize).toBe(14);
    expect(noteLook({ fontSize: "32" as unknown as number }).fontSize).toBe(14);
    expect(noteLook({ align: "right" }).align).toBe("right");
    expect(noteLook({ color: "#aabbcc", background: "blue" }).color).toBe("#aabbcc");
    expect(noteLook({ color: "#aabbcc", background: "blue" }).background).toBeUndefined();
  });

  test("lays a text query out as lines of cells", () => {
    expect(noteTextFromRows([], [])).toBe("");
    expect(noteTextFromRows([{ value: null }, { value: "" }, { value: "  " }], ["missing", "value"])).toBe("  ");
    const when = new Date("2026-01-02T03:04:05.000Z");
    expect(
      noteTextFromRows(
        [
          {
            words: "Total",
            amount: 2,
            flag: false,
            empty: null,
            skip: "",
            big: BigInt(3),
            when,
            list: [1, "a"],
            bad: Number.NaN,
            later: new Date("nope"),
            mark: Symbol("x"),
            fn: () => 0,
          },
        ],
        ["words", "amount", "flag", "empty", "skip", "big", "when", "list", "bad", "later", "mark", "fn"],
      ),
    ).toBe(`Total 2 false 3 ${when.toISOString()} [1,"a"]`);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(noteTextFromRows([{ loop, quiet: { toJSON: () => undefined } }], ["loop", "quiet"])).toBe("");
    const rows = Array.from({ length: 101 }, (_, index) => ({ n: index }));
    expect(noteTextFromRows(rows, ["n"]).split("\n")).toHaveLength(100);
    expect(noteTextFromRows([{ on: true }], ["on"])).toBe("true");
  });

  test("builds a sandboxed document for a text box script", () => {
    const look = noteLook({
      fontFamily: "Georgia, serif",
      fontSize: 32,
      color: "#112233",
      background: "#ffeeee",
      align: "center",
      bold: true,
      italic: true,
    });
    const doc = noteFrameDocument("root.textContent = text;\n</script><script>", "Hello <b>", [{ n: 1 }], ["n"], look);
    expect(doc).toContain("Hello \\u003cb");
    expect(doc).toContain("<\\/script>");
    expect(doc).toContain('"n":1');
    expect(doc).toContain("font-size:32px");
    expect(doc).toContain("font-weight:700");
    expect(doc).toContain("font-style:italic");
    expect(doc).toContain("#112233");
    expect(doc).toContain("#ffeeee");
    const plain = noteFrameDocument("root.textContent = text;", "Kept", [], [], noteLook(undefined));
    expect(plain).toContain("color:inherit");
    expect(plain).toContain("background:transparent");
    expect(plain).toContain("font-weight:400");
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const safe = noteFrameDocument("root.textContent = text;", "Kept", [loop], ["self"], noteLook(undefined));
    expect(safe).toContain("Kept");
    expect(safe).toContain('"rows":[]');
  });
});
