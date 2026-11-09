import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { readGaCredential, readGaTokenGrant } from "@/lib/db/providers/sql/googleanalytics/auth";
import { gaApiHost, gaPropertyId, GoogleAnalyticsProvider } from "@/lib/db/providers/sql/googleanalytics";
import type { DatabaseConnection } from "@/lib/types";

const TOKEN = "ya29.test-token-value";
const connection = {
  id: "ga",
  name: "ga",
  type: "googleanalytics",
  password: TOKEN,
  database: "123456789",
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
  requests: { url: string; method: string; body?: string; form?: Record<string, string> }[];
  created: NodeTransportOptions[];
  closed: number;
} {
  const requests: { url: string; method: string; body?: string; form?: Record<string, string> }[] = [];
  const created: NodeTransportOptions[] = [];
  const state = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    created.push(options);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, body: request.body, form: request.form });
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
    created,
    get closed() {
      return state.closed;
    },
  };
}

const metadata = {
  dimensions: [{ apiName: "date" }, { apiName: "country" }, { apiName: "1bad" }, "skip", { apiName: "city" }],
  metrics: [{ apiName: "activeUsers" }, { apiName: "sessions" }, { uiName: "missing" }],
};

const report = {
  dimensionHeaders: [{ name: "country" }, { name: "__proto__" }],
  metricHeaders: [{ name: "activeUsers" }],
  rows: [
    { dimensionValues: [{ value: "US" }, { value: "x" }], metricValues: [{ value: "4" }] },
    null,
    { dimensionValues: "no", metricValues: [{ value: "(not set)" }, { value: "" }, { value: 1 }] },
  ],
};

function serviceAccountJson(pem?: string): string {
  const key =
    pem ??
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return JSON.stringify({
    type: "service_account",
    client_email: "studio@example.iam.gserviceaccount.com",
    private_key: key,
  });
}

describe("GoogleAnalyticsProvider", () => {
  test("accepts a token or a service-account key, and a numeric property id", () => {
    expect(() => new GoogleAnalyticsProvider(connection)).not.toThrow();
    expect(() => new GoogleAnalyticsProvider({ ...connection, password: "census" })).not.toThrow();
    expect(() => new GoogleAnalyticsProvider({ ...connection, password: `Bearer ${TOKEN}` })).not.toThrow();
    expect(readGaCredential(`Bearer ${TOKEN}`)).toEqual({ kind: "access_token", token: TOKEN });
    expect(() => new GoogleAnalyticsProvider({ ...connection, password: "  " })).toThrow(/required/);
    expect(() => readGaCredential(`token\n${TOKEN}`)).toThrow(/single line/);
    expect(() => readGaCredential("x".repeat(16_001))).toThrow(/larger than Studio/);
    expect(() => readGaCredential("{")).toThrow(/client_email/);
    expect(() =>
      readGaCredential(JSON.stringify({ client_email: "not-an-email", private_key: "BEGIN PRIVATE KEY END" })),
    ).toThrow(/client_email/);
    expect(() => readGaCredential(JSON.stringify({ client_email: "a@b.co", private_key: "no" }))).toThrow(
      /client_email/,
    );
    expect(() => readGaCredential(JSON.stringify({ private_key: "BEGIN PRIVATE KEY" }))).toThrow(/client_email/);
    expect(() => readGaCredential("{}")).toThrow(/client_email/);
    expect(gaApiHost(connection)).toBe("analyticsdata.googleapis.com");
    expect(gaApiHost({ ...connection, host: " https://analyticsdata.googleapis.com/v1beta " })).toBe(
      "analyticsdata.googleapis.com",
    );
    expect(gaApiHost({ ...connection, host: "" })).toBe("analyticsdata.googleapis.com");
    expect(() => gaApiHost({ ...connection, host: "oauth2.googleapis.com" })).toThrow(/analyticsdata.googleapis.com/);
    expect(() => gaApiHost({ ...connection, host: "evil.example" })).toThrow(DatabaseConfigError);
    try {
      gaApiHost({ ...connection, host: "https://ya29.test-token-value@evil.example:9" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("evil");
      expect(message).not.toContain("ya29");
    }
    expect(() => gaPropertyId({ ...connection, database: "" })).toThrow(/property id is required/);
    expect(() => gaPropertyId({ ...connection, database: "../admin" })).toThrow(/number from the property/);
    try {
      gaPropertyId({ ...connection, database: "../admin" });
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("admin");
    }
    expect(() => readGaTokenGrant(400, JSON.stringify({ error_description: "denied" }), 0)).toThrow(/denied/);
  });

  test("the token grant reader refuses a bad answer", () => {
    expect(() => readGaTokenGrant(500, "not-json", 0)).toThrow(/HTTP 500/);
    expect(() => readGaTokenGrant(200, JSON.stringify({ access_token: "" }), 0)).toThrow(/HTTP 200/);
    expect(() => readGaTokenGrant(403, JSON.stringify({ error: { code: 1 } }), 0)).toThrow(/HTTP 403/);
    const assertion = "eyJhbGciOiJSUzI1NiJ9.payload.signature-value";
    const pastTheCut = `${"y".repeat(280)}${assertion}`;
    expect(() => readGaTokenGrant(400, JSON.stringify({ error_description: pastTheCut }), 0, [assertion])).toThrow(
      /token request failed/,
    );
    try {
      readGaTokenGrant(400, JSON.stringify({ error_description: pastTheCut }), 0, [assertion]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("eyJhbGci");
      expect(message).toContain("••••");
    }
    expect(() => readGaTokenGrant(400, JSON.stringify({ error_description: "x".repeat(1000) }), 0)).toThrow(
      /^Google token request failed: x{300}$/,
    );
    expect(readGaTokenGrant(200, JSON.stringify({ access_token: TOKEN }), 1_000)).toEqual({
      token: TOKEN,
      expiresAt: 1_000 + 3_600_000,
    });
  });

  test("runs a report from metadata and refuses a write", async () => {
    const probe = scripted([
      { body: metadata },
      { body: report },
      { body: { dimensionHeaders: [{ name: "country" }], metricHeaders: [{ name: "activeUsers" }], rows: [] } },
      {
        body: {
          metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }],
          rows: [{ metricValues: [{ value: "9007199254740993" }, { value: "1.5" }] }],
        },
      },
      { body: report },
    ]);
    const opened = new GoogleAnalyticsProvider(
      { ...connection, host: "http://analyticsdata.googleapis.com" },
      {},
      probe.createTransport,
    );
    await opened.connect();
    await opened.connect();
    expect(probe.requests[0]?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789/metadata");
    expect(probe.created[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(probe.created[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "analyticsdata.googleapis.com" });
    expect(probe.created[0]?.refusesLinkLocal).toBe(true);
    const detail = await opened.describeObject(["property", "report"], "table");
    expect(detail.columns).toContainEqual({ name: "country", type: "varchar", nullable: true, isPrimary: false });
    expect(detail.columns).toContainEqual({ name: "activeUsers", type: "double", nullable: true, isPrimary: false });
    expect(await opened.listContainers()).toEqual([{ path: ["property"], name: "property", level: 0 }]);
    expect(await opened.listContainers(["property"])).toEqual([]);
    expect(await opened.countObjects(["property"])).toEqual({ table: { count: 1 } });
    expect(await opened.listObjects(["property"], "table")).toHaveLength(1);
    expect((await opened.describeObjects(["property"], "table")).details).toHaveLength(1);
    await expect(opened.describeObjects(["property"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObject(["property", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["property"], "view")).rejects.toThrow(/no object kind/);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getLabels().entityName).toBe("Table");
    expect(await opened.getOverview()).toMatchObject({ version: "Google Analytics Data API", tableCount: 1 });
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    expect(await opened.getPerformanceMetrics()).toEqual({});
    const listed = await opened.query(
      "SELECT country, activeUsers FROM report WHERE startDate = '7daysAgo' AND endDate = 'yesterday' AND country = 'US' AND activeUsers = 4 ORDER BY activeUsers DESC LIMIT 100",
    );
    expect(listed.rows[0]).toEqual({ country: "US", activeUsers: 4 });
    expect(Object.hasOwn(listed.rows[0] ?? {}, "__proto__")).toBe(false);
    const body = JSON.parse(probe.requests[1]?.body ?? "{}") as {
      dimensions: { name: string }[];
      metrics: { name: string }[];
      limit: string;
      dimensionFilter: { filter: { fieldName: string } };
      metricFilter: { filter: { fieldName: string } };
      orderBys: { desc: boolean; metric: { metricName: string } }[];
    };
    expect(probe.requests[1]?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport");
    expect(body.dimensions).toEqual([{ name: "country" }]);
    expect(body.metrics).toEqual([{ name: "activeUsers" }]);
    expect(body.limit).toBe("100");
    expect(body.dimensionFilter.filter.fieldName).toBe("country");
    expect(body.metricFilter.filter.fieldName).toBe("activeUsers");
    expect(body.orderBys[0]).toEqual({ desc: true, metric: { metricName: "activeUsers" } });
    const wide = await opened.query(
      "SELECT country, city, activeUsers, sessions FROM report WHERE country = 'US' AND city = 'NYC' AND sessions = 1.5 ORDER BY country ASC LIMIT 10001 OFFSET 2",
    );
    expect(wide.warnings?.[0]?.message).toContain("10000");
    const wideBody = JSON.parse(probe.requests[2]?.body ?? "{}") as {
      limit: string;
      dimensionFilter: { andGroup: unknown };
    };
    expect(wideBody.limit).toBe("10000");
    expect(wideBody.dimensionFilter.andGroup).toBeDefined();
    const numbers = await opened.query("SELECT activeUsers, sessions FROM report");
    expect(numbers.rows[0]).toEqual({ activeUsers: "9007199254740993", sessions: 1.5 });
    await expect(opened.query("INSERT INTO report (country) VALUES ('US')")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT country FROM report", ["x"])).rejects.toThrow(/bind parameters/);
    await expect(opened.query("SELECT COUNT(*) FROM report")).rejects.toThrow(/activeUsers/);
    await expect(opened.query("SELECT missing FROM report")).rejects.toThrow(/no field named/);
    await expect(opened.query("SELECT country FROM report")).rejects.toThrow(/at least one metric/);
    await expect(opened.query("SELECT activeUsers FROM report WHERE activeUsers = 'nope'")).rejects.toThrow(
      /whole number/,
    );
    await expect(opened.query("SELECT activeUsers FROM report ORDER BY country")).rejects.toThrow(/ORDER BY/);
    const tooMany = Array.from({ length: 10 }, (_, index) => `d${index}`);
    const wideMeta = scripted([
      {
        body: {
          dimensions: tooMany.map((name) => ({ apiName: name })),
          metrics: [{ apiName: "activeUsers" }],
        },
      },
    ]);
    const limited = new GoogleAnalyticsProvider(connection, {}, wideMeta.createTransport);
    await limited.connect();
    await expect(limited.query(`SELECT ${tooMany.join(", ")}, activeUsers FROM report`)).rejects.toThrow(
      /9 dimensions/,
    );
    await opened.disconnect();
    expect(probe.closed).toBe(1);
    await expect(opened.query("SELECT activeUsers FROM report")).rejects.toThrow(/Not connected/);
  });

  test("SELECT * uses a short default, and an empty catalog is refused", async () => {
    const probe = scripted([
      { body: metadata },
      {
        body: {
          rows: [
            {
              dimensionValues: [{ value: "20240101" }, { value: "US" }],
              metricValues: [{ value: "3" }, { value: "8" }],
            },
          ],
        },
      },
      { body: { dimensions: [{ apiName: "city" }], metrics: [{ apiName: "bounceRate" }] } },
      { body: { rows: [] } },
      { body: { dimensions: "nope", metrics: [] } },
    ]);
    const opened = new GoogleAnalyticsProvider(connection, {}, probe.createTransport);
    await opened.connect();
    const star = await opened.query("SELECT * FROM report LIMIT 0");
    expect(star.rows).toEqual([]);
    expect(probe.requests).toHaveLength(1);
    const again = await opened.query("SELECT * FROM report");
    expect(again.fields).toEqual(["date", "country", "activeUsers", "sessions"]);
    await opened.disconnect();
    const fallback = new GoogleAnalyticsProvider(connection, {}, probe.createTransport);
    await fallback.connect();
    const picked = await fallback.query("SELECT * FROM report");
    expect(picked.fields).toEqual(["city", "bounceRate"]);
    await fallback.disconnect();
    const empty = new GoogleAnalyticsProvider(connection, {}, probe.createTransport);
    await empty.connect();
    await expect(empty.query("SELECT * FROM report")).rejects.toThrow(/no dimensions or metrics/);
  });

  test("a service-account key is exchanged only at oauth2.googleapis.com", async () => {
    let now = 1_700_000_000_000;
    const json = serviceAccountJson();
    const probe = scripted([
      { body: { access_token: "ya29.exchanged-token", expires_in: 3600 } },
      { body: metadata },
      { body: { rows: [] } },
      { body: { access_token: "ya29.refreshed-token", expires_in: 3600 } },
      { body: { rows: [] } },
    ]);
    const opened = new GoogleAnalyticsProvider({ ...connection, password: json }, {}, probe.createTransport, () => now);
    await opened.connect();
    expect(probe.requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(probe.requests[0]?.method).toBe("POST");
    expect(probe.requests[0]?.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(probe.requests[0]?.form?.assertion).not.toContain("PRIVATE KEY");
    expect(probe.created[0]?.origin).toEqual({ scheme: "https", host: "oauth2.googleapis.com", port: 443 });
    expect(probe.created[0]?.headers.Authorization).toBeUndefined();
    expect(probe.created[1]?.headers.Authorization).toBe("Bearer ya29.exchanged-token");
    await opened.query("SELECT country, activeUsers FROM report");
    expect(probe.requests.filter((request) => request.url.includes("oauth2"))).toHaveLength(1);
    now += 3_600_000;
    await opened.query("SELECT country, activeUsers FROM report");
    expect(probe.created.at(-1)?.headers.Authorization).toBe("Bearer ya29.refreshed-token");
    expect(probe.requests.filter((request) => request.url.includes("oauth2"))).toHaveLength(2);
    const broken = serviceAccountJson("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----");
    const failing = scripted([]);
    const refused = new GoogleAnalyticsProvider({ ...connection, password: broken }, {}, failing.createTransport);
    await expect(refused.connect()).rejects.toThrow(/private_key could not be read/);
    expect(failing.closed).toBe(1);
    const password = serviceAccountJson();
    const key = (JSON.parse(password) as { private_key: string }).private_key;
    const issued = "ya29.issued-token-value";
    const tokenError = scripted([{ status: 400, body: { error_description: `bad ${key}` } }]);
    const leaked = new GoogleAnalyticsProvider({ ...connection, password }, {}, tokenError.createTransport);
    let tokenMessage = "";
    try {
      await leaked.connect();
    } catch (error) {
      tokenMessage = error instanceof Error ? error.message : "";
    }
    expect(tokenMessage).toContain("token request failed");
    expect(tokenMessage).not.toContain("PRIVATE KEY");
    expect(tokenMessage).not.toContain(key.slice(0, 40));
    const reportError = scripted([
      { body: { access_token: issued, expires_in: 3600 } },
      { body: metadata },
      { status: 400, body: { error: { message: `saw ${issued} and ${key}` } } },
    ]);
    const openedAgain = new GoogleAnalyticsProvider({ ...connection, password }, {}, reportError.createTransport);
    await openedAgain.connect();
    let reportMessage = "";
    try {
      await openedAgain.query("SELECT country, activeUsers FROM report");
    } catch (error) {
      reportMessage = error instanceof Error ? error.message : "";
    }
    expect(reportMessage).toContain("saw");
    expect(reportMessage).not.toContain(issued);
    expect(reportMessage).not.toContain("PRIVATE KEY");
  });

  test("refuses a bad answer without repeating the credential", async () => {
    const probe = scripted([
      { body: metadata },
      { status: 401, body: { error: { message: `no ${TOKEN}` } } },
      { status: 403, body: { message: "nope" } },
      { status: 400, text: "not-json" },
      { status: 302, text: "https://evil.example/steal" },
      { text: "x".repeat(2 * 1024 * 1024 + 1) },
      { throw: new TransportError("redirect", "https://evil.example/token") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("network", `down ${TOKEN}`) },
      { throw: new DatabaseConfigError("blocked", "googleanalytics") },
      { throw: new Error(`boom ${TOKEN}`) },
      { throw: "plain" },
      { body: [] },
      { status: 400, body: { error: 1 } },
    ]);
    const opened = new GoogleAnalyticsProvider(connection, {}, probe.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toBeInstanceOf(QueryError);
    try {
      await opened.query("SELECT country, activeUsers FROM report");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("evil");
    }
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(/2 MB/);
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(/redirect/);
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(/2 MB/);
    try {
      await opened.query("SELECT country, activeUsers FROM report");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toBeInstanceOf(DatabaseConfigError);
    try {
      await opened.query("SELECT country, activeUsers FROM report");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(TOKEN);
    }
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(/could not be reached/);
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(
      /did not return metadata|did not return a report/,
    );
    await expect(opened.query("SELECT country, activeUsers FROM report")).rejects.toThrow(/answered 400/);
    const both = scripted([
      {
        body: {
          dimensions: [{ apiName: "country" }],
          metrics: [{ apiName: "country" }],
        },
      },
    ]);
    const clash = new GoogleAnalyticsProvider(connection, {}, both.createTransport);
    await clash.connect();
    await expect(clash.query("SELECT country, activeUsers FROM report")).rejects.toThrow(
      /both a dimension and a metric/,
    );
    await expect(new GoogleAnalyticsProvider({ ...connection, database: "census" }).connect()).rejects.toThrow(
      /property id/,
    );
    const ten = Array.from({ length: 11 }, (_, index) => `m${index}`);
    const metrics = scripted([
      { body: { dimensions: [{ apiName: "country" }], metrics: ten.map((name) => ({ apiName: name })) } },
    ]);
    const tooMany = new GoogleAnalyticsProvider(connection, {}, metrics.createTransport);
    await tooMany.connect();
    await expect(tooMany.query(`SELECT country, ${ten.join(", ")} FROM report`)).rejects.toThrow(/10 metrics/);
  });
});
