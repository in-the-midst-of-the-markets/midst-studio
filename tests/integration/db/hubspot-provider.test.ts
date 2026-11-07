import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { HubSpotProvider, hubSpotApiHost, type HubSpotFetch } from "@/lib/db/providers/sql/hubspot";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "hs",
  name: "hs",
  type: "hubspot",
  password: "pat-token",
  createdAt: new Date(0),
} as DatabaseConnection;

const PROPERTIES = {
  results: [
    { name: "email", type: "string" },
    { name: "score", type: "number" },
    { name: "active", type: "bool" },
    { name: "opened", type: "date" },
    { name: "closed", type: "datetime" },
    { name: "id", type: "string" },
    { name: "note" },
    { name: "" },
    { skipped: true },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === "" ? "" : JSON.stringify(body), { status });
}

function scripted(pages: { status?: number; body?: unknown; text?: string; throw?: unknown }[]): {
  fetchImpl: HubSpotFetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: HubSpotFetch = async (url, init) => {
    calls.push({ url, init });
    const next = pages.shift();
    if (next === undefined) throw new Error(`no response for ${url}`);
    if ("throw" in next) throw next.throw;
    if (next.text !== undefined) return new Response(next.text, { status: next.status ?? 200 });
    return jsonResponse(next.status ?? 200, next.body ?? {});
  };
  return { calls, fetchImpl };
}

function propertyPages(count = 7): { body: unknown }[] {
  return Array.from({ length: count }, () => ({ body: PROPERTIES }));
}

function provider(fetchImpl: HubSpotFetch, extra: Partial<DatabaseConnection> = {}): HubSpotProvider {
  return new HubSpotProvider({ ...connection, ...extra }, {}, fetchImpl);
}

async function connected(fetchImpl: HubSpotFetch, extra: Partial<DatabaseConnection> = {}): Promise<HubSpotProvider> {
  const opened = provider(fetchImpl, extra);
  await opened.connect();
  return opened;
}

describe("HubSpotProvider", () => {
  test("requires a private app token and keeps only the API host", () => {
    expect(() => provider(async () => jsonResponse(200, {}), { password: "  " })).toThrow(DatabaseConfigError);
    expect(hubSpotApiHost(connection)).toBe("api.hubapi.com");
    expect(hubSpotApiHost({ ...connection, host: " https://eu.hubapi.com/crm " })).toBe("eu.hubapi.com");
    expect(hubSpotApiHost({ ...connection, host: "   " })).toBe("api.hubapi.com");
    for (const host of ["evil.com", "api.hubapi.com.evil.com", "https://pat-token@evil.com", "api.hubapi.com:8443"]) {
      expect(() => provider(async () => jsonResponse(200, {}), { host })).toThrow(DatabaseConfigError);
      try {
        hubSpotApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("hubapi.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("8443");
      }
    }
  });

  test("lists the CRM objects and their properties", async () => {
    const { fetchImpl, calls } = scripted(propertyPages());
    const opened = await connected(fetchImpl);
    await opened.connect();
    expect(calls).toHaveLength(7);
    expect(calls[0]?.url).toBe("https://api.hubapi.com/crm/v3/properties/contacts");
    expect(await opened.listContainers()).toEqual([{ path: ["crm"], name: "crm", level: 0 }]);
    expect(await opened.listContainers(["crm"])).toEqual([]);
    expect(await opened.countObjects(["crm"])).toEqual({ table: { count: 7 } });
    const objects = await opened.listObjects(["crm"], "table");
    expect(objects.map((object) => object.name)).toEqual([
      "contacts",
      "companies",
      "deals",
      "tickets",
      "products",
      "line_items",
      "quotes",
    ]);
    const detail = await opened.describeObject(["crm", "contacts"], "table");
    expect(detail.columns.map((column) => [column.name, column.type, column.isPrimary])).toEqual([
      ["id", "text", true],
      ["email", "text", false],
      ["score", "numeric", false],
      ["active", "boolean", false],
      ["opened", "timestamp", false],
      ["closed", "timestamp", false],
      ["note", "text", false],
    ]);
    const bulk = await opened.describeObjects(["crm"], "table");
    expect(bulk.details).toHaveLength(7);
    const truncated = await opened.describeObjects(["crm"], "table", 1);
    expect(truncated.details).toHaveLength(1);
    expect(truncated.truncated?.limit).toBe(1);
    await expect(opened.describeObjects(["crm"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["crm"], "view")).rejects.toThrow(/no object kind/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().createTable).toBeUndefined();
    expect(opened.getLabels().entityName).toBe("Object");
  });

  test("searches, counts, and writes through the CRM API", async () => {
    const record = { id: "12", properties: { email: "a@b.c", extra: "kept" } };
    const { fetchImpl, calls } = scripted([
      ...propertyPages(),
      { body: { total: 3, results: [record], paging: { next: { after: "cursor" } } } },
      { body: { results: [record] } },
      { body: { total: 10000, results: [record] } },
      { body: { results: [record] } },
      { body: record },
      { body: "" },
    ]);
    const opened = await connected(fetchImpl, { host: "eu.hubapi.com" });
    const selected = await opened.query(
      "SELECT email FROM contacts WHERE email = 'a@b.c' OR email IS NULL ORDER BY email DESC LIMIT 1",
    );
    expect(selected.rows).toEqual([{ id: "12", email: "a@b.c" }]);
    expect(selected.fields).toEqual(["id", "email"]);
    const search = JSON.parse(String(calls[7]?.init?.body)) as {
      filterGroups: { filters: { propertyName: string; operator: string; value?: string }[] }[];
      sorts: { propertyName: string; direction: string }[];
      properties: string[];
      limit: number;
    };
    expect(search.filterGroups[0]?.filters[0]).toEqual({ propertyName: "email", operator: "EQ", value: "a@b.c" });
    expect(search.filterGroups[1]?.filters[0]).toEqual({ propertyName: "email", operator: "NOT_HAS_PROPERTY" });
    expect(search.sorts).toEqual([{ propertyName: "email", direction: "DESCENDING" }]);
    expect(search.properties).toEqual(["email"]);
    expect(search.limit).toBe(1);
    expect(calls[7]?.url).toBe("https://eu.hubapi.com/crm/v3/objects/contacts/search");
    expect(String(calls[7]?.init?.headers && (calls[7]?.init?.headers as Record<string, string>).Authorization)).toBe(
      "Bearer pat-token",
    );

    const counted = await opened.query("SELECT COUNT(*) FROM CONTACTS");
    expect(counted.rows).toEqual([{ row_count: 1 }]);
    const capped = await opened.query("SELECT COUNT(*) FROM contacts");
    expect(capped.warnings?.[0]?.message).toContain("10000");

    const inserted = await opened.query("INSERT INTO contacts (email, active, note) VALUES ('a@b.c', TRUE, NULL)");
    expect(inserted.rows[0]).toMatchObject({ id: "12", email: "a@b.c" });
    const created = JSON.parse(String(calls[10]?.init?.body)) as { inputs: { properties: Record<string, string> }[] };
    expect(created.inputs[0]?.properties).toEqual({ email: "a@b.c", active: "true" });

    const updated = await opened.query("UPDATE contacts SET active = FALSE, score = 4 WHERE id = '12'");
    expect(updated.rowCount).toBe(1);
    expect(calls[11]?.init?.method).toBe("PATCH");

    const deleted = await opened.query("DELETE FROM contacts WHERE id = '12'");
    expect(deleted.rows).toEqual([{ id: "12", deleted: true }]);
    expect(calls[12]?.init?.method).toBe("DELETE");

    await expect(opened.query("SELECT * FROM missing")).rejects.toThrow(/no object/);
    await expect(opened.query("SELECT 1", ["x"])).rejects.toThrow(/bind parameters/);
  });

  test("pages until the row cap and skips a numeric offset", async () => {
    const page = (after?: string) => ({
      body: {
        total: 5000,
        results: Array.from({ length: 100 }, (_, index) => ({ id: String(index), properties: { email: "a" } })),
        ...(after === undefined ? {} : { paging: { next: { after } } }),
      },
    });
    const { fetchImpl } = scripted([
      ...propertyPages(),
      ...Array.from({ length: 10 }, (_, index) => page(String(index + 1))),
    ]);
    const opened = await connected(fetchImpl);
    const capped = await opened.query("SELECT email FROM contacts");
    expect(capped.rows).toHaveLength(1000);
    expect(capped.warnings?.[0]?.message).toContain("1000");
    const empty = await opened.query("SELECT email FROM contacts LIMIT 0");
    expect(empty.rows).toEqual([]);
    await expect(opened.query("SELECT email FROM contacts OFFSET 1000")).rejects.toThrow(/at most 1000/);
  });

  test("keeps a read-only connection on reads and reports API failures", async () => {
    const { fetchImpl } = scripted([
      ...propertyPages(),
      {
        body: {
          results: [{ id: "1", properties: { email: "a", nickname: "n" } }],
          paging: { next: { after: "" } },
          total: "x",
        },
      },
      { body: { results: [], paging: { next: { after: "more" } } } },
    ]);
    const opened = await connected(fetchImpl, { readOnly: true });
    const starred = await opened.query("SELECT * FROM contacts LIMIT 1");
    expect(starred.rowCount).toBe(1);
    expect(starred.rows[0]).toMatchObject({ id: "1", email: "a", nickname: "n" });
    expect(await opened.query("SELECT * FROM contacts LIMIT 5")).toMatchObject({ rows: [] });
    await expect(opened.query("DELETE FROM contacts WHERE id = '1'")).rejects.toThrow(/read-only/);

    const repeated = (page: { status?: number; body?: unknown; text?: string; throw?: unknown }) =>
      scripted(Array.from({ length: 7 }, () => page));
    const denied = repeated({ status: 401, body: { message: "nope" } });
    await expect(provider(denied.fetchImpl).connect()).rejects.toBeInstanceOf(AuthenticationError);
    const forbidden = repeated({ status: 403, body: { message: "nope" } });
    await expect(provider(forbidden.fetchImpl).connect()).rejects.toBeInstanceOf(PermissionDeniedError);
    const bad = repeated({ status: 400, body: {} });
    await expect(provider(bad.fetchImpl).connect()).rejects.toThrow(/answered 400/);
    const named = repeated({ status: 400, body: { message: "", error: "bad" } });
    await expect(provider(named.fetchImpl).connect()).rejects.toThrow("bad");
    const text = repeated({ status: 500, text: "down" });
    await expect(provider(text.fetchImpl).connect()).rejects.toThrow("down");
    const broken = repeated({ throw: new Error("offline") });
    await expect(provider(broken.fetchImpl).connect()).rejects.toBeInstanceOf(ConnectionError);
    const odd = repeated({ throw: "offline" });
    await expect(provider(odd.fetchImpl).connect()).rejects.toThrow(/could not be reached/);
    const shape = repeated({ body: { results: "nope" } });
    await expect(provider(shape.fetchImpl).connect()).rejects.toThrow(/object properties/);
    const unreadable = await connected(scripted([...propertyPages(), { body: { results: "nope" } }]).fetchImpl);
    await expect(unreadable.query("SELECT * FROM contacts LIMIT 1")).rejects.toThrow(/did not return records/);

    const closed = provider(scripted([]).fetchImpl);
    await expect(closed.query("SELECT * FROM contacts")).rejects.toThrow(/Not connected/);
    await expect(closed.getOverview()).rejects.toThrow(/Not connected/);
    await expect(opened.runMaintenance()).rejects.toBeInstanceOf(QueryError);
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getOverview()).toMatchObject({ version: "HubSpot CRM API", tableCount: 7 });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await opened.disconnect();
    await expect(opened.query("SELECT * FROM contacts")).rejects.toThrow(/Not connected/);
  });

  test("refuses a record the API returned without an id", async () => {
    const { fetchImpl } = scripted([...propertyPages(), { body: { results: [{ properties: {} }] } }]);
    const opened = await connected(fetchImpl);
    await expect(opened.query("SELECT * FROM contacts LIMIT 1")).rejects.toThrow(/no id/);
  });

  test("does not follow a redirect or read an oversized answer", async () => {
    const repeated = (page: { status?: number; body?: unknown; text?: string }) =>
      scripted(Array.from({ length: 7 }, () => page));
    const redirected = repeated({ status: 302, text: "go" });
    await expect(provider(redirected.fetchImpl).connect()).rejects.toThrow(/does not follow/);
    expect(redirected.calls[0]?.init?.redirect).toBe("manual");
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(provider(repeated({ text: huge }).fetchImpl).connect()).rejects.toThrow(/larger than 2 MB/);
  });

  test("does not repeat the token and skips a reserved property name", async () => {
    const token = "pat-secret-value";
    const repeated = (page: { status?: number; body?: unknown; text?: string; throw?: unknown }) =>
      scripted(Array.from({ length: 7 }, () => page));
    await expect(
      provider(repeated({ status: 400, body: { message: `bad ${token}` } }).fetchImpl, { password: token }).connect(),
    ).rejects.toThrow(/••••/);
    try {
      await provider(repeated({ throw: new Error(`down ${token}`) }).fetchImpl, { password: token }).connect();
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(token);
    }
    const properties = JSON.parse('{"email":"a@b.c","__proto__":{"polluted":true}}') as Record<string, string>;
    const { fetchImpl } = scripted([...propertyPages(), { body: { results: [{ id: "1", properties }] } }]);
    const opened = await connected(fetchImpl);
    const listed = await opened.query("SELECT * FROM contacts LIMIT 1");
    expect(listed.rows[0]).toMatchObject({ id: "1", email: "a@b.c" });
    expect(Object.hasOwn(listed.rows[0] ?? {}, "__proto__")).toBe(false);
  });
});
