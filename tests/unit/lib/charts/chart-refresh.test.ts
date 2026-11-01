import { describe, expect, test } from "bun:test";
import { MIN_CHART_REFRESH_SECONDS, readRefreshText, refreshDelayMs } from "@/lib/charts/chart-refresh";

describe("chart refresh", () => {
  test("a blank field is off and a short count is raised to 60 seconds", () => {
    expect(readRefreshText("")).toEqual({ ok: true, raised: false });
    expect(readRefreshText("  ")).toEqual({ ok: true, raised: false });
    expect(readRefreshText("30")).toEqual({ ok: true, seconds: MIN_CHART_REFRESH_SECONDS, raised: true });
    expect(readRefreshText("0")).toEqual({ ok: true, seconds: MIN_CHART_REFRESH_SECONDS, raised: true });
    expect(readRefreshText("90")).toEqual({ ok: true, seconds: 90, raised: false });
    expect(readRefreshText("60")).toEqual({ ok: true, seconds: 60, raised: false });
    expect(readRefreshText("1.5")).toEqual({ ok: false, error: "Refresh must be a whole number of seconds." });
    expect(readRefreshText("soon")).toEqual({ ok: false, error: "Refresh must be a whole number of seconds." });
  });

  test("the timer waits at least 60 seconds and is absent when the chart does not refresh", () => {
    expect(refreshDelayMs(undefined)).toBeNull();
    expect(refreshDelayMs(Number.NaN)).toBeNull();
    expect(refreshDelayMs(0)).toBeNull();
    expect(refreshDelayMs(-5)).toBeNull();
    expect(refreshDelayMs(30)).toBe(60_000);
    expect(refreshDelayMs(90.9)).toBe(90_000);
  });
});
