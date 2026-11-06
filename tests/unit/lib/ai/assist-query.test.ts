import { describe, expect, test } from "bun:test";
import { connectionForAssistQuery, rebindAssistCard, runAssistQuery } from "@/lib/ai/assist-query";
import type { DatabaseConnection } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  createdAt: new Date(0),
};

describe("connectionForAssistQuery", () => {
  const orders = { id: "c1", name: "Orders" };
  const logs = { id: "c2", name: "Logs" };

  test("uses the only connection when a query does not name one", () => {
    const blank = connectionForAssistQuery([orders], "");
    const spaced = connectionForAssistQuery([orders], "   ");
    expect(blank.ok && blank.connection).toEqual(orders);
    expect(spaced.ok && spaced.connection).toEqual(orders);
  });

  test("matches a name or an id without regard to case", () => {
    const byName = connectionForAssistQuery([orders, logs], "logs");
    const byId = connectionForAssistQuery([orders, logs], "C1");
    expect(byName.ok && byName.connection).toEqual(logs);
    expect(byId.ok && byId.connection).toEqual(orders);
  });

  test("refuses a missing database, a missing name, and a shared name", () => {
    expect(connectionForAssistQuery([], "Orders")).toEqual({
      ok: false,
      error: "Connect a database in Traditional mode to run this query.",
    });
    expect(connectionForAssistQuery([orders, logs], "")).toEqual({
      ok: false,
      error: "Name the connected database this query should use.",
    });
    expect(connectionForAssistQuery([orders, logs], "Warehouse")).toEqual({
      ok: false,
      error: "No connected database is named Warehouse. The connected databases are Orders, Logs.",
    });
    expect(connectionForAssistQuery([orders, { id: "c3", name: "Orders" }], "Orders")).toEqual({
      ok: false,
      error: "More than one connected database is named Orders.",
    });
  });

  test("a renamed database is the only connection, or the one whose table the statement names", () => {
    expect(connectionForAssistQuery([orders], "Warehouse")).toEqual({ ok: true, connection: orders });
    const hinted = connectionForAssistQuery([orders, logs], "Warehouse", {
      sql: 'SELECT * FROM public."Orders" JOIN logs',
      schemas: {
        c1: JSON.stringify([{ name: "Orders" }, { name: "  " }, null, { name: 4 }, "row"]),
        c2: JSON.stringify({ name: "Orders" }),
      },
    });
    expect(hinted).toEqual({ ok: true, connection: orders });
    const shared = connectionForAssistQuery([orders, logs], "Warehouse", {
      sql: "SELECT * FROM orders",
      schemas: { c1: JSON.stringify([{ name: "orders" }]), c2: JSON.stringify([{ name: "orders" }]) },
    });
    expect(shared).toEqual({
      ok: false,
      error: "No connected database is named Warehouse. The connected databases are Orders, Logs.",
    });
    const unnamed = connectionForAssistQuery([orders, logs], "Warehouse", {
      sql: 'SELECT * FROM orders JOIN ""',
      schemas: { c1: "not json" },
    });
    expect(unnamed.ok).toBe(false);
  });
});

describe("rebindAssistCard", () => {
  const orders = { id: "c1", name: "Orders" };
  const logs = { id: "c2", name: "Logs" };
  const card = {
    connectionId: "gone",
    connectionName: "Warehouse",
    error: "No connected database is named Warehouse.",
    sql: "SELECT 1",
  };

  test("keeps a chart whose connection is still there, including a new name", () => {
    const current = { connectionId: "c1", connectionName: "Orders", error: null };
    expect(rebindAssistCard([orders], current)).toBe(current);
    const renamed = rebindAssistCard([{ id: "c1", name: "Markets" }], {
      connectionId: "c1",
      connectionName: "Orders",
      error: "column missing",
    });
    expect(renamed).toEqual({ connectionId: "c1", connectionName: "Markets", error: "column missing" });
  });

  test("points a removed connection at the one that replaced it and clears the stale error", () => {
    const markets = { id: "c9", name: "Markets" };
    const rebound = rebindAssistCard([markets], card);
    expect(rebound.connectionId).toBe("c9");
    expect(rebound.connectionName).toBe("Markets");
    expect(rebound.error).toBeNull();
    expect(rebound.sql).toBe("SELECT 1");
    const kept = rebindAssistCard([markets], { ...card, error: "column missing" });
    expect(kept.error).toBe("column missing");
    expect(kept.connectionId).toBe("c9");
    const connect = rebindAssistCard([markets], {
      ...card,
      error: "Connect a database in Traditional mode to run this query.",
    });
    expect(connect.error).toBeNull();
  });

  test("names the databases that are still connected when several remain", () => {
    const unresolved = rebindAssistCard([orders, logs], card);
    expect(unresolved.connectionId).toBeNull();
    expect(unresolved.error).toBe(
      "No connected database is named Warehouse. The connected databases are Orders, Logs.",
    );
    const already = { connectionId: null, connectionName: "Warehouse", error: "column missing" };
    expect(rebindAssistCard([orders, logs], already)).toBe(already);
  });
});

describe("runAssistQuery", () => {
  test("returns the rows the editor route answered", async () => {
    let body: unknown;
    const outcome = await runAssistQuery(connection, "SELECT 1", async (_path, init) => {
      body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ rows: [{ n: 1 }], fields: ["n"] }),
      };
    });
    expect(body).toEqual({
      sql: "SELECT 1",
      connection: JSON.parse(JSON.stringify(connection)),
      embeddingModel: "voyage-4",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rowCount).toBe(1);
    expect(outcome.result.executionTime).toBe(0);
  });

  test("keeps a row count and a time the route already counted", async () => {
    const outcome = await runAssistQuery(connection, "SELECT 1", async () => ({
      ok: true,
      json: async () => ({ rows: [], fields: ["n"], rowCount: 0, executionTime: 12 }),
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.executionTime).toBe(12);
  });

  test("uses the route's error, and a fallback when it has none", async () => {
    const named = await runAssistQuery(connection, "SELECT 1", async () => ({
      ok: false,
      json: async () => ({ error: "denied" }),
    }));
    expect(named).toEqual({ ok: false, error: "denied" });

    const blank = await runAssistQuery(connection, "SELECT 1", async () => ({
      ok: false,
      json: async () => ({ error: "  " }),
    }));
    expect(blank).toEqual({ ok: false, error: "The query failed." });
  });

  test("reports a result this page cannot chart", async () => {
    const outcome = await runAssistQuery(connection, "SELECT 1", async () => ({
      ok: true,
      json: async () => ({ rows: [], fields: [""] }),
    }));
    expect(outcome).toEqual({ ok: false, error: "The query returned a result this page cannot chart." });
  });

  test("reports a body that is not JSON and a request that was not sent", async () => {
    const unreadable = await runAssistQuery(connection, "SELECT 1", async () => ({
      ok: true,
      json: async () => {
        throw new Error("bad");
      },
    }));
    expect(unreadable.ok).toBe(false);

    const unsent = await runAssistQuery(connection, "SELECT 1", async () => {
      throw new Error("offline");
    });
    expect(unsent).toEqual({ ok: false, error: "The query could not be sent." });
  });
});
