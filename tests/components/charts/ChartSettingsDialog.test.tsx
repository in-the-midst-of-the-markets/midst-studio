import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChartSettingsDialog } from "@/components/charts/ChartSettingsDialog";
import { DEFAULT_CHART_SETTINGS, readChartSettings } from "@/lib/charts/chart-settings";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChartSettingsDialog", () => {
  test("saves a font, a size, a chart control, and a reset", () => {
    const onClose = () => {};
    const view = render(<ChartSettingsDialog onClose={onClose} />);
    fireEvent.change(view.getByLabelText("Font"), { target: { value: "Georgia, serif" } });
    fireEvent.change(view.getByLabelText("Title size"), { target: { value: "20" } });
    fireEvent.change(view.getByLabelText("Axis label size"), { target: { value: "3" } });
    fireEvent.change(view.getByLabelText("Label size"), { target: { value: "18" } });
    fireEvent.click(view.getByLabelText("Legend"));
    expect(readChartSettings().text).toMatchObject({
      fontFamily: "Georgia, serif",
      titleFontSize: 20,
      axisFontSize: 12,
      labelFontSize: 18,
      legend: false,
    });
    fireEvent.change(view.getByLabelText("Chart"), { target: { value: "graph" } });
    fireEvent.click(view.getByLabelText("Node labels"));
    fireEvent.click(view.getByLabelText("Edge labels"));
    expect(readChartSettings().types.graph).toMatchObject({ labels: true, edgeLabels: true });
    fireEvent.change(view.getByLabelText("Chart"), { target: { value: "bar" } });
    fireEvent.click(view.getByLabelText("Gridlines"));
    expect(readChartSettings().types.bar?.gridlines).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Reset" }));
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(view.getByRole("button", { name: "Dismiss chart settings" }));
    fireEvent.click(view.getByRole("dialog", { name: "Chart settings" }));
  });

  test("closes from the backdrop, the close button, and escape", () => {
    let closed = 0;
    const view = render(
      <ChartSettingsDialog
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    fireEvent.click(view.getByRole("dialog", { name: "Chart settings" }));
    expect(closed).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Dismiss chart settings" }));
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(3);
  });
});
