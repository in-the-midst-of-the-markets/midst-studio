import { describe, expect, test } from "bun:test";
import { chartTheme } from "@/lib/charts/palette";
import { loadSavedChart, optionForSavedChart } from "@/lib/charts/saved-chart-run";
import { crossDbJoinsConnection } from "@/lib/saved-join/connection";
import type { DatabaseConnection, QueryResult, SavedQuery } from "@/lib/types";

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

  test("Cross_DB_Joins runs the saved queries", async () => {
    const join = crossDbJoinsConnection();
    const saved: SavedQuery = {
      id: "q1",
      name: "Orders",
      tableId: "orders",
      query: "SELECT id FROM sales",
      connectionType: "postgres",
      connectionId: "c1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    let path = "";
    let body: { sql?: string; size?: string; saved?: { name?: string; connection?: { id?: string } }[] } = {};
    const view = await loadSavedChart(
      { query: "SELECT id FROM orders", connectionId: join.id },
      [join, connection],
      async (sent, init) => {
        path = sent;
        body = JSON.parse(String(init?.body)) as typeof body;
        return ok();
      },
      [saved],
    );
    expect(path).toBe("/api/db/saved-join");
    expect(body.sql).toBe("SELECT id FROM orders");
    expect(body.size).toBe("small");
    expect(body.saved?.[0]?.name).toBe("orders");
    expect(body.saved?.[0]?.connection?.id).toBe("c1");
    expect(view).toEqual({ kind: "result", result });
  });

  test("builds an option from the shelves, or nothing when they cannot draw", () => {
    expect(optionForSavedChart({}, result)).toBeNull();
    expect(optionForSavedChart({ typeId: "bar" }, result)).toBeNull();
    const drawn = optionForSavedChart(
      {
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
    expect(optionForSavedChart({ typeId: "bar", variationId: "basic" }, result)).toBeNull();
    // A name and a title on the saved chart are not part of the draw input. The plot stays untitled.
    const withTitle = {
      name: "Revenue",
      title: "By region",
      typeId: "bar",
      variationId: "basic",
      selection: { category: ["region"], values: ["total"] },
    };
    const titled = optionForSavedChart(withTitle, result);
    if (titled === null) throw new Error("expected a titled chart");
    expect(titled.option.title).toBeUndefined();
    expect(
      optionForSavedChart(
        { typeId: "bar", variationId: "nope", selection: { category: ["region"], values: ["total"] } },
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
    expect(painted.option.title).toBeUndefined();
    expect((painted.option.legend as { top: number }).top).toBe(4);
    expect((painted.option.grid as { top: number }).top).toBe(40);
    const light = chartTheme("light");
    const themed = optionForSavedChart(
      {
        ...shelves,
        look: {
          color: ["#9546de"],
          textStyle: { color: "#ffffff" },
          legend: { textStyle: { color: "#ffffff" } },
          yAxis: { splitLine: { lineStyle: { color: "#222222" } } },
          xAxis: { axisLine: { lineStyle: { color: "#222222" } } },
        },
      },
      result,
      light,
    );
    if (themed === null) throw new Error("expected a themed chart");
    expect((themed.option.color as string[])[0]).toBe("#9546de");
    expect((themed.option.textStyle as { color: string }).color).toBe(light.ink);
    expect((themed.option.legend as { textStyle: { color: string } }).textStyle.color).toBe(light.ink);
    expect((themed.option.yAxis as { splitLine: { lineStyle: { color: string } } }).splitLine.lineStyle.color).toBe(
      light.grid,
    );
    expect((themed.option.xAxis as { axisLine: { lineStyle: { color: string } } }).axisLine.lineStyle.color).toBe(
      light.grid,
    );
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
