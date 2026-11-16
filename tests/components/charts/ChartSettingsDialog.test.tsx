import "../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChartSettingsDialog } from "@/components/charts/ChartSettingsDialog";
import {
  CHART_COLOR_LIMIT,
  DEFAULT_CHART_SETTINGS,
  normalizeChartSettings,
  readChartSettings,
  writeChartSettings,
} from "@/lib/charts/chart-settings";
import { chartTheme } from "@/lib/charts/palette";

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

  test("saves a background, a font color, and up to eight chart colors", () => {
    const view = render(<ChartSettingsDialog onClose={() => {}} />);
    const light = chartTheme("light");
    fireEvent.click(view.getByLabelText("Background"));
    expect(readChartSettings().colors.background).toBe(light.exportBackground);
    fireEvent.change(view.getByLabelText("Background color"), { target: { value: "#112233" } });
    expect(readChartSettings().colors.background).toBe("#112233");
    fireEvent.click(view.getByLabelText("Background"));
    expect(readChartSettings().colors.background).toBe("");
    expect(view.queryByLabelText("Background color")).toBeNull();

    fireEvent.click(view.getByLabelText("Font color"));
    expect(readChartSettings().colors.font).toBe(light.ink);
    fireEvent.change(view.getByLabelText("Font color value"), { target: { value: "#ABCDEF" } });
    expect(readChartSettings().colors.font).toBe("#abcdef");

    fireEvent.click(view.getByRole("button", { name: "Add chart color" }));
    const first = chartTheme("dark").series[0] ?? "";
    expect(readChartSettings().colors.series).toEqual([first]);
    fireEvent.change(view.getByLabelText("Chart color 1"), { target: { value: first.toUpperCase() } });
    expect(readChartSettings().colors.series).toEqual([first]);
    for (let count = 1; count < CHART_COLOR_LIMIT; count += 1) {
      fireEvent.click(view.getByRole("button", { name: "Add chart color" }));
    }
    expect(readChartSettings().colors.series).toEqual([...chartTheme("dark").series]);
    expect(view.queryByRole("button", { name: "Add chart color" })).toBeNull();
    fireEvent.change(view.getByLabelText("Chart color 2"), { target: { value: first } });
    expect(readChartSettings().colors.series[1]).toBe(chartTheme("dark").series[1]);
    fireEvent.change(view.getByLabelText("Chart color 1"), { target: { value: "#00ff00" } });
    expect(readChartSettings().colors.series[0]).toBe("#00ff00");
    fireEvent.click(view.getByRole("button", { name: "Remove chart color 1" }));
    expect(readChartSettings().colors.series[0]).toBe(chartTheme("dark").series[1]);
    expect(readChartSettings().colors.series).toHaveLength(CHART_COLOR_LIMIT - 1);

    fireEvent.click(view.getByRole("button", { name: "Reset" }));
    expect(readChartSettings()).toBe(DEFAULT_CHART_SETTINGS);
  });

  test("a drag keeps the color input and a saved color from outside still lands", () => {
    const view = render(<ChartSettingsDialog onClose={() => {}} />);
    fireEvent.click(view.getByLabelText("Background"));
    const input = view.getByLabelText("Background color") as HTMLInputElement;
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (proto?.set === undefined || proto.get === undefined) throw new Error("color input value is missing");
    let writes = 0;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => proto.get?.call(input),
      set: (next: string) => {
        writes += 1;
        proto.set?.call(input, next);
      },
    });

    fireEvent.change(input, { target: { value: "#112233" } });
    expect(writes).toBe(0);
    expect(input.isConnected).toBe(true);
    expect(readChartSettings().colors.background).toBe("#112233");
    fireEvent.blur(input);
    expect(writes).toBe(0);

    act(() => {
      writeChartSettings(
        normalizeChartSettings({
          ...readChartSettings(),
          colors: { ...readChartSettings().colors, background: "#abcdef" },
        }),
      );
    });
    expect(input.value).toBe("#abcdef");
    expect(writes).toBe(1);

    fireEvent.click(view.getByRole("button", { name: "Add chart color" }));
    fireEvent.click(view.getByRole("button", { name: "Add chart color" }));
    const swatch = view.getByLabelText("Chart color 1") as HTMLInputElement;
    const first = readChartSettings().colors.series[0] ?? "";
    const second = readChartSettings().colors.series[1] ?? "";
    fireEvent.change(swatch, { target: { value: second } });
    expect(swatch.isConnected).toBe(true);
    expect(readChartSettings().colors.series[0]).toBe(first);
    fireEvent.blur(swatch);
    expect(swatch.value).toBe(first);
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
