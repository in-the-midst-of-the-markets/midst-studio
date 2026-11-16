import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
} from "@/lib/db/errors";
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { DatadogProvider, datadogApiKey, datadogApplicationKey, datadogHost } from "@/lib/db/providers/sql/datadog";
import type { DatabaseConnection } from "@/lib/types";

const API_KEY = "datadog-api-key-value";
const APP_KEY = "datadog-app-key-value";

const connection = {
  id: "datadog",
  name: "datadog",
  type: "datadog",
  user: API_KEY,
  password: APP_KEY,
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
  requests: { url: string; method: string }[];
  options: NodeTransportOptions[];
  closed: number;
} {
  const requests: { url: string; method: string }[] = [];
  const state: { options: NodeTransportOptions[]; closed: number } = { options: [], closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options.push(options);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
        return { status: next.status ?? 200, contentType: "application/json", retryAfter: null, text };
      },
      close() {
        state.closed += 1;
      },
    };
  };
  return {
    createTransport,
    requests,
    get options() {
      return state.options;
    },
    get closed() {
      return state.closed;
    },
  };
}

const valid = { valid: true };

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("DatadogProvider", () => {
  test("sends the keys only to an official API host", () => {
    expect(() => new DatadogProvider(connection)).not.toThrow();
    expect(datadogHost(connection)).toBe("api.datadoghq.com");
    expect(datadogHost({ host: " https://API.DATADOGHQ.COM/ " })).toBe("api.datadoghq.com");
    expect(datadogHost({ host: "eu" })).toBe("api.datadoghq.eu");
    expect(datadogHost({ host: "US3" })).toBe("api.us3.datadoghq.com");
    expect(datadogHost({ host: "us5.datadoghq.com" })).toBe("api.us5.datadoghq.com");
    expect(datadogHost({ host: "ap1" })).toBe("api.ap1.datadoghq.com");
    expect(datadogHost({ host: "ap2.datadoghq.com" })).toBe("api.ap2.datadoghq.com");
    expect(datadogHost({ host: "https://uk1.datadoghq.com" })).toBe("api.uk1.datadoghq.com");
    expect(datadogHost({ host: "gov" })).toBe("api.ddog-gov.com");
    expect(datadogHost({ host: "us1-fed" })).toBe("api.ddog-gov.com");
    expect(datadogHost({ host: "us2-fed" })).toBe("api.us2.ddog-gov.com");
    expect(datadogHost({ host: "api.us2.ddog-gov.com." })).toBe("api.us2.ddog-gov.com");
    expect(datadogApiKey(connection)).toBe(API_KEY);
    expect(datadogApplicationKey(connection)).toBe(APP_KEY);
    const refused = (config: DatabaseConnection, secret: string): string => {
      try {
        new DatadogProvider(config);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(secret);
        return message;
      }
      throw new Error("expected a refusal");
    };
    const hostRefusal = "The API host must be a Datadog site. The keys are sent only there.";
    expect(refused({ ...connection, host: "app.datadoghq.com" }, "app.datadoghq.com")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "evil.datadoghq.com" }, "evil.datadoghq.com")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "https://user:secret@api.datadoghq.com" }, "secret")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "api.datadoghq.com:8443" }, "8443")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "https://api.datadoghq.com/v1" }, "/v1")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "https://api.datadoghq.com?x=1" }, "x=1")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "ftp://api.datadoghq.com" }, "ftp")).toBe(hostRefusal);
    expect(refused({ ...connection, host: "not a host" }, "not a host")).toBe(hostRefusal);
    expect(refused({ ...connection, user: "  " }, API_KEY)).toBe("The API key is required.");
    expect(refused({ ...connection, password: "" }, APP_KEY)).toBe("The application key is required.");
    expect(refused({ ...connection, user: "has space" }, "has space")).toBe(
      "Datadog keys must be a single line of printable text.",
    );
    expect(refused({ ...connection, password: "k".repeat(201) }, "k".repeat(201))).toBe(
      "Datadog keys must be a single line of printable text.",
    );
  });

  test("connects, lists the organization, and closes the transport", async () => {
    const pages = scripted([{ body: valid }]);
    const opened = new DatadogProvider(connection, {}, pages.createTransport);
    await opened.connect();
    await opened.connect();
    expect(pages.requests).toHaveLength(1);
    expect(pages.requests[0]?.url).toBe("https://api.datadoghq.com/api/v1/validate");
    expect(pages.options[0]?.headers["DD-API-KEY"]).toBe(API_KEY);
    expect(pages.options[0]?.headers["DD-APPLICATION-KEY"]).toBe(APP_KEY);
    expect(pages.options[0]?.headers["user-agent"]).toBe("KnowSQL");
    expect(pages.options[0]?.refusesUpgrade).toBe(true);
    expect(pages.options[0]?.refusesLinkLocal).toBe(true);
    expect(opened.getCapabilities().supportsMaintenance).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getLabels().entityNamePlural).toBe("Tables");
    expect(await opened.listContainers()).toEqual([{ path: ["organization"], name: "organization", level: 0 }]);
    expect(await opened.listContainers(["other"])).toEqual([]);
    expect(await opened.countObjects(["organization"])).toEqual({ table: { count: 3 } });
    expect((await opened.listObjects(["organization"], "table")).map((object) => object.name)).toEqual([
      "Monitor",
      "Host",
      "Dashboard",
    ]);
    expect((await opened.describeObject(["organization", "host"], "table")).columns[0]?.name).toBe("Id");
    expect((await opened.describeObjects(["organization"], "table", 2)).details).toHaveLength(2);
    expect((await opened.describeObjects(["organization"], "table")).details).toHaveLength(3);
    expect(await opened.getOverview()).toMatchObject({ version: "Datadog API V1", tableCount: 3 });
    expect(await opened.getHealth()).toMatchObject({ cacheHitRatio: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.describeObject(["organization", "Missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObjects(["organization"], "view")).rejects.toThrow(/object kind/);
    await expect(opened.describeObjects(["organization"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.query("DELETE FROM Monitor")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT Id FROM Monitor", ["x"])).rejects.toThrow(/bind parameters/);
    await opened.disconnect();
    await expect(opened.query("SELECT Id FROM Monitor")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(pages.closed).toBe(1);
  });

  test("reads monitors, hosts and dashboards", async () => {
    const monitor = {
      id: 2699850,
      name: "CPU high",
      type: "query alert",
      status: "Alert",
      query: "avg(last_5m):avg:system.cpu.user{*} > 90",
      tags: ["service:api", ""],
      scopes: ["env:prod"],
      metrics: ["system.cpu.user"],
      creator: { name: "Ada", handle: "ada@example.com" },
      notifications: [{ handle: "oncall@example.com" }, { handle: "" }, "nope"],
      last_triggered_ts: 1_720_000_000_000,
      classification: "metric",
      org_id: 42,
    };
    const second = {
      id: 2,
      name: "",
      tags: "nope",
      notifications: "nope",
      last_triggered_ts: 1_565_000_000,
      creator: null,
    };
    const third = { id: 3, last_triggered_ts: Number.MAX_VALUE, metrics: [1, "cpu"] };
    const host = {
      id: 7,
      name: "web-1",
      host_name: "i-web",
      aws_name: "web-1",
      aliases: ["web-1.internal", 4],
      apps: [],
      sources: ["agent"],
      tags_by_source: { agent: ["env:prod", ""], other: "nope" },
      is_muted: false,
      up: true,
      last_reported_time: 1_565_000_000,
      metrics: { cpu: 12, iowait: 0.1, load: 0.4 },
      meta: { agent_version: "7.32.3", platform: "linux", machine: "amd64" },
    };
    const bareHost = {
      aws_id: "i-bare",
      aliases: [1],
      tags_by_source: {},
      is_muted: "yes",
      last_reported_time: 12,
      metrics: { cpu: "high" },
    };
    const dashboard = {
      id: "abc",
      title: "Overview",
      description: "",
      author_handle: "ada",
      layout_type: "ordered",
      is_read_only: false,
      url: "/dashboard/abc",
      created_at: "2019-09-19T10:00:00.000Z",
      modified_at: 1_565_000_000_000,
    };
    const pages = scripted([
      { body: valid },
      { body: { monitors: [monitor, second, third], metadata: { total_count: 3, page: 0, per_page: 1 } } },
      { body: { monitors: [monitor], metadata: { total_count: 9, page: 1, per_page: 30 } } },
      { body: { metadata: { total_count: 4 } } },
      { body: { monitors: null, metadata: { total_count: 0 } } },
      { body: { host_list: [host, bareHost], total_matching: 2, total_returned: 2 } },
      { body: { total_matching: 8 } },
      { body: { dashboards: [dashboard, { id: "empty" }] } },
      { body: { dashboards: [dashboard] } },
    ]);
    const opened = new DatadogProvider({ ...connection, host: "eu" }, {}, pages.createTransport);
    await opened.connect();
    expect(pages.requests[0]?.url).toBe("https://api.datadoghq.eu/api/v1/validate");

    const one = await opened.query("SELECT Id, Name, Status, Notifications, LastTriggered FROM Monitor LIMIT 1");
    expect(one.rows[0]).toEqual({
      Id: "2699850",
      Name: "CPU high",
      Status: "Alert",
      Notifications: "oncall@example.com",
      LastTriggered: "2024-07-03T09:46:40.000Z",
    });
    expect(one.rows[1]).toMatchObject({ Name: null, Notifications: null, LastTriggered: "2019-08-05T10:13:20.000Z" });
    expect(one.rows[2]?.LastTriggered).toBeNull();
    expect(one.warnings).toBeUndefined();
    expect(params(pages.requests[1]?.url ?? "").get("per_page")).toBe("1");
    expect(params(pages.requests[1]?.url ?? "").get("page")).toBe("0");

    const paged = await opened.query(
      "SELECT Id FROM Monitor WHERE Status = 'No Data' AND Query = 'type:metric' LIMIT 30 OFFSET 30",
    );
    expect(paged.rows).toEqual([{ Id: "2699850" }]);
    expect(paged.warnings).toBeUndefined();
    const search = params(pages.requests[2]?.url ?? "");
    expect(search.get("page")).toBe("1");
    expect(search.get("per_page")).toBe("30");
    expect(search.get("query")).toBe('status:"No Data" type:metric');

    const counted = await opened.query("SELECT COUNT(*) AS n FROM Monitor WHERE Status = 'Alert'");
    expect(counted.rows).toEqual([{ n: 4 }]);
    expect(params(pages.requests[3]?.url ?? "").get("query")).toBe("status:alert");
    expect(params(pages.requests[3]?.url ?? "").get("per_page")).toBe("1");

    const none = await opened.query("SELECT Id FROM Monitor LIMIT 1");
    expect(none.rows).toEqual([]);

    const hosts = await opened.query(
      "SELECT Id, Name, Aliases, Tags, Cpu, AgentVersion, LastReported FROM Host WHERE Filter = 'env:prod' AND SortField = 'cpu' AND SortDir = 'desc' AND From = 1700000000 LIMIT 2",
    );
    expect(hosts.rows[0]).toMatchObject({
      Id: "7",
      Name: "web-1",
      Aliases: "web-1.internal",
      Tags: "env:prod",
      Cpu: 12,
      AgentVersion: "7.32.3",
    });
    expect(hosts.rows[1]).toMatchObject({ Id: "i-bare", Aliases: null, Tags: null, Cpu: null, AgentVersion: null });
    expect(hosts.rows[1]?.LastReported).toBe("12");
    expect(hosts.warnings?.[0]?.message).toContain("this page only");
    const hostQuery = params(pages.requests[5]?.url ?? "");
    expect(hostQuery.get("filter")).toBe("env:prod");
    expect(hostQuery.get("sort_field")).toBe("cpu");
    expect(hostQuery.get("sort_dir")).toBe("desc");
    expect(hostQuery.get("from")).toBe("1700000000");
    expect(hostQuery.get("start")).toBe("0");
    expect(hostQuery.get("count")).toBe("2");
    expect(hostQuery.get("include_hosts_metadata")).toBe("true");
    expect(pages.requests[5]?.url.startsWith("https://api.datadoghq.eu/api/v1/hosts?")).toBe(true);

    const hostCount = await opened.query("SELECT COUNT(*) FROM Host");
    expect(hostCount.rows).toEqual([{ totalCount: 8 }]);
    expect(params(pages.requests[6]?.url ?? "").get("count")).toBe("1");

    const boards = await opened.query(
      "SELECT Id, Title, Description, IsReadOnly, ModifiedAt FROM Dashboard WHERE Shared = true LIMIT 200",
    );
    expect(boards.rows[0]).toMatchObject({
      Id: "abc",
      Title: "Overview",
      Description: null,
      IsReadOnly: "false",
      ModifiedAt: "2019-08-05T10:13:20.000Z",
    });
    expect(boards.rows[1]).toMatchObject({ Id: "empty", Title: null });
    expect(boards.warnings?.some((warning) => warning.message.includes("at most 100"))).toBe(true);
    expect(params(pages.requests[7]?.url ?? "").get("filter[shared]")).toBe("true");
    expect(params(pages.requests[7]?.url ?? "").get("count")).toBe("100");

    const full = await opened.query("SELECT Id FROM Dashboard LIMIT 1");
    expect(full.rows).toEqual([{ Id: "abc" }]);
    expect(full.warnings?.[0]?.message).toContain("this page only");
    await opened.disconnect();
  });

  test("maps API failures and keeps the keys out of the message", async () => {
    const connectCases: { pages: ScriptedPage[]; error: unknown; message: string }[] = [
      { pages: [{ status: 401, text: "no" }], error: AuthenticationError, message: "Datadog rejected the keys." },
      { pages: [{ status: 403, text: "no" }], error: PermissionDeniedError, message: "Datadog refused this request." },
      {
        pages: [{ status: 429, text: "slow" }],
        error: ConnectionError,
        message: "Datadog asked the connection to slow down.",
      },
      {
        pages: [{ status: 302, text: "away" }],
        error: ConnectionError,
        message: "Datadog answered with a redirect, which Studio does not follow.",
      },
      { pages: [{ status: 500, text: `boom ${API_KEY}` }], error: ConnectionError, message: "boom ••••" },
      { pages: [{ status: 500, text: "" }], error: ConnectionError, message: "Datadog refused the request." },
      {
        pages: [{ status: 400, body: { errors: ["Bad Request"] } }],
        error: ConnectionError,
        message: "Datadog refused the request (Bad Request).",
      },
      {
        pages: [{ status: 400, body: { errors: [`see ${APP_KEY}`] } }],
        error: ConnectionError,
        message: "Datadog refused the request.",
      },
      {
        pages: [{ status: 400, body: { errors: [12] } }],
        error: ConnectionError,
        message: "Datadog refused the request.",
      },
      { pages: [{ text: "" }], error: ConnectionError, message: "Datadog returned an answer that was not JSON." },
      {
        pages: [{ text: "not-json" }],
        error: ConnectionError,
        message: "Datadog returned an answer that was not JSON.",
      },
      { pages: [{ body: { valid: false } }], error: AuthenticationError, message: "Datadog rejected the keys." },
      { pages: [{ body: ["nope"] }], error: AuthenticationError, message: "Datadog rejected the keys." },
      {
        pages: [{ throw: new TransportError("redirect", "https://evil.example") }],
        error: ConnectionError,
        message: "Datadog answered with a redirect, which Studio does not follow.",
      },
      {
        pages: [{ throw: new TransportError("too-large", "big") }],
        error: QueryError,
        message: "Datadog's answer was larger than 2 MB and was not read.",
      },
      {
        pages: [{ throw: new TransportError("network", `down ${API_KEY}`) }],
        error: ConnectionError,
        message: "down ••••",
      },
      { pages: [{ throw: new DatabaseConfigError("kept", "datadog") }], error: DatabaseConfigError, message: "kept" },
      { pages: [{ throw: new Error(`socket ${APP_KEY}`) }], error: ConnectionError, message: "socket ••••" },
      { pages: [{ throw: "down" }], error: ConnectionError, message: "Datadog could not be reached." },
    ];
    for (const entry of connectCases) {
      const script = scripted(entry.pages);
      const provider = new DatadogProvider(connection, {}, script.createTransport);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is a fresh connection, and the queue is one page deep.
        await provider.connect();
        throw new Error("expected connect to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(entry.error);
        const message = error instanceof Error ? error.message : "";
        expect(message).toBe(entry.message);
        expect(message).not.toContain(API_KEY);
        expect(message).not.toContain(APP_KEY);
      }
      expect(script.closed).toBe(1);
    }

    const pages = scripted([
      { body: valid },
      { status: 401, text: "no" },
      { status: 403, text: "no" },
      { status: 429, text: "slow" },
      { status: 302, text: "away" },
      { status: 500, text: `failed ${APP_KEY}` },
      { text: "" },
      { text: "not-json" },
      { text: "y".repeat(API_ANSWER_LIMIT + 1) },
      { status: 400, body: { errors: ["Bad Request"] } },
      { status: 400, body: { errors: [true] } },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("tls", `pin ${API_KEY}`) },
      { throw: new DatabaseConfigError("kept", "datadog") },
      { throw: new Error("reset") },
      { throw: "down" },
      { body: { monitors: "nope" } },
      { body: ["nope"] },
      { body: { metadata: {} } },
      { body: { metadata: { total_count: "4" } } },
      { body: { total_matching: Number.POSITIVE_INFINITY } },
    ]);
    const opened = new DatadogProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const sql = "SELECT Id FROM Monitor";
    await expect(opened.query(sql)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query(sql)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query(sql)).rejects.toThrow("Datadog asked the connection to slow down.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog answered with a redirect, which Studio does not follow.");
    await expect(opened.query(sql)).rejects.toThrow("failed ••••");
    await expect(opened.query(sql)).rejects.toThrow("Datadog returned an answer that was not JSON.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog returned an answer that was not JSON.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog's answer was larger than 2 MB and was not read.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog refused the request (Bad Request).");
    await expect(opened.query(sql)).rejects.toThrow("Datadog refused the request.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog answered with a redirect, which Studio does not follow.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog's answer was larger than 2 MB and was not read.");
    await expect(opened.query(sql)).rejects.toThrow("pin ••••");
    await expect(opened.query(sql)).rejects.toThrow("kept");
    await expect(opened.query(sql)).rejects.toThrow("reset");
    await expect(opened.query(sql)).rejects.toThrow("Datadog could not be reached.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog returned an answer that was not a list.");
    await expect(opened.query(sql)).rejects.toThrow("Datadog returned an answer that was not a JSON object.");
    await expect(opened.query("SELECT COUNT(*) FROM Monitor")).rejects.toThrow("Datadog did not return a total.");
    await expect(opened.query("SELECT COUNT(*) FROM Monitor")).rejects.toThrow("Datadog did not return a total.");
    await expect(opened.query("SELECT COUNT(*) FROM Host")).rejects.toThrow("Datadog did not return a total.");
    await opened.disconnect();
  });
});
