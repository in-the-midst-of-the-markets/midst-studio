import { describe, expect, test } from "bun:test";
import { ASSIST_SCHEMA_CAP } from "@/lib/ai/assist-plan";
import { assistDatabaseType, composeAssistCatalog, loadAssistCatalog } from "@/lib/ai/assist-catalog";

describe("assistDatabaseType", () => {
  test("is empty with no connection and when the engines differ", () => {
    expect(assistDatabaseType([])).toBe("");
    expect(assistDatabaseType(["postgres", "mysql"])).toBe("");
  });

  test("names the engine every connection shares", () => {
    expect(assistDatabaseType(["postgres"])).toBe("postgres");
    expect(assistDatabaseType(["postgres", "postgres"])).toBe("postgres");
  });
});

describe("composeAssistCatalog", () => {
  test("joins each connection's tables and keeps a note beside its name", () => {
    const catalog = composeAssistCatalog([
      { id: "c1", name: "Orders", engine: "postgres", schemaContext: '[{"name":"orders"}]', note: "Prefer orders." },
      { id: "c2", name: "Logs", engine: "mysql", schemaContext: "[]", note: "   " },
      { id: "c3", name: "Cache", engine: "redis", schemaContext: "{}", note: null },
      { id: "c4", name: "Broken", engine: "sqlite", schemaContext: "{", note: null },
    ]);
    const parsed = JSON.parse(catalog.schemaContext) as { connection: string; objects?: unknown[]; note?: string }[];
    expect(parsed.map((item) => item.connection)).toEqual(["Orders", "Logs", "Cache", "Broken"]);
    expect(parsed[0]?.objects).toEqual([{ name: "orders" }]);
    expect(parsed[2]?.note).toBe("The table list could not be read.");
    expect(parsed[3]?.note).toBe("The table list could not be read.");
    expect(catalog.notes).toEqual(["Orders: Prefer orders."]);
    expect(catalog.byConnection.c1).toContain("orders");
    expect(catalog.byConnection.c2).toBe("[]");
  });

  test("drops tables that do not fit and gives up when the names alone do not fit", () => {
    const wide = composeAssistCatalog([
      {
        id: "c1",
        name: "Orders",
        engine: "postgres",
        schemaContext: JSON.stringify(["x".repeat(ASSIST_SCHEMA_CAP)]),
        note: null,
      },
      { id: "c2", name: "Logs", engine: "mysql", schemaContext: "[]", note: null },
    ]);
    const parsed = JSON.parse(wide.schemaContext) as { connection: string; objects: unknown[]; note?: string }[];
    expect(parsed[0]?.objects).toEqual([]);
    expect(parsed[0]?.note).toContain("left out");
    expect(parsed[1]?.objects).toEqual([]);
    expect(wide.notes.some((note) => note.startsWith("Orders:"))).toBe(true);

    const names = "n".repeat(ASSIST_SCHEMA_CAP);
    const overflow = composeAssistCatalog([
      { id: "c1", name: names, engine: "postgres", schemaContext: "[]", note: null },
      { id: "c2", name: names, engine: "mysql", schemaContext: "[]", note: null },
    ]);
    expect(overflow.schemaContext).toBe("[]");
    expect(overflow.notes.at(-1)).toBe("The connected databases did not fit in one question.");
  });
});

describe("loadAssistCatalog", () => {
  test("reads every connection and keeps going when one read throws", async () => {
    const catalog = await loadAssistCatalog(
      [
        { id: "c1", name: "Orders", type: "postgres" },
        { id: "c2", name: "Logs", type: "mysql" },
      ],
      async (connection) => {
        if (connection.id === "c2") throw new Error("offline");
        return { schemaContext: '[{"name":"orders"}]', note: null };
      },
    );
    expect(catalog.byConnection.c1).toContain("orders");
    expect(catalog.byConnection.c2).toBe("[]");
    expect(catalog.notes).toEqual(["Logs: Could not read the database."]);
    expect(catalog.schemaContext).toContain("Orders");
    expect(catalog.schemaContext).toContain("Logs");
  });

  test("is empty when nothing is connected", async () => {
    const catalog = await loadAssistCatalog([], async () => ({ schemaContext: "[]", note: null }));
    expect(catalog).toEqual({ schemaContext: "[]", notes: [], byConnection: {} });
  });
});
