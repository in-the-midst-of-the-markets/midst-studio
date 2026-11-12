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

  test("keeps a CSS color and drops one the tooltip arrow would write into HTML", () => {
    const payload = 'red"></div><img src=x onerror=alert(1)>';
    const drawn = chartOptionForDisplay({
      backgroundColor: " transparent ",
      color: ["#3987e5", payload, { formatter: "<img src=x>" }],
      tooltip: {
        backgroundColor: payload,
        borderColor: "rgba(0, 0, 0, 0.4)",
        extra: null,
      },
      series: [
        {
          itemStyle: {
            color: "hsl(210 80% 40%)",
            color0: "#111111",
            borderColor: payload,
            borderColor0: "#222222",
          },
          lineStyle: { color: "gradient" },
          label: { color: null },
        },
      ],
    });
    expect(drawn.backgroundColor).toBe("transparent");
    expect(drawn.color).toEqual(["#3987e5", {}]);
    expect(drawn.tooltip).toEqual({ borderColor: "rgba(0, 0, 0, 0.4)", extra: null });
    expect(drawn.series[0]?.itemStyle).toEqual({
      color: "hsl(210 80% 40%)",
      color0: "#111111",
      borderColor0: "#222222",
    });
    expect(drawn.series[0]?.lineStyle).toEqual({ color: "gradient" });
    expect(drawn.series[0]?.label).toEqual({ color: null });
    const gradient = chartOptionForDisplay({
      tooltip: {
        backgroundColor: {
          type: "linear",
          colorStops: [
            { offset: 0, color: payload },
            { offset: 1, color: "#ffffff" },
          ],
        },
      },
    });
    expect(gradient.tooltip.backgroundColor).toEqual({
      type: "linear",
      colorStops: [{ offset: 0 }, { offset: 1, color: "#ffffff" }],
    });
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
