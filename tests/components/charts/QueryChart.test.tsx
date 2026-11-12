import "../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import React from "react";
import { setupChartCodeMonacoMock } from "../../helpers/mock-monaco";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
import type { QueryResult } from "@/lib/types";

interface FakeChart {
  option: unknown;
  disposed: boolean;
  setOption: (option: unknown) => void;
  resize: () => void;
  dispose: () => void;
}

const charts: FakeChart[] = [];
const registered: string[] = [];

function makeChart(): FakeChart {
  const chart: FakeChart = {
    option: undefined,
    disposed: false,
    setOption(option) {
      chart.option = option;
    },
    resize() {},
    dispose() {
      chart.disposed = true;
    },
  };
  charts.push(chart);
  return chart;
}

mock.module("echarts/core", () => ({
  use: () => {},
  init: () => makeChart(),
  registerMap: (name: string) => {
    registered.push(name);
  },
}));

mock.module("echarts/charts", () => ({
  LineChart: {},
  BarChart: {},
  ScatterChart: {},
  RadarChart: {},
  BoxplotChart: {},
  CandlestickChart: {},
  HeatmapChart: {},
  GraphChart: {},
  TreemapChart: {},
  SankeyChart: {},
  FunnelChart: {},
  GaugeChart: {},
}));

mock.module("echarts/components", () => ({
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  RadarComponent: {},
  GeoComponent: {},
  TitleComponent: {},
  VisualMapComponent: {},
  CalendarComponent: {},
  BrushComponent: {},
  DataZoomComponent: {},
  ToolboxComponent: {},
}));

mock.module("echarts/renderers", () => ({
  CanvasRenderer: {},
}));

setupChartCodeMonacoMock();

import { CirclePackChart } from "@/components/charts/CirclePackChart";
import { QueryChart } from "@/components/charts/QueryChart";

afterEach(() => {
  cleanup();
  charts.length = 0;
  registered.length = 0;
});

function resultOf(fields: string[], rows: Record<string, unknown>[]): QueryResult {
  return { fields, rows, rowCount: rows.length, executionTime: 1 };
}

const sales = resultOf(
  ["region", "total"],
  [
    { region: "east", total: 1, secret: 9 },
    { region: "west", total: 2 },
  ],
);

describe("QueryChart", () => {
  test("shows the type names and no chart until a variation is chosen", () => {
    const view = render(React.createElement(QueryChart, { result: sales }));
    expect(within(view.getByRole("group", { name: "Chart types" })).getAllByRole("button")).toHaveLength(15);
    expect(view.queryByRole("group", { name: "Chart variations" })).toBeNull();
    expect(view.queryByTestId("query-chart")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    const variations = within(view.getByRole("group", { name: "Chart variations" })).getAllByRole("button");
    expect(variations.map((button) => button.textContent)).toEqual([
      "Basic",
      "Stacked",
      "Horizontal",
      "Stacked horizontal",
      "Rounded",
      "Background",
      "100% stacked",
    ]);
    expect(view.queryByTestId("query-chart")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    expect(view.getByTestId("query-chart")).not.toBeNull();
    const option = charts.at(-1)?.option as { series: { type: string }[]; xAxis: { data: string[] } };
    expect(option.series[0]?.type).toBe("bar");
    expect(option.xAxis.data).toEqual(["east", "west"]);
    expect(view.queryByRole("button", { name: "secret" })).toBeNull();
    expect(registered).toContain("midst-world");
    view.unmount();
    expect(charts.at(-1)?.disposed).toBe(true);
  });

  test("circle packing under scatter draws D3 circles", () => {
    const view = render(
      React.createElement(QueryChart, {
        result: resultOf(
          ["region", "total", "group"],
          [
            { region: "east", total: 50, group: "Americas" },
            { region: "west", total: 1, group: "Americas" },
          ],
        ),
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Scatter" }));
    expect(view.getByRole("button", { name: "Circle packing" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Circle packing" }));
    fireEvent.click(within(view.getByRole("group", { name: "Parent" })).getByRole("button", { name: "group" }));
    const packed = view.getByTestId("circle-pack");
    expect(packed.querySelectorAll("circle").length).toBeGreaterThan(1);
    expect(Array.from(packed.querySelectorAll("text")).some((node) => node.textContent === "east")).toBe(true);
    expect(view.queryByTestId("query-chart")).toBe(packed.parentElement);
    view.unmount();
    const bare = render(React.createElement(CirclePackChart, { option: { libredb: "circle-pack", data: [{}] } }));
    expect(bare.container.querySelector("svg")).toBeNull();
    const drawn = render(
      React.createElement(CirclePackChart, {
        option: {
          libredb: "circle-pack",
          ink: "#111",
          data: [
            { name: "Group", value: 11, x: 50, y: 50, r: 40, depth: 1, leaf: false, color: "#333" },
            { name: "Big", value: 10, x: 50, y: 50, r: 20, depth: 2, leaf: true, color: "#111" },
            { name: "Tiny", value: 1, x: 10, y: 10, r: 2, depth: 2, leaf: true, color: "#222" },
          ],
        },
      }),
    );
    expect(drawn.getByText("Big")).toBeTruthy();
    expect(drawn.queryByText("Tiny")).toBeNull();
    expect(drawn.getByText("Big").getAttribute("fill")).toBe("#111");
  });

  test("a waterfall draws the change as a floating bar", () => {
    const view = render(React.createElement(QueryChart, { result: sales }));
    fireEvent.click(view.getByRole("button", { name: "Waterfall" }));
    expect(
      within(view.getByRole("group", { name: "Chart variations" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Change", "Balance", "Horizontal", "With total", "Labeled"]);
    fireEvent.click(view.getByRole("button", { name: "Change" }));
    const option = charts.at(-1)?.option as { series: { name: string; data: unknown[] }[] };
    expect(option.series.map((series) => series.name)).toEqual(["Base", "Increase", "Decrease"]);
    expect(option.series[0]?.data).toEqual([0, 1]);
    expect(option.series[1]?.data).toEqual([
      { value: 1, signed: 1 },
      { value: 2, signed: 2 },
    ]);
  });

  test("a variation changes the one chart, and another type clears it", () => {
    const view = render(React.createElement(QueryChart, { result: sales }));
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Horizontal" }));
    const horizontal = charts.at(-1)?.option as { xAxis: { type: string } };
    expect(horizontal.xAxis.type).toBe("value");
    fireEvent.click(view.getByRole("button", { name: "Line" }));
    expect(view.queryByTestId("query-chart")).toBeNull();
    expect(view.getByRole("button", { name: "Smooth" })).not.toBeNull();
  });

  test("shelves offer only the result columns, and clearing a required one asks again", () => {
    const view = render(React.createElement(QueryChart, { result: sales }));
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    const metrics = within(view.getByRole("group", { name: "Metrics" }));
    expect(metrics.getByRole("button", { name: "total" })).not.toBeNull();
    expect(metrics.queryByRole("button", { name: "region" })).toBeNull();
    fireEvent.click(metrics.getByRole("button", { name: "total" }));
    expect(view.queryByTestId("query-chart")).toBeNull();
    expect(view.getByText("Choose the columns this chart needs.")).not.toBeNull();
  });

  test("a masked numeric column is not a metric, and a masked dimension is drawn masked", () => {
    const view = render(
      React.createElement(QueryChart, {
        result: resultOf(
          ["region", "email", "total", "salary"],
          [
            { region: null, email: "a@b.co", total: 1, salary: 10 },
            { region: "east", email: "c@d.co", total: 2, salary: 20 },
          ],
        ),
        maskingEnabled: true,
        userRole: "user",
        maskingConfig: DEFAULT_MASKING_CONFIG,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    const metrics = within(view.getByRole("group", { name: "Metrics" }));
    expect(metrics.queryByRole("button", { name: "salary" })).toBeNull();
    expect(metrics.getByRole("button", { name: "total" })).not.toBeNull();
    const first = charts.at(-1)?.option as { xAxis: { data: string[] } };
    expect(first.xAxis.data).toContain("(null)");
    expect(first.xAxis.data).toContain("east");
    fireEvent.click(within(view.getByRole("group", { name: "Dimension" })).getByRole("button", { name: "email" }));
    const masked = charts.at(-1)?.option as { xAxis: { data: string[] } };
    expect(masked.xAxis.data.join(" ")).not.toContain("a@b.co");
  });

  test("with no result, a variation asks for a query", () => {
    const view = render(React.createElement(QueryChart, { result: null, maskingEnabled: true, userRole: "user" }));
    fireEvent.click(view.getByRole("button", { name: "Gauge" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    expect(view.getByText("Run a query. Charts can only use columns from its result.")).not.toBeNull();
    expect(view.queryByTestId("query-chart")).toBeNull();
  });

  test("columns with no finite pair say so, and a note is shown when series are cut", () => {
    const empty = render(
      React.createElement(QueryChart, {
        result: resultOf(
          ["x", "y"],
          [
            { x: 1, y: null },
            { x: null, y: 2 },
          ],
        ),
      }),
    );
    fireEvent.click(empty.getByRole("button", { name: "Scatter" }));
    fireEvent.click(empty.getByRole("button", { name: "Basic" }));
    expect(empty.getByText("Those columns do not have numbers to chart.")).not.toBeNull();
    cleanup();
    const metrics = Array.from({ length: 9 }, (_, index) => `m${index}`);
    const wide = render(
      React.createElement(QueryChart, {
        result: resultOf(
          ["region", ...metrics],
          [Object.fromEntries([["region", "east"], ...metrics.map((name, index) => [name, index])])],
        ),
      }),
    );
    fireEvent.click(wide.getByRole("button", { name: "Line" }));
    fireEvent.click(wide.getByRole("button", { name: "Basic" }));
    const shelf = within(wide.getByRole("group", { name: "Metrics" }));
    for (const name of metrics.slice(1)) fireEvent.click(shelf.getByRole("button", { name: name }));
    expect(wide.getByText("Showing the first 8 of 9 metrics.")).not.toBeNull();
  });

  test("an agent answer selects its type and variation, including a pie", () => {
    const spec = { type: "stacked-bar" as const, x: "region", y: ["total"] as [string], caption: "Totals." };
    const view = render(React.createElement(QueryChart, { result: sales, spec }));
    expect(view.getByRole("button", { name: "Bar" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("button", { name: "Stacked" }).getAttribute("aria-pressed")).toBe("true");
    const drawn = charts.at(-1);
    if (drawn === undefined) throw new Error("expected a chart");
    expect((drawn.option as { series: { stack?: string }[] }).series[0]?.stack).toBe("total");
    cleanup();
    charts.length = 0;
    const pie = render(
      React.createElement(QueryChart, {
        result: sales,
        spec: { type: "pie", x: "region", y: ["total"], caption: "Share." },
      }),
    );
    expect(pie.getByRole("button", { name: "Pie" }).getAttribute("aria-pressed")).toBe("true");
    expect(pie.getByRole("button", { name: "Basic" }).getAttribute("aria-pressed")).toBe("true");
    const drawnPie = charts.at(-1);
    if (drawnPie === undefined) throw new Error("expected a chart");
    expect((drawnPie.option as { series: { type: string }[] }).series[0]?.type).toBe("pie");
    pie.rerender(
      React.createElement(QueryChart, {
        result: resultOf(
          ["city", "n"],
          [
            { city: "a", n: 1 },
            { city: "b", n: 2 },
          ],
        ),
        spec: { type: "area", x: "city", y: ["n"], caption: "Area." },
      }),
    );
    expect(pie.getByRole("button", { name: "Line" }).getAttribute("aria-pressed")).toBe("true");
    expect(pie.getByRole("button", { name: "Area" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("shows a filter from the query and reports a new value", () => {
    const onFilterChange = mock(() => {});
    const view = render(
      React.createElement(QueryChart, {
        result: sales,
        query: "SELECT region, total FROM sales WHERE region = {{region:east|east,west}}",
        onFilterChange,
      }),
    );
    fireEvent.change(view.getByRole("combobox", { name: "region" }), { target: { value: "west" } });
    expect(onFilterChange).toHaveBeenCalledWith(
      "SELECT region, total FROM sales WHERE region = {{region:west|east,west}}",
    );
    fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    expect(onFilterChange).toHaveBeenLastCalledWith("SELECT region, total FROM sales");
    view.rerender(React.createElement(QueryChart, { result: sales, query: "SELECT 1", onFilterChange }));
    expect(view.queryByRole("combobox", { name: "region" })).toBeNull();
  });

  test("adds a filter from the button beside Dimension", () => {
    const onFilterChange = mock(() => {});
    const view = render(
      React.createElement(QueryChart, {
        result: sales,
        query: "SELECT region, total FROM sales",
        onFilterChange,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    const filter = within(view.getByRole("group", { name: "Filter" }));
    fireEvent.click(filter.getByRole("button", { name: "region" }));
    const added = "SELECT region, total FROM sales WHERE region = {{region:east|east,west}}";
    expect(onFilterChange).toHaveBeenCalledWith(added);
    view.rerender(React.createElement(QueryChart, { result: sales, query: added, onFilterChange }));
    fireEvent.change(within(view.getByRole("group", { name: "Filter" })).getByRole("combobox", { name: "region" }), {
      target: { value: "west" },
    });
    expect(onFilterChange).toHaveBeenLastCalledWith(
      "SELECT region, total FROM sales WHERE region = {{region:west|east,west}}",
    );
  });

  test("a metric filter is a number and a comparison", () => {
    const onFilterChange = mock(() => {});
    const view = render(
      React.createElement(QueryChart, {
        result: sales,
        query: "SELECT region, total FROM sales",
        onFilterChange,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    const filter = within(view.getByRole("group", { name: "Filter" }));
    fireEvent.click(filter.getByRole("button", { name: "total" }));
    const added = "SELECT region, total FROM sales WHERE total = {{total:1}}";
    expect(onFilterChange).toHaveBeenCalledWith(added);
    view.rerender(React.createElement(QueryChart, { result: sales, query: added, onFilterChange }));
    const comparison = view.getByRole("combobox", { name: "total comparison" });
    fireEvent.change(comparison, { target: { value: "nope" } });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    fireEvent.change(comparison, { target: { value: ">=" } });
    const compared = "SELECT region, total FROM sales WHERE total >= {{total:1}}";
    expect(onFilterChange).toHaveBeenLastCalledWith(compared);
    view.rerender(React.createElement(QueryChart, { result: sales, query: compared, onFilterChange }));
    const input = view.getByRole("spinbutton", { name: "total" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: "a" });
    expect(onFilterChange).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("1");
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onFilterChange).toHaveBeenLastCalledWith("SELECT region, total FROM sales WHERE total >= {{total:4}}");
    view.rerender(
      React.createElement(QueryChart, {
        result: sales,
        query: "SELECT region, total FROM sales WHERE total >= {{total:9|1,2}}",
        onFilterChange,
      }),
    );
    expect((view.getByRole("spinbutton", { name: "total" }) as HTMLInputElement).value).toBe("9");
    expect((view.getByRole("combobox", { name: "total comparison" }) as HTMLSelectElement).value).toBe(">=");
  });

  test("a metric filter stays a number comparison before a chart variation is chosen", () => {
    const onFilterChange = mock(() => {});
    const query = "SELECT region, total FROM sales WHERE total <= {{total:2|2,9}}";
    const view = render(React.createElement(QueryChart, { result: sales, query, onFilterChange }));
    const input = view.getByRole("spinbutton", { name: "total" }) as HTMLInputElement;
    expect((view.getByRole("combobox", { name: "total comparison" }) as HTMLSelectElement).value).toBe("<=");
    fireEvent.change(view.getByRole("combobox", { name: "total comparison" }), { target: { value: "=" } });
    expect(onFilterChange).toHaveBeenCalledWith("SELECT region, total FROM sales WHERE total = {{total:2}}");
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.blur(input);
    expect(onFilterChange).toHaveBeenLastCalledWith("SELECT region, total FROM sales WHERE total <= {{total:6}}");
  });

  test("edits the chart code and a new variation returns to the generated chart", () => {
    const edited = { title: { text: "Edited" } };
    const drawn = (): FakeChart => {
      const chart = charts.at(-1);
      if (chart === undefined) throw new Error("expected a chart");
      return chart;
    };
    const view = render(React.createElement(QueryChart, { result: sales }));
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const code = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(code.getAttribute("data-language")).toBe("json");
    expect(code.getAttribute("data-controlled")).toBe("no");
    expect(code.value).toContain('"bar"');
    expect(code.value).toContain('"text": "Bar"');
    expect(code.value).not.toContain('"data"');
    expect(code.value).not.toContain("east");
    fireEvent.change(code, { target: { value: "{" } });
    expect(view.getByRole("alert").textContent).toBe("Chart code is not valid JSON.");
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect((drawn().option as { series: { type: string }[] }).series[0]?.type).toBe("bar");
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: { value: JSON.stringify(edited) },
    });
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    expect(view.queryByText("Showing your chart code.")).toBeNull();
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
    const drawnOption = drawn().option as { title: { text: string }; series: { data: unknown }[] };
    expect(drawnOption.title.text).toBe("Edited");
    expect(drawnOption.series[0]?.data).toEqual([1, 2]);
    fireEvent.click(view.getByRole("button", { name: "Horizontal" }));
    expect(view.queryByText("Showing your chart code.")).toBeNull();
    expect((drawn().option as { xAxis: { type: string } }).xAxis.type).toBe("value");
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    const restored = view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement;
    expect(restored.value).toContain('"bar"');
    expect(restored.value).not.toContain("Edited");
    fireEvent.change(restored, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(view.getByRole("button", { name: "Use generated chart" }));
    expect(view.queryByRole("button", { name: "Use generated chart" })).toBeNull();
    expect((view.getByRole("textbox", { name: "Chart code" }) as HTMLTextAreaElement).value).toContain('"bar"');
  });

  test("does not draw a tooltip color that breaks out of the arrow style", () => {
    const view = render(React.createElement(QueryChart, { result: sales }));
    fireEvent.click(view.getByRole("button", { name: "Bar" }));
    fireEvent.click(view.getByRole("button", { name: "Basic" }));
    fireEvent.click(view.getByRole("button", { name: "Code" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart code" }), {
      target: {
        value: JSON.stringify({
          tooltip: {
            backgroundColor: 'red"></div><img src=x onerror=alert(1)>',
            borderColor: "#336699",
          },
        }),
      },
    });
    fireEvent.click(view.getByRole("button", { name: "Chart" }));
    const option = charts.at(-1)?.option as {
      tooltip?: { backgroundColor?: string; borderColor?: string };
    };
    expect(option.tooltip?.backgroundColor).toBeUndefined();
    expect(option.tooltip?.borderColor).toBe("#336699");
    expect(JSON.stringify(option)).not.toContain("onerror");
  });
});
