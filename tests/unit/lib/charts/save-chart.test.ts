import { describe, expect, test } from "bun:test";
import {
  axesFromSelection,
  buildSavedChart,
  chartSaveDraft,
  findSavedChart,
  storedChartLook,
} from "@/lib/charts/save-chart";

const draft = {
  name: "Revenue",
  title: "Revenue",
  query: "SELECT 1",
  connectionId: "c1",
  chartType: "bar",
  xAxis: "region",
  yAxis: ["total"],
  typeId: "bar",
  variationId: "basic",
  selection: { category: ["region"], values: ["total"] },
  refreshText: "120",
};

describe("save chart", () => {
  test("axes follow the shelves, and an empty shelf has none", () => {
    expect(axesFromSelection({ category: ["region"], values: ["total", "units"] })).toEqual({
      xAxis: "region",
      yAxis: ["total", "units"],
    });
    expect(axesFromSelection({})).toEqual({ xAxis: "", yAxis: [] });
  });

  test("an empty title is saved under the name Chart", () => {
    expect(
      chartSaveDraft({
        title: "  ",
        query: "SELECT 1",
        typeId: "line",
        variationId: "smooth",
        selection: { category: ["month"] },
      }),
    ).toMatchObject({ name: "Chart", title: "", xAxis: "month", yAxis: [], chartType: "line" });
  });

  test("builds a scheduled chart and refuses a blank name or a bad refresh", () => {
    const saved = buildSavedChart(draft, "chart-1");
    expect(saved).toMatchObject({
      id: "chart-1",
      name: "Revenue",
      query: "SELECT 1",
      connectionId: "c1",
      refreshSeconds: 120,
      title: "Revenue",
      typeId: "bar",
    });
    expect(saved?.createdAt).toBeInstanceOf(Date);
    expect(buildSavedChart({ ...draft, name: "  " })).toBeNull();
    expect(buildSavedChart({ ...draft, refreshText: "soon" })).toBeNull();
    expect(buildSavedChart({ ...draft, refreshText: "" }, "plain")?.refreshSeconds).toBeUndefined();
    expect(buildSavedChart({ ...draft, refreshText: "10" }, "floor")?.refreshSeconds).toBe(60);
  });

  test("omits a query, a connection, a title, and shelves that are not there", () => {
    const saved = buildSavedChart(
      {
        ...draft,
        query: "  ",
        connectionId: "",
        title: " ",
        typeId: undefined,
        variationId: undefined,
        selection: undefined,
        refreshText: "90",
      },
      "bare",
    );
    expect(saved).toMatchObject({ id: "bare", name: "Revenue" });
    expect(saved?.query).toBeUndefined();
    expect(saved?.connectionId).toBeUndefined();
    expect(saved?.title).toBeUndefined();
    expect(saved?.refreshSeconds).toBeUndefined();
    expect(saved?.typeId).toBeUndefined();
    expect(buildSavedChart({ ...draft, connectionId: undefined }).id).toBeTypeOf("string");
  });

  test("the same query, connection, and shelves are the chart already saved", () => {
    const saved = buildSavedChart(draft, "chart-1");
    if (saved === null) throw new Error("expected a chart");
    expect(findSavedChart([saved], draft)?.id).toBe("chart-1");
    expect(findSavedChart([saved], { ...draft, name: "Other", query: "  SELECT 1  " })?.id).toBe("chart-1");
    expect(
      findSavedChart([saved], {
        ...draft,
        selection: { values: ["total"], category: ["region"] },
      })?.id,
    ).toBe("chart-1");
    expect(findSavedChart([saved], { ...draft, query: "SELECT 2" })).toBeNull();
    expect(findSavedChart([saved], { ...draft, variationId: "stacked" })).toBeNull();
    expect(findSavedChart([], draft)).toBeNull();
    const painted = buildSavedChart({ ...draft, look: { color: ["#9546de"], mark: () => 1 } }, "painted");
    expect(painted?.look).toEqual({ color: ["#9546de"] });
    expect(
      findSavedChart(painted === null ? [] : [painted], { ...draft, look: { color: ["#9546de"], mark: () => 1 } })?.id,
    ).toBe("painted");
    expect(findSavedChart(painted === null ? [] : [painted], { ...draft, look: { color: ["#112233"] } })).toBeNull();
    expect(buildSavedChart({ ...draft, look: {} })?.look).toBeUndefined();
    expect(buildSavedChart({ ...draft, look: [] as unknown as Record<string, unknown> })?.look).toBeUndefined();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(storedChartLook(loop)).toBeUndefined();
    expect(storedChartLook({ toJSON: () => "text" })).toBeUndefined();
    expect(storedChartLook({ toJSON: () => null })).toBeUndefined();
    expect(storedChartLook({ toJSON: () => [1] })).toBeUndefined();
    expect(chartSaveDraft({ ...draft, look: { color: ["#9546de"] } }).look).toEqual({ color: ["#9546de"] });
    const bare = {
      ...saved,
      connectionId: undefined,
      typeId: undefined,
      variationId: undefined,
      selection: undefined,
      query: undefined,
    };
    expect(
      findSavedChart([bare], {
        ...draft,
        connectionId: "",
        typeId: undefined,
        variationId: undefined,
        selection: undefined,
        query: "  ",
      })?.id,
    ).toBe("chart-1");
  });
});
