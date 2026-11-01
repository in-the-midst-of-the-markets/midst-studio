import { describe, expect, test } from "bun:test";
import { runAssistQuery } from "@/lib/ai/assist-query";
import type { DatabaseConnection } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  createdAt: new Date(0),
};

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
    expect(body).toEqual({ sql: "SELECT 1", connection: JSON.parse(JSON.stringify(connection)) });
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
