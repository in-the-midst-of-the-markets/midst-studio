import { describe, expect, test } from "bun:test";
import type { DataDictionary } from "@/lib/data-dictionary";
import type { ProviderCapabilities } from "@/lib/db/types";
import { loadAssistSchema } from "@/lib/ai/assist-schema";
import type { DatabaseConnection } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  createdAt: new Date(0),
};

const dictionary: DataDictionary = {
  connectionId: "c1",
  notes: "Prefer orders.",
  tables: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const tableKind = { id: "table", role: "relation" as const, label: "Table", labelPlural: "Tables" };

function caps(partial: Partial<ProviderCapabilities>): ProviderCapabilities {
  return partial as ProviderCapabilities;
}

interface Step {
  readonly ok?: boolean;
  readonly status?: number;
  readonly body?: unknown;
  readonly throwJson?: boolean;
}

function scripted(steps: readonly Step[]) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let index = 0;
  const post = async (path: string, init?: RequestInit) => {
    const step = steps[index] ?? { ok: false, status: 500, body: {} };
    index += 1;
    const parsed: unknown = init?.body === undefined ? {} : JSON.parse(String(init.body));
    calls.push({
      path,
      body:
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {},
    });
    return {
      ok: step.ok ?? true,
      status: step.status ?? (step.ok === false ? 500 : 200),
      json: async () => {
        if (step.throwJson) throw new Error("bad json");
        return step.body ?? null;
      },
    };
  };
  return { post, calls };
}

const orders = {
  objects: [{ name: "orders", kind: "table", path: ["public", "orders"] }],
  details: [{ path: ["public", "orders"], columns: [{ name: "id", type: "int" }], indexes: [] }],
};

describe("loadAssistSchema", () => {
  test("keeps saved notes when the connection does not list tables", async () => {
    const { post, calls } = scripted([]);
    const loaded = await loadAssistSchema({ ...connection, skipObjectScan: true }, dictionary, post, null);
    expect(calls).toHaveLength(0);
    expect(loaded.note).toContain("does not list its tables");
    expect(loaded.schemaContext).toContain("Prefer orders.");
  });

  test("reports a metadata failure, including one with no JSON", async () => {
    const failed = scripted([{ ok: false, status: 503, body: { error: "offline" } }]);
    const loaded = await loadAssistSchema(connection, null, failed.post, null);
    expect(loaded.note).toBe("offline");
    expect(loaded.schemaContext).toBe("[]");

    const blank = scripted([{ ok: false, body: { error: "   " }, throwJson: false }]);
    expect((await loadAssistSchema(connection, null, blank.post, null)).note).toContain("Could not read");

    const thrown = scripted([{ ok: false, throwJson: true }]);
    expect((await loadAssistSchema(connection, null, thrown.post, null)).note).toContain("Could not read");
  });

  test("reports a database that did not describe itself", async () => {
    const missing = scripted([{ body: {} }]);
    expect((await loadAssistSchema(connection, null, missing.post, null)).note).toBe(
      "The database did not describe itself.",
    );
    const empty = scripted([{ body: { capabilities: null } }]);
    expect((await loadAssistSchema(connection, null, empty.post, null)).note).toBe(
      "The database did not describe itself.",
    );
  });

  test("reports a relation kind whose names are withheld", async () => {
    const { post } = scripted([
      { body: { capabilities: caps({ objectKinds: [{ ...tableKind, machineNames: "withheld" }] }) } },
    ]);
    const loaded = await loadAssistSchema(connection, null, post, null);
    expect(loaded.note).toContain("withheld");
  });

  test("sends notes and no inventory when nothing is a table", async () => {
    const { post, calls } = scripted([{ body: { capabilities: caps({ objectKinds: [] }) } }]);
    const loaded = await loadAssistSchema(connection, dictionary, post, null);
    expect(calls).toHaveLength(1);
    expect(loaded.note).toBeNull();
    expect(loaded.schemaContext).toContain("Prefer orders.");
  });

  test("reads a flat catalog", async () => {
    const { post, calls } = scripted([
      { body: { capabilities: caps({ objectKinds: [tableKind] }) } },
      { body: orders },
    ]);
    const loaded = await loadAssistSchema(connection, null, post, null);
    expect(calls[1]?.path).toBe("/api/db/objects/inventory");
    expect(calls[1]?.body.kinds).toEqual(["table"]);
    expect(calls[1]?.body.containers).toBeUndefined();
    expect(loaded.schemaContext).toContain("orders");
    expect(loaded.note).toBeNull();
  });

  test("uses an empty detail list when the inventory omits one", async () => {
    const { post } = scripted([
      { body: { capabilities: caps({ objectKinds: [tableKind] }) } },
      { body: { objects: orders.objects } },
    ]);
    const loaded = await loadAssistSchema(connection, null, post, null);
    expect(loaded.schemaContext).toContain("orders");
  });

  test("reports an inventory that failed or is unreadable", async () => {
    const capabilities = { body: { capabilities: caps({ objectKinds: [tableKind] }) } };
    const failed = scripted([capabilities, { ok: false, body: { error: "no tables" } }]);
    expect((await loadAssistSchema(connection, null, failed.post, null)).note).toBe("no tables");

    const thrown = scripted([capabilities, { throwJson: true }]);
    expect((await loadAssistSchema(connection, null, thrown.post, null)).note).toBe("The catalog could not be read.");

    const shaped = scripted([capabilities, { body: { objects: "no" } }]);
    expect((await loadAssistSchema(connection, null, shaped.post, null)).note).toBe("The catalog could not be read.");

    const missing = scripted([capabilities, { body: { details: [] } }]);
    expect((await loadAssistSchema(connection, null, missing.post, null)).note).toBe("The catalog could not be read.");
  });

  test("scopes a server to the remembered database, then its schemas", async () => {
    const capabilities = caps({
      objectKinds: [tableKind],
      catalogSessions: true,
      containerLevels: [{ id: "catalog", label: "Database", labelPlural: "Databases" }],
    });
    const listed = [
      { name: "other", path: ["other"], level: 0 },
      { name: "app", path: ["app"], level: 0 },
    ];
    const schemas = [{ name: "public", path: ["app", "public"], level: 1 }];
    const { post, calls } = scripted([
      { body: { capabilities } },
      { body: listed },
      { body: schemas },
      { body: orders },
    ]);
    const loaded = await loadAssistSchema(connection, null, post, "app");
    expect(calls[2]?.body.parent).toEqual(["app"]);
    expect(calls[3]?.body.containers).toEqual([["app", "public"]]);
    expect(loaded.schemaContext).toContain("orders");
  });

  test("falls back to the first database and reports an empty server", async () => {
    const capabilities = caps({
      objectKinds: [tableKind],
      catalogSessions: true,
      containerLevels: [{ id: "catalog", label: "Database", labelPlural: "Databases" }],
    });
    const first = scripted([
      { body: { capabilities } },
      { body: [{ name: "app", path: ["app"], level: 0 }] },
      { body: [] },
      { body: orders },
    ]);
    const loaded = await loadAssistSchema(connection, null, first.post, "missing");
    expect(first.calls[2]?.body.parent).toEqual(["app"]);
    expect(loaded.note).toBeNull();

    const empty = scripted([{ body: { capabilities } }, { body: [] }]);
    expect((await loadAssistSchema(connection, dictionary, empty.post, null)).note).toBe(
      "This server has no database to read.",
    );

    const refused = scripted([{ body: { capabilities } }, { ok: false, body: { error: "no list" } }]);
    expect((await loadAssistSchema(connection, null, refused.post, null)).note).toBe("no list");

    const schemas = scripted([
      { body: { capabilities } },
      { body: [{ name: "app", path: ["app"], level: 0 }] },
      { ok: false, body: {} },
    ]);
    expect((await loadAssistSchema(connection, null, schemas.post, null)).note).toContain("Could not list schemas");
  });

  test("scopes a two-level catalog and falls back when that listing fails", async () => {
    const capabilities = caps({
      objectKinds: [tableKind],
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });
    const top = [{ name: "app", path: ["app"], level: 0, isSessionDefault: true }];
    const children = [{ name: "public", path: ["app", "public"], level: 1 }];
    const scoped = scripted([{ body: { capabilities } }, { body: top }, { body: children }, { body: orders }]);
    const loaded = await loadAssistSchema(connection, null, scoped.post, null);
    expect(scoped.calls[3]?.body.containers).toEqual([["app", "public"]]);
    expect(loaded.schemaContext).toContain("orders");

    const noDefault = scripted([
      { body: { capabilities } },
      { body: [{ name: "app", path: ["app"], level: 0 }] },
      { body: orders },
    ]);
    await loadAssistSchema(connection, null, noDefault.post, null);
    expect(noDefault.calls[2]?.body.containers).toBeUndefined();

    const topFails = scripted([{ body: { capabilities } }, { ok: false }, { body: orders }]);
    await loadAssistSchema(connection, null, topFails.post, null);
    expect(topFails.calls[2]?.path).toBe("/api/db/objects/inventory");

    const childFails = scripted([{ body: { capabilities } }, { body: top }, { ok: false }, { body: orders }]);
    await loadAssistSchema(connection, null, childFails.post, null);
    expect(childFails.calls[3]?.body.containers).toBeUndefined();

    const noChildren = scripted([{ body: { capabilities } }, { body: top }, { body: [] }, { body: orders }]);
    await loadAssistSchema(connection, null, noChildren.post, null);
    expect(noChildren.calls[3]?.body.containers).toBeUndefined();

    const thrown = scripted([{ body: { capabilities } }, { throwJson: true }, { body: orders }]);
    await loadAssistSchema(connection, null, thrown.post, null);
    expect(thrown.calls[2]?.path).toBe("/api/db/objects/inventory");
  });
});
