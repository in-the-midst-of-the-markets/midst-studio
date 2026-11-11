import { describe, expect, test } from "bun:test";
import { chartOptionForDisplay } from "@/lib/charts/chart-html";

describe("chartOptionForDisplay", () => {
  test("drops a tooltip formatter that contains a tag and keeps a template", () => {
    const drawn = chartOptionForDisplay({
      title: { text: "a < b" },
      tooltip: { formatter: "<img src=x onerror=alert(1)>" },
      series: [{ label: { formatter: "{b}\n{c}" }, tooltip: { formatter: "<b>{c}</b>" } }],
    });
    expect(drawn.title).toEqual({ text: "a < b" });
    expect(drawn.tooltip).toEqual({});
    expect(drawn.series[0]?.label).toEqual({ formatter: "{b}\n{c}" });
    expect(drawn.series[0]?.tooltip).toEqual({});
  });

  test("keeps a function formatter and a data view title that is plain text", () => {
    const formatter = (value: string) => value;
    const drawn = chartOptionForDisplay({
      tooltip: { formatter },
      toolbox: {
        feature: {
          dataView: {
            title: "Data",
            lang: ["Data", 2, "Close"],
            optionToContent: "plain",
          },
        },
      },
    });
    expect(drawn.tooltip.formatter).toBe(formatter);
    expect(drawn.toolbox.feature.dataView.title).toBe("Data");
    expect(drawn.toolbox.feature.dataView.lang).toEqual(["Data", 2, "Close"]);
    expect(drawn.toolbox.feature.dataView.optionToContent).toBe("plain");
    expect(chartOptionForDisplay(null)).toBeNull();
    expect(chartOptionForDisplay("text")).toBe("text");
  });

  test("blanks a data view title and language string that contain a tag", () => {
    const drawn = chartOptionForDisplay({
      toolbox: {
        feature: {
          dataView: {
            title: "<img src=x onerror=alert(1)>",
            lang: ["<img src=x>", "Close"],
            optionToContent: "<div onload=alert(1)>",
          },
        },
      },
    });
    expect(drawn.toolbox.feature.dataView.title).toBe("");
    expect(drawn.toolbox.feature.dataView.lang).toEqual(["", "Close"]);
    expect(drawn.toolbox.feature.dataView).not.toHaveProperty("optionToContent");
  });
});
