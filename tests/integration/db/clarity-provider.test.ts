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
import { ClarityProvider, clarityApiHost, clarityToken } from "@/lib/db/providers/sql/clarity";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "cl",
  name: "cl",
  type: "clarity",
  password: "clarity-token-value",
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
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.url}`);
        if ("throw" in next && next.throw !== undefined) throw next.throw;
        const text = next.text ?? JSON.stringify(next.body ?? {});
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

const traffic = {
  metricName: "Traffic",
  information: [
    {
      OS: "Android",
      totalSessionCount: "4",
      PagesPerSessionPercentage: 1.5,
      extra: { nested: true },
      __proto__: "nope",
    },
    { OS: "Windows", totalSessionCount: "9", totalBotSessionCount: "1" },
  ],
};

describe("ClarityProvider", () => {
  test("requires a single-line token and sends it only to www.clarity.ms", () => {
    expect(() => new ClarityProvider(connection)).not.toThrow();
    expect(() => new ClarityProvider({ ...connection, password: "census", host: "www.clarity.ms" })).not.toThrow();
    expect(() => new ClarityProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "clarity-token-value\r\nX-Injected: 1";
    expect(() => new ClarityProvider({ ...connection, password: injected })).toThrow(/single line/);
    try {
      clarityToken({ ...connection, password: injected });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("clarity-token");
    }
    expect(() => clarityToken({ ...connection, password: "x".repeat(4090) })).toThrow(/single line/);
    expect(clarityApiHost(connection)).toBe("www.clarity.ms");
    expect(clarityApiHost({ ...connection, host: " https://www.clarity.ms/export " })).toBe("www.clarity.ms");
    expect(clarityApiHost({ ...connection, host: "http://WWW.CLARITY.MS" })).toBe("www.clarity.ms");
    expect(clarityApiHost({ ...connection, host: "   " })).toBe("www.clarity.ms");
    for (const host of ["evil.example", "https://clarity-token-value@evil.example", "www.clarity.ms:8443"]) {
      expect(() => new ClarityProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        clarityApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("clarity.ms");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("8443");
        expect(message).not.toContain("clarity-token");
      }
    }
    expect(() => clarityApiHost({ ...connection, host: "files.clarity.ms" })).toThrow(
      "The API host must be www.clarity.ms. The token is sent only there.",
    );
  });

  test("exports insights and refuses a write", async () => {
    const probe = scripted([{ body: [traffic] }]);
    const opened = new ClarityProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1");
    expect(probe.options?.origin).toEqual({ scheme: "https", host: "www.clarity.ms", port: 443 });
    expect(probe.options?.tls).toEqual({ rejectUnauthorized: true, identity: "www.clarity.ms" });
    expect(probe.options?.refusesLinkLocal).toBe(true);
    expect(probe.options?.refusesUpgrade).toBe(true);
    expect(probe.options?.headers.Authorization).toBe("Bearer clarity-token-value");
    expect(await opened.listContainers()).toEqual([{ path: ["project"], name: "project", level: 0 }]);
    expect(await opened.listContainers(["project"])).toEqual([]);
    expect(await opened.countObjects(["project"])).toEqual({ table: { count: 1 } });
    expect((await opened.listObjects(["project"], "table")).map((object) => object.name)).toEqual(["insights"]);
    const detail = await opened.describeObject(["project", "insights"], "table");
    expect(detail.columns.map((column) => column.name)).toContain("OS");
    expect(detail.foreignKeys).toEqual([]);
    const bulk = await opened.describeObjects(["project"], "table");
    expect(bulk.details).toHaveLength(1);
    const truncated = await opened.describeObjects(["project"], "table", 1);
    expect(truncated.truncated).toBeUndefined();
    await expect(opened.describeObjects(["project"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.listObjects(["project"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["project", "missing"], "table")).rejects.toThrow(/no table/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({ version: "Clarity Data Export API", tableCount: 1 });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.query("INSERT INTO insights (OS) VALUES ('Android')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT OS FROM insights", ["x"])).rejects.toThrow(/bind parameters/);
    await opened.disconnect();
    expect(probe.closed).toBe(1);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
  });

  test("filters, sorts and counts the one export", async () => {
    const many = {
      metricName: "Traffic",
      information: Array.from({ length: 1000 }, (_, index) => ({ OS: "Android", totalSessionCount: String(index) })),
    };
    const probe = scripted([
      { body: [traffic] },
      { body: [traffic] },
      { body: [traffic] },
      { body: [many] },
      {
        body: [
          {
            metricName: "Traffic",
            information: [
              { OS: "Android", totalSessionCount: "9" },
              { OS: "Android", totalSessionCount: "4" },
              { OS: "Android", totalSessionCount: "4" },
            ],
          },
        ],
      },
      {
        body: [
          {
            metricName: "Traffic",
            information: [
              { OS: "Android", totalSessionCount: "9" },
              { OS: "Android", totalSessionCount: "4" },
              { OS: "Android", totalSessionCount: "4" },
            ],
          },
        ],
      },
      { body: [traffic] },
      { body: [] },
    ]);
    const opened = new ClarityProvider({ ...connection, host: "http://www.clarity.ms" }, {}, probe.createTransport);
    await opened.connect();
    const listed = await opened.query(
      "SELECT OS, totalSessionCount, extra FROM insights WHERE days = 1 AND OS = 'Android' ORDER BY totalSessionCount DESC LIMIT 1 OFFSET 0",
    );
    expect(listed.rows).toEqual([{ OS: "Android", totalSessionCount: "4", extra: null }]);
    expect(listed.warnings?.map((warning) => warning.message).join(" ")).toContain("10 exports");
    expect(probe.requests[1]?.url).toContain("dimension1=OS");
    expect(probe.requests[1]?.url).toContain("numOfDays=1");
    const counted = await opened.query("SELECT COUNT(*) AS row_count FROM insights WHERE numOfDays = 2");
    expect(counted.rows).toEqual([{ row_count: 2 }]);
    const capped = await opened.query("SELECT * FROM insights WHERE days = 3");
    expect(capped.rowCount).toBe(1000);
    expect(capped.warnings?.some((warning) => warning.message.includes("1000"))).toBe(true);
    const ascending = await opened.query(
      "SELECT totalSessionCount FROM insights WHERE OS = 'Android' ORDER BY totalSessionCount ASC",
    );
    expect(ascending.rows.map((row) => row.totalSessionCount)).toEqual(["4", "4", "9"]);
    const descending = await opened.query(
      "SELECT totalSessionCount FROM insights WHERE OS = 'Android' ORDER BY totalSessionCount DESC",
    );
    expect(descending.rows[0]).toEqual({ totalSessionCount: "9" });
    const quoted = await opened.query(`SELECT "Country/Region" FROM insights WHERE "Country/Region" = 'US'`);
    expect(quoted.rows).toEqual([]);
    expect(decodeURIComponent(probe.requests.at(-1)?.url ?? "")).toContain("dimension1=Country/Region");
    const empty = await opened.query("SELECT metricName FROM insights");
    expect(empty.rows).toEqual([]);
    expect(empty.fields).toEqual(["metricName"]);
  });

  test("refuses a bad answer without repeating the token", async () => {
    const secret = "clarity-token-value";
    const probe = scripted([
      { body: [traffic] },
      { status: 401, body: { message: `no ${secret}` } },
      { status: 403, body: { error: { message: "nope" } } },
      { status: 429, body: { message: "slow" } },
      { status: 302, body: { message: "https://evil.example/steal" } },
      { text: "not-json" },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { throw: new TransportError("redirect", "https://evil.example/token") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${secret}`) },
      { throw: new DatabaseConfigError("blocked", "clarity") },
      { throw: new Error(`boom ${secret}`) },
      { throw: "plain" },
      { body: { metricName: "Traffic" } },
      { status: 400, body: { error: 1 } },
    ]);
    const opened = new ClarityProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT OS FROM insights")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/slow/);
    try {
      await opened.query("SELECT OS FROM insights");
      throw new Error("the redirect was followed");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("evil");
    }
    await expect(opened.query("SELECT metricName FROM insights")).rejects.toBeInstanceOf(QueryError);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/2 MB/);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/redirect/);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/2 MB/);
    try {
      await opened.query("SELECT OS FROM insights");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(secret);
      expect(message).toContain("••••");
    }
    await expect(opened.query("SELECT OS FROM insights")).rejects.toBeInstanceOf(DatabaseConfigError);
    try {
      await opened.query("SELECT OS FROM insights");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/could not be reached/);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/did not return insights/);
    await expect(opened.query("SELECT OS FROM insights")).rejects.toThrow(/answered 400/);
    const failed = scripted([{ throw: new TransportError("unreachable", "nope") }]);
    const closed = new ClarityProvider(connection, {}, failed.createTransport);
    await expect(closed.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(failed.closed).toBe(1);
    await expect(new ClarityProvider(connection).query("SELECT OS FROM insights")).rejects.toThrow(/Not connected/);
  });
});
