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
    expect((drawn.option.title as { text: string }).text).toBe("Revenue");
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
    expect((titled.option.title as { text: string }).text).toBe("By region");
    expect(
      optionForSavedChart(
        { name: "Revenue", typeId: "bar", variationId: "nope", selection: { category: ["region"], values: ["total"] } },
        result,
      ),
    ).toBeNull();
  });
});
