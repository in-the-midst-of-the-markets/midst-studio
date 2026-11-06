import { describe, expect, test } from "bun:test";
import {
  chartPublicId,
  chartTokenFor,
  ensureChartToken,
  filterPublicId,
  isChartToken,
} from "@/lib/dashboards/public-id";

describe("dashboard public ids", () => {
  test("gives a filter and a chart an id, and keeps a chart id that is already stored", () => {
    expect(filterPublicId()).toMatch(/^id_[a-f0-9]{10}$/);
    expect(chartPublicId()).toMatch(/^c_[a-f0-9]{10}$/);
    expect(isChartToken(undefined)).toBe(false);
    expect(isChartToken("c_abc")).toBe(false);
    expect(isChartToken("c_abc1234567")).toBe(true);

    expect(chartTokenFor("c_abc1234567", "c_ffff000011")).toBe("c_abc1234567");
    expect(chartTokenFor("nope", "c_abc1234567")).toBe("c_abc1234567");
    expect(chartTokenFor(undefined, "short")).toMatch(/^c_[a-f0-9]{10}$/);

    const kept = { token: "c_abc1234567", name: "Revenue" };
    expect(ensureChartToken(kept)).toBe(kept);
    const named: { name: string; token?: string } = { name: "Revenue" };
    expect(ensureChartToken(named).token).toMatch(/^c_[a-f0-9]{10}$/);
    const invalid = { token: "nope" };
    expect(ensureChartToken(invalid).token).toMatch(/^c_[a-f0-9]{10}$/);
  });
});
