import { describe, expect, test } from "bun:test";
import { axesFromSelection, buildSavedChart, chartSaveDraft } from "@/lib/charts/save-chart";

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
});
