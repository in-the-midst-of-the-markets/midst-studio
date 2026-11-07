import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { AirtableProvider, airtableApiHost, type AirtableFetch } from "@/lib/db/providers/sql/airtable";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "air",
  name: "air",
  type: "airtable",
  password: "pat",
  database: "appBase",
  createdAt: new Date(0),
} as DatabaseConnection;

const schema = {
  tables: [
    {
      id: "tbl1",
      name: "Tasks",
      primaryFieldId: "fld1",
      fields: [
        { id: "fld1", name: "Name", type: "singleLineText" },
        { name: "Score", type: "number" },
        { id: "fld3", name: "Done", type: "checkbox" },
        { id: "fld4", name: "When", type: "date" },
        { id: "fld5", name: "At", type: "dateTime" },
        { id: "fld6", name: "Made", type: "createdTime" },
        { id: "fld7", name: "Edited", type: "lastModifiedTime" },
        { id: "fld8", name: "Cost", type: "currency" },
        { id: "fld9", name: "Share", type: "percent" },
        { id: "fld10", name: "Stars", type: "rating" },
        { id: "fld11", name: "Span", type: "duration" },
        { id: "fld12", name: "N", type: "count" },
        { id: "fld13", name: "Auto", type: "autoNumber" },
        { id: "skip" },
        { name: "" },
      ],
    },
    { name: "Notes" },
    { id: "tbl3", name: "tasks", primaryFieldId: "", fields: [] },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === "" ? "" : JSON.stringify(body), { status });
}

function scripted(pages: { status?: number; body?: unknown; text?: string; throw?: unknown }[]): {
  fetchImpl: AirtableFetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: AirtableFetch = async (url, init) => {
    calls.push({ url, init });
    const next = pages.shift();
    if (next === undefined) throw new Error(`no response for ${url}`);
    if ("throw" in next) throw next.throw;
    if (next.text !== undefined) return new Response(next.text, { status: next.status ?? 200 });
    return jsonResponse(next.status ?? 200, next.body ?? {});
  };
  return { calls, fetchImpl };
}

function provider(fetchImpl: AirtableFetch, extra: Partial<DatabaseConnection> = {}): AirtableProvider {
  return new AirtableProvider({ ...connection, ...extra }, {}, fetchImpl);
}

async function connected(fetchImpl: AirtableFetch, extra: Partial<DatabaseConnection> = {}): Promise<AirtableProvider> {
  const opened = provider(fetchImpl, extra);
  await opened.connect();
  return opened;
}

describe("AirtableProvider", () => {
  test("requires a token and a base id, and normalizes the API host", () => {
    expect(() => new AirtableProvider({ ...connection, password: " " })).toThrow(DatabaseConfigError);
    expect(() => new AirtableProvider({ ...connection, database: "" })).toThrow(/base id/);
    expect(airtableApiHost({ ...connection, host: "https://example.airtable.com/v0" })).toBe("example.airtable.com");
    expect(airtableApiHost({ ...connection, host: "https://" })).toBe("api.airtable.com");
    expect(airtableApiHost(connection)).toBe("api.airtable.com");
  });

  test("loads the schema once and describes every field type", async () => {
    const { calls, fetchImpl } = scripted([{ body: schema }, { body: schema }]);
    const opened = await connected(fetchImpl);
    await opened.connect();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.airtable.com/v0/meta/bases/appBase/tables");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer pat" });
    const detail = await opened.describeObject(["appBase", "Tasks"], "table");
    expect(detail.columns.map((column) => [column.name, column.type, column.isPrimary])).toEqual([
      ["Name", "text", true],
      ["Score", "numeric", false],
      ["Done", "boolean", false],
      ["When", "timestamp", false],
      ["At", "timestamp", false],
      ["Made", "timestamp", false],
      ["Edited", "timestamp", false],
      ["Cost", "numeric", false],
      ["Share", "numeric", false],
      ["Stars", "numeric", false],
      ["Span", "numeric", false],
      ["N", "numeric", false],
      ["Auto", "numeric", false],
    ]);
    expect(detail.columns[0].nullable).toBe(false);
    expect(detail.columns[1].nullable).toBe(true);
    const notes = await opened.describeObject(["appBase", "Notes"], "table");
    expect(notes.columns).toEqual([]);
    expect(await opened.listContainers()).toEqual([{ path: ["appBase"], name: "appBase", level: 0 }]);
    expect(await opened.listContainers(["appBase"])).toEqual([]);
    expect(await opened.countObjects(["appBase"])).toEqual({ table: { count: 3 } });
    expect(await opened.listObjects(["appBase"], "table")).toHaveLength(3);
    const batch = await opened.describeObjects(["appBase"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated?.limit).toBe(1);
    expect((await opened.describeObjects(["appBase"], "table")).details).toHaveLength(3);
    expect(await opened.getOverview()).toMatchObject({ tableCount: 3, version: "Airtable Web API" });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toBeInstanceOf(QueryError);
    await expect(opened.describeObjects(["appBase"], "table", 0)).rejects.toBeInstanceOf(QueryError);
    await expect(opened.listObjects(["appBase"], "view")).rejects.toBeInstanceOf(QueryError);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getLabels().entityName).toBe("Table");
  });

  test("runs a select, a count, and the three writes", async () => {
    const records = [{ id: "rec1", fields: { Name: "A", Extra: 1 } }, { id: "rec2" }];
    const { calls, fetchImpl } = scripted([
      { body: schema },
      { body: { records } },
      { body: { records: [{ id: "rec1", fields: { Name: "A" } }] } },
      { body: { records: [{ id: "rec8", fields: {} }] } },
      { body: { records: [{ id: "rec9", fields: { Name: "B" } }] } },
      { body: { records: [{ id: "rec1", fields: { Name: "C" } }] } },
      { body: { records: [{ id: "rec1", deleted: true }] } },
    ]);
    const opened = await connected(fetchImpl, { host: "https://example.airtable.com/v0" });
    const selected = await opened.query(`SELECT * FROM Tasks WHERE Name = 'A' ORDER BY Name DESC LIMIT 2`);
    expect(selected.rows[0]).toMatchObject({ _id: "rec1", Name: "A", Extra: 1, Score: null });
    expect(selected.rows[1]._id).toBe("rec2");
    expect(selected.fields).toContain("Extra");
    expect(calls[1].url).toContain("example.airtable.com");
    expect(calls[1].url).toContain("filterByFormula=");
    const counted = await opened.query("SELECT COUNT(*) AS row_count FROM Tasks");
    expect(counted.rows).toEqual([{ row_count: 1 }]);
    const folded = await opened.query("SELECT Name FROM notes LIMIT 1");
    expect(folded.rows[0]._id).toBe("rec8");
    const inserted = await opened.query(`INSERT INTO Tasks (Name) VALUES ('B')`);
    expect(inserted.rows[0]).toMatchObject({ _id: "rec9", Name: "B" });
    expect(calls[4].init?.method).toBe("POST");
    expect(String(calls[4].init?.body)).toContain('"typecast":true');
    const updated = await opened.query(`UPDATE Tasks SET Name = 'C' WHERE _id = 'rec1'`);
    expect(updated.rows[0]).toMatchObject({ Name: "C" });
    expect(calls[5].init?.method).toBe("PATCH");
    const deleted = await opened.query(`DELETE FROM Tasks WHERE _id = 'rec1'`);
    expect(deleted.rows).toEqual([{ _id: "rec1", deleted: true }]);
    expect(calls[6].init?.method).toBe("DELETE");
    expect(calls[6].url).toContain("records%5B%5D=rec1");
  });

  test("pages to the cap, skips with OFFSET, and warns when more rows remain", async () => {
    const page = (offset: string | undefined) => ({
      body: {
        records: Array.from({ length: 100 }, (_, index) => ({ id: `rec${offset ?? "0"}-${index}`, fields: {} })),
        ...(offset === "done" ? {} : { offset: offset === undefined ? "1" : "done" }),
      },
    });
    const pages = [{ body: schema }, page(undefined)];
    for (let i = 0; i < 9; i += 1) pages.push(page(String(i)));
    const { fetchImpl } = scripted(pages);
    const opened = await connected(fetchImpl);
    const result = await opened.query("SELECT Name FROM Tasks");
    expect(result.rowCount).toBe(1000);
    expect(result.warnings?.[0].message).toContain("1000");
    const empty = await opened.query("SELECT Name FROM Tasks LIMIT 0");
    expect(empty.rows).toEqual([]);
    expect(empty.fields).toEqual(["_id", "Name"]);
    await expect(opened.query("SELECT Name FROM Tasks OFFSET 1000")).rejects.toThrow(/1000/);
  });

  test("a count of a full base keeps the cap warning", async () => {
    const page = (offset: string | undefined) => ({
      body: {
        records: Array.from({ length: 100 }, (_, index) => ({ id: `rec${offset ?? "0"}-${index}`, fields: {} })),
        ...(offset === "done" ? {} : { offset: offset === undefined ? "1" : "done" }),
      },
    });
    const pages = [{ body: schema }, page(undefined)];
    for (let i = 0; i < 9; i += 1) pages.push(page(String(i)));
    const opened = await connected(scripted(pages).fetchImpl);
    const counted = await opened.query("SELECT COUNT(*) FROM Tasks");
    expect(counted.rows).toEqual([{ row_count: 1000 }]);
    expect(counted.warnings?.[0].message).toContain("1000");
  });

  test("refuses a missing table, an ambiguous name, parameters, and a read-only write", async () => {
    const { fetchImpl } = scripted([{ body: schema }]);
    const opened = await connected(fetchImpl);
    await expect(opened.query("SELECT * FROM Missing")).rejects.toThrow(/no table/);
    await expect(opened.query("SELECT * FROM TASKS")).rejects.toThrow(/more than one table/);
    await expect(opened.query("SELECT * FROM Tasks", [1])).rejects.toThrow(/bind parameters/);
    const readonly = await connected(
      scripted([{ body: schema }, { body: { records: [] } }, { body: { records: [] } }]).fetchImpl,
      { readOnly: true },
    );
    await expect(readonly.query("DELETE FROM Tasks WHERE _id = 'rec1'")).rejects.toThrow(/read-only/);
    const counted = await readonly.query("SELECT COUNT(*) FROM Tasks");
    expect(counted.rows).toEqual([{ row_count: 0 }]);
    const readable = await readonly.query("SELECT Name FROM Tasks LIMIT 1");
    expect(readable.rows).toEqual([]);
  });

  test("reports auth, permission, schema, and network failures", async () => {
    await expect(connected(scripted([{ status: 401, body: { error: "nope" } }]).fetchImpl)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(
      connected(scripted([{ status: 403, body: { error: { message: "no" } } }]).fetchImpl),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(connected(scripted([{ status: 500, body: {} }]).fetchImpl)).rejects.toThrow(/answered 500/);
    await expect(connected(scripted([{ status: 500, body: [] }]).fetchImpl)).rejects.toThrow(/answered 500/);
    await expect(connected(scripted([{ text: "nope" }]).fetchImpl)).rejects.toThrow(/base schema/);
    await expect(connected(scripted([{ body: "" }]).fetchImpl)).rejects.toThrow(/base schema/);
    await expect(connected(scripted([{ body: { tables: [{ id: "x" }] } }]).fetchImpl)).rejects.toThrow(/no name/);
    await expect(connected(scripted([{ throw: new Error("down") }]).fetchImpl)).rejects.toBeInstanceOf(ConnectionError);
    await expect(connected(scripted([{ throw: "down" }]).fetchImpl)).rejects.toThrow(/could not be reached/);
    const opened = await connected(
      scripted([{ body: schema }, { body: { records: [{ fields: {} }] } }, { text: "nope" }]).fetchImpl,
    );
    await expect(opened.query("SELECT * FROM Notes")).rejects.toThrow(/no id/);
    await expect(opened.query("SELECT * FROM Notes")).rejects.toThrow(/did not return records/);
    await expect(provider(scripted([]).fetchImpl).query("SELECT * FROM Tasks")).rejects.toThrow(/Not connected/);
    await expect(provider(scripted([]).fetchImpl).listContainers()).rejects.toThrow(/Not connected/);
    const again = await connected(scripted([{ body: schema }]).fetchImpl);
    await again.disconnect();
    await expect(again.getOverview()).rejects.toThrow(/Not connected/);
  });
});
