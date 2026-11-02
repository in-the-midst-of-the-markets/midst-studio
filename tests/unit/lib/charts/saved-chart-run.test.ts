import { describe, expect, test } from "bun:test";
import { chartTheme } from "@/lib/charts/palette";
import { loadSavedChart, optionForSavedChart } from "@/lib/charts/saved-chart-run";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  createdAt: new Date("2026-01-01"),
};

const result: QueryResult = {
  rows: [{ region: "east", total: 2 }],
  fields: ["region", "total"],
  rowCount: 1,
  executionTime: 4,
};

const ok = async () => ({ ok: true, json: async () => result });

describe("saved chart run", () => {
  test("a chart without a query or a connection does not ask the database", async () => {
    expect(await loadSavedChart({ query: "  " }, [connection], ok)).toEqual({
      kind: "empty",
      message: "Save this chart with a query to fill it.",
    });
    expect(await loadSavedChart({ query: "SELECT 1" }, [connection], ok)).toEqual({
      kind: "empty",
      message: "This chart has no connection.",
    });
    expect(await loadSavedChart({ query: "SELECT 1", connectionId: "" }, [connection], ok)).toEqual({
      kind: "empty",
      message: "This chart has no connection.",
    });
    expect(await loadSavedChart({ query: "SELECT 1", connectionId: "missing" }, [connection], ok)).toEqual({
      kind: "error",
      message: "That connection is no longer available.",
    });
  });

  test("a failed query is the message, and a result is the rows", async () => {
    expect(
      await loadSavedChart({ query: "SELECT 1", connectionId: "c1" }, [connection], async () => {
        throw new Error("down");
      }),
    ).toEqual({ kind: "error", message: "The query could not be sent." });
    expect(
      await loadSavedChart({ query: "SELECT 1", connectionId: "c1" }, [connection], async () => ({
        ok: false,
        json: async () => ({ error: "refused" }),
      })),
    ).toEqual({ kind: "error", message: "refused" });
    expect(await loadSavedChart({ query: "SELECT 1", connectionId: "c1" }, [connection], ok)).toEqual({
      kind: "result",
      result,
    });
    let sent = "";
    await loadSavedChart(
      { query: "SELECT region FROM sales WHERE region = {{region:east|east,west}}", connectionId: "c1" },
      [connection],
      async (_path, init) => {
        sent = String(JSON.parse(String(init?.body)).sql);
        return ok();
      },
    );
    expect(sent).toBe("SELECT region FROM sales WHERE region = 'east'");
  });

  test("builds an option from the shelves, or nothing when they cannot draw", () => {
    expect(optionForSavedChart({ name: "Revenue" }, result)).toBeNull();
    expect(optionForSavedChart({ name: "Revenue", typeId: "bar" }, result)).toBeNull();
    const drawn = optionForSavedChart(
      {
        name: "Revenue",
        typeId: "bar",
        variationId: "basic",
        selection: { category: ["region"], values: ["total"] },
      },
      result,
      chartTheme("light"),
    );
    if (drawn === null) throw new Error("expected a chart");
    expect(drawn.option.title).toBeUndefined();
    expect((drawn.option.legend as { top: number }).top).toBe(4);
    expect((drawn.option.grid as { top: number }).top).toBe(40);
    expect(optionForSavedChart({ name: "Revenue", typeId: "bar", variationId: "basic" }, result)).toBeNull();
    const titled = optionForSavedChart(
      {
        name: "Revenue",
        title: "By region",
        typeId: "bar",
        variationId: "basic",
        selection: { category: ["region"], values: ["total"] },
      },
      result,
    );
    if (titled === null) throw new Error("expected a titled chart");
    expect(titled.option.title).toBeUndefined();
    expect(
      optionForSavedChart(
        { name: "Revenue", typeId: "bar", variationId: "nope", selection: { category: ["region"], values: ["total"] } },
        result,
      ),
    ).toBeNull();
    const shelves = {
      name: "Revenue",
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["region"], values: ["total"] },
    };
    const plain = optionForSavedChart(shelves, result, chartTheme("dark"));
    if (plain === null) throw new Error("expected a chart");
    const palette = plain.option.color as string[];
    const painted = optionForSavedChart(
      {
        ...shelves,
        look: {
          color: ["#9546de", ...palette.slice(1)],
          series: [{ itemStyle: { color: "#9546de" } }],
          title: { text: "Daily_Active_Users by date", left: "center" },
          legend: { top: 28 },
          grid: { top: 64 },
          filters: { region: { control: "slider", min: 0, max: 10 } },
        },
      },
      result,
      chartTheme("dark"),
    );
    if (painted === null) throw new Error("expected a painted chart");
    expect((painted.option.color as string[])[0]).toBe("#9546de");
    expect((painted.option.series as { itemStyle?: { color?: string } }[])[0]?.itemStyle?.color).toBe("#9546de");
    expect(painted.option.filters).toBeUndefined();
    expect((painted.option.title as { text: string }).text).toBe("Daily_Active_Users by date");
    expect((painted.option.legend as { top: number }).top).toBe(28);
    expect((painted.option.grid as { top: number }).top).toBe(64);
    expect(
      optionForSavedChart({ ...shelves, look: { color: ["#112233"] } }, result, chartTheme("dark"))?.option.title,
    ).toBeUndefined();
    expect((painted.option.series as { data?: unknown }[])[0]?.data).toEqual(
      (plain.option.series as { data?: unknown }[])[0]?.data,
    );
    expect(optionForSavedChart({ ...shelves, look: {} }, result, chartTheme("dark"))?.option.color).toEqual(palette);
    expect(
      optionForSavedChart(
        { ...shelves, variationId: "nope", look: { color: ["#9546de"] } },
        result,
        chartTheme("dark"),
      ),
    ).toBeNull();
  });
});
