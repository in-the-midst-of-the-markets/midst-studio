import { describe, expect, test } from "bun:test";
import {
  defaultFilterLooks,
  mergeFilterLooks,
  readFilterLooks,
  shownFilterControl,
  sliderRange,
  withFilterLooks,
  withoutFilterLooks,
  type FilterLook,
} from "@/lib/charts/filter-look";
import type { QueryFilter } from "@/lib/charts/query-filters";

const revenue: QueryFilter = { name: "revenue", value: "10", options: [], compare: ">=" };
const region: QueryFilter = { name: "region", value: "east", options: ["east", "west"], compare: "=" };
const note: QueryFilter = { name: "note", value: "hello", options: [], compare: "=" };
const count: QueryFilter = { name: "count", value: "4", options: [], compare: "=" };

describe("filter looks", () => {
  test("reads a look from chart code and ignores anything else", () => {
    expect(readFilterLooks(null).size).toBe(0);
    expect(readFilterLooks(undefined).size).toBe(0);
    expect(readFilterLooks({}).size).toBe(0);
    expect(readFilterLooks({ filters: [] }).size).toBe(0);
    expect(readFilterLooks({ filters: { revenue: null, region: { control: "dial" } } }).size).toBe(0);
    const looks = readFilterLooks({
      filters: {
        revenue: { control: "slider", min: 0, max: 20, step: 1 },
        region: { control: "text", min: "0", max: Number.NaN },
        broken: "slider",
      },
    });
    expect(looks.get("revenue")).toEqual({ control: "slider", min: 0, max: 20, step: 1 });
    expect(looks.get("region")).toEqual({ control: "text", min: null, max: null, step: null });
    expect(looks.has("broken")).toBe(false);
  });

  test("defaults, merges, and writes looks without touching an option that has none", () => {
    const defaults = defaultFilterLooks([revenue, region, note], ["revenue"]);
    expect(defaults.get("revenue")?.control).toBe("number");
    expect(defaults.get("region")?.control).toBe("select");
    expect(defaults.get("note")?.control).toBe("text");
    const edited = readFilterLooks({ filters: { revenue: { control: "slider", max: 5 }, other: { control: "text" } } });
    const merged = mergeFilterLooks(defaults, edited);
    expect(merged.get("revenue")).toEqual({ control: "slider", min: null, max: 5, step: null });
    expect(merged.get("region")?.control).toBe("select");
    expect(merged.has("other")).toBe(false);

    const bare = { title: { text: "Revenue" } };
    expect(withFilterLooks(bare, new Map())).toBe(bare);
    const cleared = withFilterLooks({ ...bare, filters: { revenue: { control: "text" } } }, new Map());
    expect(cleared.filters).toBeUndefined();
    expect(withoutFilterLooks(bare)).toBe(bare);
    const written = withFilterLooks(bare, merged);
    const revenueLook = (written.filters as { revenue: FilterLook }).revenue;
    expect(revenueLook).toEqual({ control: "slider", max: 5 });
    expect((written.filters as { region: { control: string } }).region).toEqual({ control: "select" });
    expect(withoutFilterLooks(written).filters).toBeUndefined();
    expect(withoutFilterLooks(written).title).toEqual({ text: "Revenue" });
  });

  test("a slider needs a number, a select needs choices, and the range fits the value", () => {
    const slider: FilterLook = { control: "slider", min: null, max: null, step: null };
    expect(shownFilterControl(revenue, true, undefined)).toBe("number");
    expect(shownFilterControl(region, false, undefined)).toBe("select");
    expect(shownFilterControl(note, false, undefined)).toBe("text");
    expect(shownFilterControl(note, false, { control: "text", min: null, max: null, step: null })).toBe("text");
    expect(shownFilterControl(region, false, { control: "select", min: null, max: null, step: null })).toBe("select");
    expect(shownFilterControl(note, false, { control: "select", min: null, max: null, step: null })).toBe("text");
    expect(shownFilterControl(count, false, { control: "number", min: null, max: null, step: null })).toBe("number");
    expect(shownFilterControl(note, false, { control: "number", min: null, max: null, step: null })).toBe("text");
    expect(shownFilterControl(note, true, { control: "number", min: null, max: null, step: null })).toBe("number");
    expect(shownFilterControl(revenue, true, slider)).toBe("slider");
    expect(shownFilterControl(note, false, slider)).toBe("text");
    expect(shownFilterControl(region, false, slider)).toBe("select");

    expect(sliderRange(slider, "10")).toEqual({ min: 0, max: 10, step: 1 });
    expect(sliderRange(slider, "-3")).toEqual({ min: -3, max: 7, step: 1 });
    expect(sliderRange(slider, "nope")).toEqual({ min: 0, max: 10, step: 1 });
    expect(sliderRange({ control: "slider", min: 0, max: 5, step: 0 }, "10")).toEqual({ min: 0, max: 10, step: 1 });
    expect(sliderRange({ control: "slider", min: 4, max: 4, step: -2 }, "4")).toEqual({ min: 4, max: 14, step: 1 });
    expect(sliderRange({ control: "slider", min: 2, max: 9, step: 0.5 }, "1")).toEqual({ min: 1, max: 9, step: 0.5 });
  });
});
