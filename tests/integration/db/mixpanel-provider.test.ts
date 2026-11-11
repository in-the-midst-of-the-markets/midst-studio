import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { MixpanelProvider } from "@/lib/db/providers/sql/mixpanel";
import { MIXPANEL_SQL_GRAMMAR } from "@/lib/db/providers/sql/mixpanel/sql-grammar";
import { mixpanelAuthorization, mixpanelHost, readMixpanelProjectId } from "@/lib/db/providers/sql/mixpanel/auth";
import {
  MIXPANEL_RESOURCES,
  mixpanelCall,
  mixpanelEntries,
  mixpanelHasMore,
} from "@/lib/db/providers/sql/mixpanel/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "mp",
  name: "mp",
  type: "mixpanel",
  host: "",
  user: "service-account",
  database: "1234567",
  password: "service-secret",
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
  requests: NodeRequest[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: NodeRequest[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push(request);
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

function provider(pages: ScriptedPage[], config: Partial<DatabaseConnection> = {}) {
  const wire = scripted(pages);
  const engine = new MixpanelProvider({ ...connection, ...config }, {}, wire.createTransport);
  return { engine, ...wire };
}

const probe = { events: [{ event: "Sign Up", amount: 4, percent_change: 0.5 }], type: "general" };

describe("MixpanelProvider", () => {
  test("probes today's events and reads one page without putting the secret in the URL", async () => {
    const wire = provider([
      { body: probe },
      { body: { events: [{ event: "Sign Up", amount: 4, percent_change: -0.2 }], type: "general" } },
    ]);
    await wire.engine.connect();
    await wire.engine.connect();
    const result = await wire.engine.query(
      "SELECT event.name, event.count FROM event WHERE event.name = 'Sign Up' ORDER BY event.count DESC LIMIT 10",
    );
    expect(result.rows).toEqual([{ "event.name": "Sign Up", "event.count": 4 }]);
    expect(result.fields).toEqual(["event.name", "event.count"]);
    expect(wire.requests).toHaveLength(2);
    expect(wire.requests[0]?.url).toContain("https://mixpanel.com/api/query/events/top");
    expect(wire.requests[0]?.url).toContain("limit=1");
    expect(wire.requests[0]?.url).toContain("project_id=1234567");
    expect(wire.requests[0]?.url).not.toContain("service-secret");
    expect(wire.requests[0]?.headers?.authorization).toBe(mixpanelAuthorization("service-account", "service-secret"));
    expect(wire.requests[1]?.url).toContain("limit=100");
    expect(wire.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "mixpanel.com" });
    await wire.engine.disconnect();
    expect(wire.closed.count).toBe(1);
  });

  test("sends the secret only to an allowed residency host", () => {
    expect(mixpanelHost({ ...connection, host: "" })).toBe("mixpanel.com");
    expect(mixpanelHost({ ...connection, host: "eu.mixpanel.com" })).toBe("eu.mixpanel.com");
    expect(mixpanelHost({ ...connection, host: "IN.MIXPANEL.COM." })).toBe("in.mixpanel.com");
    expect(() => mixpanelHost({ ...connection, host: "evil.example" })).toThrow(DatabaseConfigError);
    expect(() => mixpanelHost({ ...connection, host: "https://user:pass@mixpanel.com" })).toThrow(EXACT);
    expect(() => mixpanelHost({ ...connection, host: "mixpanel.com:443" })).toThrow(DatabaseConfigError);
    expect(() => mixpanelHost({ ...connection, host: "mixpanel.com/extra" })).toThrow(DatabaseConfigError);
    expect(() => mixpanelHost({ ...connection, host: "mixpanel.com?x=1" })).toThrow(DatabaseConfigError);
    expect(() => new MixpanelProvider({ ...connection, user: "" })).toThrow(/service account username/i);
    expect(() => new MixpanelProvider({ ...connection, password: "" })).toThrow(/secret/i);
    expect(() => new MixpanelProvider({ ...connection, database: "" })).toThrow(/project id/i);
    expect(() => new MixpanelProvider({ ...connection, database: "0" })).toThrow(/whole number/i);
    expect(() => new MixpanelProvider({ ...connection, user: "a:b" })).toThrow(/colon/i);
    expect(() => new MixpanelProvider({ ...connection, user: "has space" })).toThrow(/printable/i);
    expect(() => new MixpanelProvider({ ...connection, password: "short" })).toThrow(/printable/i);
    expect(() => new MixpanelProvider({ ...connection, user: "a".repeat(201) })).toThrow(/larger/i);
    expect(() => new MixpanelProvider({ ...connection, password: "b".repeat(301) })).toThrow(/larger/i);
    expect(readMixpanelProjectId("42")).toBe("42");
  });

  test("reads annotations and cohorts, and warns when the page is full", async () => {
    const events = Array.from({ length: 100 }, (_, index) => ({
      event: `E${index}`,
      amount: index,
      percent_change: 0,
    }));
    const wire = provider(
      [
        { body: probe },
        { body: { status: "ok", results: [{ id: 7, date: "2026-01-02", description: "Launch" }] } },
        {
          body: [
            { id: 1000, name: "Cohort One", count: 150, created: "2019-03-19 23:49:51", is_visible: 1 },
            { id: 2000, name: "Hidden", count: 2, created: "2019-04-02 23:22:01", is_visible: 0 },
          ],
        },
        { body: { events, type: "general" } },
      ],
      { host: "eu.mixpanel.com" },
    );
    await wire.engine.connect();
    const notes = await wire.engine.query("SELECT * FROM annotation");
    expect(notes.rows).toEqual([
      { "annotation.id": 7, "annotation.date": "2026-01-02", "annotation.description": "Launch" },
    ]);
    expect(wire.requests[1]?.method).toBe("GET");
    expect(wire.requests[1]?.url).toBe("https://eu.mixpanel.com/api/app/projects/1234567/annotations");
    const cohorts = await wire.engine.query(
      "SELECT cohort.name, cohort.visible FROM cohort WHERE cohort.visible = 'yes'",
    );
    expect(cohorts.rows).toEqual([{ "cohort.name": "Cohort One", "cohort.visible": "yes" }]);
    expect(wire.requests[2]?.method).toBe("POST");
    expect(wire.requests[2]?.url).toContain("/api/query/cohorts/list?project_id=1234567");
    const full = await wire.engine.query("SELECT event.name FROM event");
    expect(full.rows).toHaveLength(100);
    expect(full.warnings?.[0]?.message).toContain("one page");
  });

  test("does not call the API for an offset past the page, and refuses writes and parameters", async () => {
    const wire = provider([{ body: probe }]);
    await wire.engine.connect();
    const empty = await wire.engine.query("SELECT event.name FROM event LIMIT 10 OFFSET 100");
    expect(empty.rows).toEqual([]);
    expect(empty.warnings?.[0]?.message).toContain("OFFSET");
    expect(wire.requests).toHaveLength(1);
    await expect(wire.engine.query("DELETE FROM event")).rejects.toThrow(QueryError);
    await expect(wire.engine.query("SELECT event.name FROM event", ["x"])).rejects.toThrow(/bind parameters/i);
    await expect(wire.engine.runMaintenance()).rejects.toThrow(/maintenance/i);
    expect(await wire.engine.getOverview()).toMatchObject({ version: "Mixpanel Query API", tableCount: 3 });
    expect(await wire.engine.listContainers(["project"])).toEqual([]);
    expect(await wire.engine.listContainers()).toEqual([{ path: ["project"], name: "project", level: 0 }]);
    expect(wire.engine.getLabels().entityName).toBe("Table");
    expect(await wire.engine.getHealth()).toMatchObject({ databaseSize: "N/A", cacheHitRatio: "N/A" });
    expect(await wire.engine.getPerformanceMetrics()).toEqual({});
    expect(await wire.engine.getSlowQueries()).toEqual([]);
    expect(await wire.engine.getActiveSessions()).toEqual([]);
    expect(await wire.engine.getTableStats()).toEqual([]);
    expect(await wire.engine.getIndexStats()).toEqual([]);
    expect(await wire.engine.getStorageStats()).toEqual([]);
    expect(await wire.engine.countObjects(["project"])).toEqual({ table: { count: MIXPANEL_RESOURCES.length } });
    expect((await wire.engine.listObjects(["project"], "table")).map((item) => item.name)).toEqual([
      "event",
      "annotation",
      "cohort",
    ]);
    const detail = await wire.engine.describeObject(["project", "event"], "table");
    expect(detail.columns[0]).toMatchObject({ name: "event.name", isPrimary: true, nullable: false });
    await expect(wire.engine.describeObject(["project", "missing"], "table")).rejects.toThrow(/no table/i);
    await expect(wire.engine.listObjects(["project"], "view")).rejects.toThrow(/object kind/);
    await expect(wire.engine.describeObjects(["project"], "table", 0)).rejects.toThrow(/positive whole number/);
    expect((await wire.engine.describeObjects(["project"], "table", 1)).details).toHaveLength(1);
  });

  test("maps auth, permission, rate limit, redirect and a body that is not a list", async () => {
    const denied = provider([{ status: 401, body: { error: "bad service-secret" } }]);
    await expect(denied.engine.connect()).rejects.toThrow(/bad ••••/);
    const forbidden = provider([{ status: 403, body: { message: "nope" } }]);
    await expect(forbidden.engine.connect()).rejects.toBeInstanceOf(PermissionDeniedError);
    const limited = provider([{ status: 429, body: { error: "slow down" } }]);
    await expect(limited.engine.connect()).rejects.toThrow(/limiting requests/i);
    const redirect = provider([{ status: 302, text: "" }]);
    await expect(redirect.engine.connect()).rejects.toBeInstanceOf(ConnectionError);
    const broken = provider([{ text: "not-json" }]);
    await expect(broken.engine.connect()).rejects.toThrow(/not a list/i);
    const empty = provider([{ text: "" }]);
    await expect(empty.engine.connect()).rejects.toThrow(/not a list/i);
    const shape = provider([{ body: { type: "general" } }]);
    await expect(shape.engine.connect()).rejects.toThrow(/not a list/i);
    const down = provider([{ status: 500, text: "service-secret exploded" }]);
    await expect(down.engine.connect()).rejects.toThrow(QueryError);
    await expect(down.engine.connect()).rejects.not.toThrow(/service-secret/);
    const described = provider([{ status: 400, body: { error_description: "from date is required" } }]);
    await expect(described.engine.connect()).rejects.toThrow(/from date/i);
    const long = provider([{ status: 400, body: { error: "e".repeat(400) } }]);
    await expect(long.engine.connect()).rejects.toThrow(/^e{300}$/);
    const longMessage = provider([{ status: 400, body: { message: "m".repeat(400) } }]);
    await expect(longMessage.engine.connect()).rejects.toThrow(/^m{300}$/);
  });

  test("turns a transport failure into a connection error and closes the socket", async () => {
    const wire = provider([{ throw: new TransportError("service-secret refused the socket") }]);
    try {
      await wire.engine.connect();
      throw new Error("connect should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error instanceof Error ? error.message : "").not.toContain("service-secret");
    }
    expect(wire.closed.count).toBe(1);
    const odd = provider([{ throw: new Error("service-secret vanished") }]);
    await expect(odd.engine.connect()).rejects.toBeInstanceOf(ConnectionError);
    const plain = provider([{ throw: "service-secret" }]);
    await expect(plain.engine.connect()).rejects.toThrow(/could not be reached/i);
    await expect(new MixpanelProvider(connection).query("SELECT event.name FROM event")).rejects.toThrow(
      /Not connected/,
    );
  });

  test("refuses a list that is not the shape that resource returns", async () => {
    const wire = provider([{ body: probe }, { body: { events: "nope" } }, { text: "" }, { text: "{" }]);
    await wire.engine.connect();
    await expect(wire.engine.query("SELECT event.name FROM event")).rejects.toThrow(/not a list/i);
    await expect(wire.engine.query("SELECT annotation.id FROM annotation")).rejects.toThrow(/not a list/i);
    await expect(wire.engine.query("SELECT cohort.id FROM cohort")).rejects.toThrow(/not a list/i);
    expect(mixpanelCall("nope", "1").path).toBe("/");
    expect(() => mixpanelEntries("nope", [])).toThrow(QueryError);
    expect(mixpanelHasMore("event", null)).toBe(false);
    expect(() => mixpanelHost({ ...connection, host: "https://[" })).toThrow(DatabaseConfigError);
    const kept = provider([{ throw: new QueryError("kept", "mixpanel") }]);
    await expect(kept.engine.connect()).rejects.toThrow(/kept/);
    const format = MIXPANEL_SQL_GRAMMAR.completion.formatSegment;
    const readQuoted = MIXPANEL_SQL_GRAMMAR.completion.readQuotedQualifier;
    if (format == null || readQuoted == null) throw new Error("Mixpanel completion is missing a quoter");
    expect(format('a"b')).toBe('"a""b"');
    expect(readQuoted('"Event".')).toBe("Event");
    expect(readQuoted("event.")).toBeUndefined();
    expect(mixpanelEntries("annotation", {})).toEqual([]);
    expect(mixpanelEntries("event", { events: [null] })).toEqual([null]);
  });
});

const EXACT = /mixpanel\.com, eu\.mixpanel\.com, or in\.mixpanel\.com/;
