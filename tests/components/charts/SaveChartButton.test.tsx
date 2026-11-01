import "../../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SaveChartButton } from "@/components/charts/SaveChartButton";
import { storage } from "@/lib/storage";

const draft = {
  name: "Revenue",
  title: "Revenue",
  query: "SELECT region, total FROM sales",
  connectionId: "c1",
  chartType: "bar",
  xAxis: "region",
  yAxis: ["total"],
  typeId: "bar",
  variationId: "basic",
  selection: { category: ["region"], values: ["total"] },
};

describe("SaveChartButton", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("saves a chart, raises a short refresh, and can cancel", () => {
    const view = render(<SaveChartButton draft={draft} />);
    fireEvent.click(view.getByRole("button", { name: "Save chart" }));
    fireEvent.change(view.getByRole("textbox", { name: "Chart name" }), { target: { value: "  " } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.getByRole("alert").textContent).toBe("Name the chart before saving.");
    fireEvent.change(view.getByRole("textbox", { name: "Chart name" }), { target: { value: "Revenue" } });
    fireEvent.change(view.getByRole("textbox", { name: "Refresh seconds" }), { target: { value: "soon" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.getByRole("alert").textContent).toBe("Refresh must be a whole number of seconds.");
    fireEvent.change(view.getByRole("textbox", { name: "Refresh seconds" }), { target: { value: "15" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.getByText("Raised to 60 seconds, the shortest refresh.")).toBeTruthy();
    expect(storage.getSavedCharts()[0]?.refreshSeconds).toBe(60);
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.getByRole("alert").textContent).toBe("This chart is already saved.");
    expect(storage.getSavedCharts()).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByRole("textbox", { name: "Chart name" })).toBeNull();
  });

  test("a chart without a query cannot schedule a refresh", () => {
    const view = render(<SaveChartButton draft={{ ...draft, query: "  " }} />);
    fireEvent.click(view.getByRole("button", { name: "Save chart" }));
    const refresh = view.getByRole("textbox", { name: "Refresh seconds" }) as HTMLInputElement;
    expect(refresh.disabled).toBe(true);
    fireEvent.change(refresh, { target: { value: "nope" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(storage.getSavedCharts()[0]?.query).toBeUndefined();
    expect(storage.getSavedCharts()[0]?.refreshSeconds).toBeUndefined();
  });
});
