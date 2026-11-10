import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { IntercomProvider, intercomApiHost, intercomToken } from "@/lib/db/providers/sql/intercom";
import { INTERCOM_ENTITIES, INTERCOM_PAGE_SIZE } from "@/lib/db/providers/sql/intercom/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "ic",
  name: "ic",
  type: "intercom",
  password: "intercom-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: { url: string; method: string; body?: string }[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: { url: string; method: string; body?: string }[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, body: request.body });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? JSON.stringify(next.body ?? {});
        return { status: next.status ?? 200, contentType: "application/json", retryAfter: null, text };
      },
      close() {
        closed.count += 1;
      },
    };
  };
  return { createTransport, requests, options, closed };
}

const me = { type: "admin", id: "1", name: "Ada", email: "ada@example.com" };

function contact(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, email: `${id}@example.com`, name: id, ...extra };
}

describe("IntercomProvider", () => {
  test("requires a token and a pinned host", () => {
    expect(() => new IntercomProvider(connection)).not.toThrow();
    expect(
      () => new IntercomProvider({ ...connection, password: "census", database: "census", host: "api.intercom.io" }),
    ).not.toThrow();
    expect(() => new IntercomProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "intercom-token-value\r\nX-Injected: 1";
    expect(() => new IntercomProvider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      intercomToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("intercom-token");
    }
    expect(() => intercomToken({ ...connection, password: "x".repeat(1018) })).toThrow(/single line/);
    expect(intercomApiHost(connection)).toBe("api.intercom.io");
    expect(intercomApiHost({ ...connection, host: " https://api.intercom.io/me " })).toBe("api.intercom.io");
    expect(intercomApiHost({ ...connection, host: "http://API.EU.INTERCOM.IO" })).toBe("api.eu.intercom.io");
    expect(intercomApiHost({ ...connection, host: "api.au.intercom.io" })).toBe("api.au.intercom.io");
    expect(intercomApiHost({ ...connection, host: "   " })).toBe("api.intercom.io");
    expect(intercomApiHost({ ...connection, host: "api.intercom.io:443" })).toBe("api.intercom.io");
    for (const host of ["evil.example", "https://intercom-token-value@evil.example", "app.intercom.io"]) {
      expect(() => new IntercomProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        intercomApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("intercom.io");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("app.intercom");
        expect(message).not.toContain("intercom-token");
      }
    }
  });

  test("probes the workspace and refuses a write before a request", async () => {
    const probe = scripted([{ body: me }]);
    const opened = new IntercomProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://api.intercom.io/me");
    expect(probe.requests[0]?.method).toBe("GET");
    expect(probe.options[0]?.origin).toEqual({ scheme: "https", host: "api.intercom.io", port: 443 });
    expect(probe.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "api.intercom.io" });
    expect(probe.options[0]?.refusesLinkLocal).toBe(true);
    expect(probe.options[0]?.refusesUpgrade).toBe(true);
    expect(probe.options[0]?.headers.Authorization).toBe("Bearer intercom-token-value");
    expect(probe.options[0]?.headers.Accept).toBe("application/json");
    expect(probe.options[0]?.headers["Intercom-Version"]).toBe("2.17");
    expect(await opened.listContainers()).toEqual([{ path: ["workspace"], name: "workspace", level: 0 }]);
    expect(await opened.listContainers(["workspace"])).toEqual([]);
    expect(await opened.countObjects(["workspace"])).toEqual({ table: { count: INTERCOM_ENTITIES.length } });
    const names = (await opened.listObjects(["workspace"], "table")).map((object) => object.name);
    expect(names).toContain("Contacts");
    const detail = await opened.describeObject(["workspace", "Contacts"], "table");
    expect(detail.columns.find((column) => column.name === "id")).toMatchObject({
      nullable: false,
      isPrimary: true,
      type: "varchar",
    });
    expect(detail.columns.find((column) => column.name === "created_at")).toMatchObject({ type: "bigint" });
    expect(detail.columns.find((column) => column.name === "owner_id")).toMatchObject({ type: "double" });
    expect(detail.columns.find((column) => column.name === "unsubscribed_from_emails")).toMatchObject({
      type: "boolean",
    });
    expect(detail.foreignKeys).toEqual([]);
    expect((await opened.describeObjects(["workspace"], "table")).details).toHaveLength(INTERCOM_ENTITIES.length);
    expect((await opened.describeObjects(["workspace"], "table", 1)).details).toHaveLength(1);
    await expect(opened.describeObjects(["workspace"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["workspace"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["workspace", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["workspace", "extra"], "table")).rejects.toThrow(QueryError);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({ version: "Intercom API", tableCount: INTERCOM_ENTITIES.length });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO Contacts (email) VALUES ('a@b.c')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT email FROM Contacts", ["x"])).rejects.toThrow(/bind parameters/);
    const regional = scripted([{ body: me }]);
    const europe = new IntercomProvider({ ...connection, host: "api.eu.intercom.io" }, {}, regional.createTransport);
    await europe.connect();
    expect(regional.options[0]?.origin).toEqual({ scheme: "https", host: "api.eu.intercom.io", port: 443 });
    const moved = scripted([{ body: me }, { body: { data: [] } }]);
    const switched = new IntercomProvider({ ...connection }, {}, moved.createTransport);
    await switched.connect();
    switched.config.password = "intercom-token-other";
    await switched.query("SELECT id FROM Contacts");
    expect(moved.options[1]?.headers.Authorization).toBe("Bearer intercom-token-other");
    await opened.disconnect();
    expect(probe.closed.count).toBe(1);
    await expect(opened.query("SELECT email FROM Contacts")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    const blank = scripted([{ body: [] }]);
    const refused = new IntercomProvider(connection, {}, blank.createTransport);
    await expect(refused.connect()).rejects.toThrow(/not a list/);
    expect(blank.closed.count).toBe(1);
  });

  test("searches, pages, filters the small lists, and counts", async () => {
    const row = JSON.parse(
      '{"id":"1","Email":"ada@example.com","name":"Ada","owner_id":2,"created_at":1577836800,"source":{"type":"email","author":{"id":"9"}},"tags":[{"id":"t"}],"__proto__":"nope"}',
    ) as Record<string, unknown>;
    const page = Array.from({ length: INTERCOM_PAGE_SIZE }, (_, index) => contact(String(index)));
    const probe = scripted([
      { body: me },
      { body: { data: [row, null], total_count: 1 } },
      { body: { data: [] } },
      {
        body: {
          data: page,
          pages: { next: { starting_after: "cursor-2" } },
        },
      },
      { body: { data: [contact("tail")], pages: { next: { starting_after: "" } } } },
      { body: { data: [], total_count: 42 } },
      {
        body: {
          admins: [
            { id: "1", name: "Ada", email: "a@e.com", away_mode_enabled: true },
            { id: "2", name: "Bea", email: "b@e.com", away_mode_enabled: false },
            { id: "3", name: 12, email: true },
          ],
        },
      },
      {
        body: {
          data: [
            { id: "1", name: "Alpha" },
            { id: "2", name: "Beta" },
            { id: "3" },
            { id: "4", name: true },
            { id: "5", name: 12 },
            { id: "6", name: { nested: true } },
          ],
        },
      },
      { body: { data: [contact("cap")], pages: { next: { starting_after: "more" } } } },
      {
        body: {
          conversations: [{ id: "c1", state: "open", open: true, "source.type": "email" }],
          total_count: 3,
        },
      },
      {
        body: {
          data: [
            { id: "1", name: "Alpha" },
            { id: "2", name: "Beta" },
            { id: "4", name: true },
            { id: "5", name: 12 },
          ],
        },
      },
    ]);
    const opened = new IntercomProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const selected = await opened.query(
      "SELECT email, phone, owner_id FROM Contacts WHERE email = 'ada@example.com' AND owner_id = 2 AND owner_id != 9 AND owner_id < 9 AND owner_id <= 5 AND owner_id > 1 AND owner_id >= 2 AND created_at = '2020-01-01' ORDER BY owner_id DESC LIMIT 2",
    );
    expect(selected.rows[0]).toMatchObject({ email: "ada@example.com", phone: null, owner_id: 2 });
    expect(JSON.stringify(selected.rows[0])).not.toContain("nope");
    expect(probe.requests[1]?.method).toBe("POST");
    expect(probe.requests[1]?.url).toBe("https://api.intercom.io/contacts/search");
    expect(probe.requests[1]?.body).toContain('"operator":"="');
    expect(probe.requests[1]?.body).toContain('"field":"email"');
    const wide = await opened.query("SELECT * FROM Contacts LIMIT 1");
    expect(wide.fields).toContain("id");
    expect(wide.rowCount).toBe(0);
    const paged = await opened.query("SELECT * FROM Contacts LIMIT 60");
    expect(paged.rows).toHaveLength(51);
    expect(paged.rows[0]?.email).toBe("0@example.com");
    expect(probe.requests.filter((request) => request.url.includes("/contacts"))).toHaveLength(4);
    expect(probe.requests[3]?.url).toContain("per_page=50");
    expect(probe.requests[4]?.url).toContain("starting_after=cursor-2");
    const counted = await opened.query("SELECT COUNT(*) FROM Contacts");
    expect(counted.rows).toEqual([{ totalCount: 42 }]);
    const admins = await opened.query(
      "SELECT name FROM Admins WHERE away_mode_enabled = true AND away_mode_enabled != false ORDER BY name DESC",
    );
    expect(admins.rows[0]).toEqual({ name: "Ada" });
    const tags = await opened.query(
      "SELECT name FROM Tags WHERE name != 'Beta' AND name LIKE 'A%' AND name LIKE '%a' AND name LIKE '%ph%' AND name LIKE 'Alpha' AND name < 'M' AND name <= 'M' AND name > 'A' AND name >= 'A' ORDER BY name LIMIT 1 OFFSET 0",
    );
    expect(tags.rows).toEqual([{ name: "Alpha" }]);
    const capped = await opened.query("SELECT id FROM Contacts LIMIT 5000");
    expect(capped.warnings?.map((warning) => warning.message).join(" ")).toContain("1000");
    const beforePast = probe.requests.length;
    const past = await opened.query("SELECT id FROM Contacts OFFSET 1000");
    expect(past.rows).toEqual([]);
    expect(past.warnings?.[0]?.message).toContain("OFFSET");
    expect(probe.requests).toHaveLength(beforePast);
    const conversations = await opened.query("SELECT COUNT(*) FROM Conversations WHERE state = 'open'");
    expect(conversations.rows).toEqual([{ totalCount: 3 }]);
    expect(probe.requests.at(-1)?.url).toContain("/conversations/search");
    const named = await opened.query("SELECT name FROM Tags ORDER BY name DESC");
    expect(named.rows.map((row) => row.name)).toEqual([true, "Beta", "Alpha", 12]);
  });

  test("sorts a capped read, walks a count, and filters nulls", async () => {
    const full = {
      data: Array.from({ length: 1000 }, (_, index) => contact(String(index), { owner_id: index, name: null })),
      pages: { next: { starting_after: "more" } },
    };
    const admins = {
      admins: [{ id: "1", name: "Ada", away_mode_enabled: true }, { id: "2", away_mode_enabled: false }, { id: "3" }],
    };
    const contacts = {
      data: [
        { id: "1", owner_id: 2, email: "a@e.com" },
        { id: "2", email: "b@e.com" },
        { id: "3", owner_id: "nope", email: "c@e.com" },
        { id: "4" },
        { id: "5", owner_id: 5, email: "d@e.com" },
      ],
      total_count: 4,
    };
    const probe = scripted([
      { body: me },
      { body: full },
      { body: { data: Array.from({ length: 1000 }, () => contact("a")), pages: { next: { starting_after: "more" } } } },
      { body: { data: [contact("only")], pages: { next: { starting_after: "same" } } } },
      {
        body: {
          data: Array.from({ length: INTERCOM_PAGE_SIZE }, () => contact("a")),
          pages: { next: { starting_after: "same" } },
        },
      },
      {
        body: {
          data: Array.from({ length: INTERCOM_PAGE_SIZE }, () => contact("b")),
          pages: { next: { starting_after: "same" } },
        },
      },
      { body: admins },
      { body: contacts },
      { body: contacts },
      { body: admins },
      { body: { data: Array.from({ length: 60 }, (_, index) => contact(String(index))) } },
      {
        body: {
          conversations: [{ id: "1", open: true, source: { type: "email", author: { id: "9" } }, tags: [{ id: "t" }] }],
        },
      },
    ]);
    const opened = new IntercomProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const ordered = await opened.query("SELECT id FROM Contacts ORDER BY email LIMIT 10");
    expect(ordered.rows).toHaveLength(10);
    expect(ordered.warnings?.map((warning) => warning.message).join(" ")).toContain("ordered 1000");
    const counted = await opened.query("SELECT COUNT(*) FROM Contacts");
    expect(counted.rows).toEqual([{ totalCount: 1000 }]);
    expect(counted.warnings?.[0]?.message).toContain("counted 1000");
    const walked = await opened.query("SELECT COUNT(*) FROM Contacts");
    expect(walked.rows).toEqual([{ totalCount: 1 }]);
    expect(walked.warnings).toEqual([]);
    const repeated = await opened.query("SELECT COUNT(*) FROM Contacts");
    expect(repeated.rows).toEqual([{ totalCount: INTERCOM_PAGE_SIZE * 2 }]);
    const byFlag = await opened.query(
      "SELECT name FROM Admins WHERE away_mode_enabled = false ORDER BY away_mode_enabled",
    );
    expect(byFlag.rows.map((row) => row.name)).toEqual([null]);
    const byOwner = await opened.query(
      "SELECT id FROM Contacts WHERE owner_id > 1 AND owner_id != 9 ORDER BY owner_id DESC",
    );
    expect(byOwner.rows.map((row) => row.id)).toEqual(["5", "1"]);
    const byNull = await opened.query("SELECT id FROM Contacts ORDER BY owner_id");
    expect(byNull.rows.map((row) => row.id)).toEqual(["1", "5", "2", "3", "4"]);
    const adminsCounted = await opened.query("SELECT COUNT(*) FROM Admins WHERE away_mode_enabled = false");
    expect(adminsCounted.rows).toEqual([{ totalCount: 1 }]);
    const trimmed = await opened.query("SELECT id FROM Contacts LIMIT 10");
    expect(trimmed.rows).toHaveLength(10);
    const flat = await opened.query("SELECT * FROM Conversations LIMIT 5");
    expect(flat.rows[0]).toMatchObject({ id: "1", "source.type": "email" });
    expect(String(flat.rows[0]?.["source.author"])).toContain("9");
    expect(String(flat.rows[0]?.tags)).toContain("t");
  });

  test("turns a bad answer into a typed error and never repeats the token", async () => {
    const token = "intercom-token-value";
    const cases: ScriptedPage[] = [
      { status: 401, body: { message: `expired ${token}` } },
      { status: 403, body: { errors: [{ message: "forbidden" }] } },
      { status: 429, body: { message: token } },
      { status: 500, text: "" },
      { status: 400, body: { message: "" } },
      { status: 400, body: { errors: [{ message: "" }] } },
      { status: 400, body: { errors: ["nope"] } },
      { status: 400, body: { errors: [{ code: "nope" }] } },
      { status: 302, body: { message: "away" } },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { text: "not-json" },
      { status: 400, text: `bad-json ${token}` },
      { body: { data: { bad: true } } },
      { body: { message: "no list" } },
      { throw: new TransportError("redirect", "moved") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${token}`) },
      { throw: new DatabaseConfigError("kept", "intercom") },
      { throw: "boom" },
      { throw: new Error(`lost ${token}`) },
    ];
    const probe = scripted([{ body: me }, ...cases]);
    const opened = new IntercomProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const run = () => opened.query("SELECT id FROM Contacts");
    await expect(run()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(run()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(run()).rejects.toThrow(/limiting requests/);
    await expect(run()).rejects.toThrow(/answered 500/);
    await expect(run()).rejects.toThrow(/answered 400/);
    await expect(run()).rejects.toThrow(/answered 400/);
    await expect(run()).rejects.toThrow(/answered 400/);
    await expect(run()).rejects.toThrow(/answered 400/);
    await expect(run()).rejects.toThrow(/redirect/);
    await expect(run()).rejects.toThrow(/2 MB/);
    await expect(run()).rejects.toThrow(/not a list/);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("bad-json");
      expect(message).not.toContain(token);
    }
    await expect(run()).rejects.toThrow(/not a list/);
    await expect(run()).rejects.toThrow(/not a list/);
    await expect(run()).rejects.toThrow(/redirect/);
    await expect(run()).rejects.toThrow(/2 MB/);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(token);
      expect(message).toContain("••••");
    }
    await expect(run()).rejects.toThrow(/kept/);
    await expect(run()).rejects.toThrow(/could not be reached/);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(token);
    }
  });
});
