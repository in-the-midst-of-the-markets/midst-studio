import { describe, expect, test } from "bun:test";
import { applyExternalChartCode, chartCodeChangeToApply, type ChartCodeBuffer } from "@/lib/charts/chart-code-sync";

function buffer(initial: string): ChartCodeBuffer & { writes: string[] } {
  const writes: string[] = [];
  let text = initial;
  return {
    writes,
    getValue: () => text,
    setValue: (value: string) => {
      text = value;
      writes.push(value);
    },
  };
}

describe("applyExternalChartCode", () => {
  test("does nothing without a model", () => {
    expect(applyExternalChartCode(null, "{}", false)).toBe(false);
  });

  test("leaves a keystroke in the buffer so the caret stays put", () => {
    const model = buffer("{");
    expect(applyExternalChartCode(model, "{", true)).toBe(false);
    expect(model.writes).toEqual([]);
  });

  test("skips a write of the text the buffer already holds", () => {
    const model = buffer("{}");
    expect(applyExternalChartCode(model, "{}", false)).toBe(false);
    expect(model.writes).toEqual([]);
  });

  test("writes a reset or a new result into the buffer", () => {
    const model = buffer('{"title":{"text":"Edited"}}');
    expect(applyExternalChartCode(model, '{"title":{"text":"Bar"}}', false)).toBe(true);
    expect(model.getValue()).toBe('{"title":{"text":"Bar"}}');
    expect(model.writes).toEqual(['{"title":{"text":"Bar"}}']);
  });
});

describe("chartCodeChangeToApply", () => {
  test("stores a keystroke", () => {
    expect(chartCodeChangeToApply("{", "{}")).toBe("{");
  });

  test("ignores an echo of the text already on screen", () => {
    expect(chartCodeChangeToApply("{}", "{}")).toBeNull();
  });

  test("treats an empty report as a real edit when the buffer had text", () => {
    expect(chartCodeChangeToApply(undefined, "{}")).toBe("");
  });

  test("ignores an empty report when the buffer is already empty", () => {
    expect(chartCodeChangeToApply(undefined, "")).toBeNull();
  });
});
