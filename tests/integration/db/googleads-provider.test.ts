import { generateKeyPairSync } from "node:crypto";
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
import { API_ANSWER_LIMIT } from "@/lib/db/http/pinned-api-host";
import { GoogleAdsProvider } from "@/lib/db/providers/sql/googleads";
import { GOOGLE_ADS_RESOURCES } from "@/lib/db/providers/sql/googleads/translate";
import type { DatabaseConnection } from "@/lib/types";

const tokenConnection = {
  id: "ads",
  name: "ads",
  type: "googleads",
  host: "googleads.googleapis.com",
  database: "123-456-7890",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const serviceConnection = {
  ...tokenConnection,
  user: "123-456-7891",
  password: JSON.stringify({ client_email: "ads@project.iam.gserviceaccount.com", private_key: key }),
} as DatabaseConnection;

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: { url: string; method: string; body?: string; form?: Readonly<Record<string, string>> }[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: { url: string; method: string; body?: string; form?: Readonly<Record<string, string>> }[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
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
        closed.count += 1;
      },
    };
  };
  return { createTransport, requests, options, closed };
}

const probe = { results: [] };
const campaign = {
  results: [
    {
      campaign: { id: "9", name: "Brand", status: "ENABLED", advertisingChannelType: { nested: true } },
      metrics: { clicks: "4", impressions: 8, costMicros: "2500000", ctr: false },
      segments: { date: "2026-01-02" },
    },
  ],
  nextPageToken: "more",
};

describe("GoogleAdsProvider", () => {
  test("searches with a pasted token and reads the customer tree", async () => {
    const wire = scripted([
      { body: probe },
      { body: campaign },
      { body: { results: [{ campaign: { id: "1", name: "A" } }] } },
    ]);
    const opened = new GoogleAdsProvider(tokenConnection, {}, wire.createTransport);
    await opened.connect();
    await opened.connect();
    expect(wire.requests[0]?.url).toBe("https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search");
    expect(wire.requests[0]?.method).toBe("POST");
    expect(wire.requests[0]?.body).toContain("SELECT customer.id FROM customer LIMIT 1");
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "googleads.googleapis.com", port: 443 });
    expect(wire.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "googleads.googleapis.com" });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    expect(wire.options[0]?.refusesUpgrade).toBe(true);
    expect(wire.options[0]?.headers.Authorization).toBe("Bearer access-token-value");
    expect(wire.options[0]?.headers["login-customer-id"]).toBeUndefined();
    expect(await opened.listContainers()).toEqual([{ path: ["customer"], name: "customer", level: 0 }]);
    expect(await opened.listContainers(["customer"])).toEqual([]);
    expect(await opened.countObjects(["customer"])).toEqual({ table: { count: GOOGLE_ADS_RESOURCES.length } });
    const names = (await opened.listObjects(["customer"], "table")).map((object) => object.name);
    expect(names).toContain("keyword_view");
    const described = await opened.describeObject(["customer", "campaign"], "table");
    expect(described.columns.find((column) => column.name === "campaign.id")).toMatchObject({
      nullable: false,
      isPrimary: true,
      type: "varchar",
    });
    expect(described.columns.find((column) => column.name === "metrics.clicks")?.type).toBe("double");
    expect(await opened.describeObjects(["customer"], "table", 1)).toEqual({
      details: [await opened.describeObject(["customer", "customer"], "table")],
    });
    expect((await opened.describeObjects(["customer"], "table")).details).toHaveLength(GOOGLE_ADS_RESOURCES.length);
    await expect(opened.describeObjects(["customer"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObjects(["customer"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObject(["customer", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["customer"], "view")).rejects.toThrow(/no object kind/);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(opened.getLabels().searchPlaceholder).toContain("fields");
    expect((await opened.getOverview()).version).toBe("Google Ads API v26");
    expect((await opened.getOverview()).tableCount).toBe(GOOGLE_ADS_RESOURCES.length);
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/no maintenance/);
    const rows = await opened.query(
      "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.ctr, segments.date FROM campaign",
    );
    expect(rows.rows[0]).toMatchObject({
      "campaign.id": "9",
      "campaign.name": "Brand",
      "metrics.clicks": "4",
      "metrics.impressions": 8,
      "metrics.cost_micros": "2500000",
      "metrics.ctr": false,
      "segments.date": "2026-01-02",
    });
    expect(rows.rows[0]?.["campaign.advertising_channel_type"]).toBe('{"nested":true}');
    expect(wire.requests).toHaveLength(2);
    const star = await opened.query("SELECT * FROM campaign WHERE campaign.name = 'A'");
    expect(star.rows[0]?.["campaign.status"]).toBeNull();
    expect(star.fields).toContain("metrics.ctr");
    await expect(opened.query("DELETE FROM campaign")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT campaign.id FROM campaign", ["x"])).rejects.toThrow(/does not bind/);
    const skipped = await opened.query("SELECT campaign.id FROM campaign OFFSET 1000");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("1000");
    expect(wire.requests).toHaveLength(3);
    await opened.disconnect();
    await expect(opened.query("SELECT campaign.id FROM campaign")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
  });

  test("exchanges a service-account key, sends the manager id, and refreshes the token", async () => {
    let now = 1_000;
    const wire = scripted([
      { body: { access_token: "issued-token-one", expires_in: 3600 } },
      { body: probe },
      { body: { results: [] } },
      { body: { access_token: "issued-token-two", expires_in: 3600 } },
      { body: { results: [] } },
      { body: { results: [] } },
    ]);
    const opened = new GoogleAdsProvider(serviceConnection, {}, wire.createTransport, () => now);
    await opened.connect();
    expect(wire.requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(wire.requests[0]?.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(wire.options[0]?.origin.host).toBe("oauth2.googleapis.com");
    expect(wire.options[1]?.headers.Authorization).toBe("Bearer issued-token-one");
    expect(wire.options[1]?.headers["login-customer-id"]).toBe("1234567891");
    await opened.query("SELECT campaign.id FROM campaign LIMIT 10");
    expect(wire.requests).toHaveLength(3);
    now += 4_000_000;
    await opened.query("SELECT campaign.id FROM campaign LIMIT 10");
    expect(wire.requests[3]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(wire.options.at(-1)?.headers.Authorization).toBe("Bearer issued-token-two");
    expect(wire.closed.count).toBeGreaterThan(0);
    const capped = await opened.query("SELECT campaign.id FROM campaign LIMIT 5000 OFFSET 20");
    expect(capped.warnings?.[0]?.message).toContain("1000");
    expect(wire.requests.at(-1)?.body).toContain("LIMIT 1000");
    await opened.disconnect();
  });

  test("turns API failures into connection errors and hides the secret", async () => {
    const denied = scripted([{ status: 401, body: { error: { message: "access-token-value was rejected" } } }]);
    const provider = new GoogleAdsProvider(tokenConnection, {}, denied.createTransport);
    let caught: unknown;
    try {
      await provider.connect();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuthenticationError);
    expect(caught instanceof Error ? caught.message : "").toContain("••••");
    expect(caught instanceof Error ? caught.message : "").not.toContain("access-token-value");
    expect(denied.closed.count).toBe(1);
    const forbidden = scripted([{ status: 403, text: "not-json access-token-value" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, forbidden.createTransport).connect()).rejects.toThrow(
      PermissionDeniedError,
    );
    const limited = scripted([{ status: 429, body: {} }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, limited.createTransport).connect()).rejects.toThrow(
      /limiting requests/,
    );
    const plain = scripted([{ status: 500, body: { error: { message: "" } } }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, plain.createTransport).connect()).rejects.toThrow(
      /answered 500/,
    );
    const coded = scripted([{ status: 400, body: { message: 12 } }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, coded.createTransport).connect()).rejects.toThrow(
      QueryError,
    );
    const hugeMessage = scripted([{ status: 400, body: { error: { message: "m".repeat(400) } } }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, hugeMessage.createTransport).connect()).rejects.toThrow(
      QueryError,
    );
    const blank = scripted([{ status: 500, text: "" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, blank.createTransport).connect()).rejects.toThrow(
      /answered 500/,
    );
    const redirect = scripted([{ status: 302, text: "" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, redirect.createTransport).connect()).rejects.toThrow(
      ConnectionError,
    );
    const broken = scripted([{ status: 200, text: "not-json" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, broken.createTransport).connect()).rejects.toThrow(
      /not a list/,
    );
    const empty = scripted([{ status: 200, text: "" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, empty.createTransport).connect()).rejects.toThrow(
      /not a list/,
    );
    const shape = scripted([{ body: { results: "nope" } }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, shape.createTransport).connect()).rejects.toThrow(
      /not a list/,
    );
    const entry = scripted([{ body: { results: [] } }, { body: { results: ["nope"] } }]);
    const listed = new GoogleAdsProvider(tokenConnection, {}, entry.createTransport);
    await listed.connect();
    await expect(listed.query("SELECT customer.id FROM customer")).rejects.toThrow(/not a list/);
    const oversized = scripted([{ text: "x".repeat(API_ANSWER_LIMIT + 1) }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, oversized.createTransport).connect()).rejects.toThrow(
      /2 MB/,
    );
    const transport = scripted([{ throw: new TransportError("unreachable", "access-token-value down") }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, transport.createTransport).connect()).rejects.toThrow(
      /••••/,
    );
    const other = scripted([{ throw: "access-token-value down" }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, other.createTransport).connect()).rejects.toThrow(
      /could not be reached/,
    );
    const kept = scripted([{ throw: new DatabaseConfigError("kept", "googleads") }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, kept.createTransport).connect()).rejects.toThrow(/kept/);
    const queryError = scripted([{ throw: new QueryError("query failed", "googleads") }]);
    await expect(new GoogleAdsProvider(tokenConnection, {}, queryError.createTransport).connect()).rejects.toThrow(
      /query failed/,
    );
    const tokenRedirect = scripted([{ status: 302, text: "" }]);
    await expect(new GoogleAdsProvider(serviceConnection, {}, tokenRedirect.createTransport).connect()).rejects.toThrow(
      /redirect/,
    );
    const badKey = new GoogleAdsProvider(
      {
        ...tokenConnection,
        password: JSON.stringify({
          client_email: "ads@project.iam.gserviceaccount.com",
          private_key: "BEGIN PRIVATE KEY",
        }),
      },
      {},
      scripted([]).createTransport,
    );
    await expect(badKey.connect()).rejects.toThrow(/private_key could not be read/);
    expect(() => new GoogleAdsProvider({ ...tokenConnection, host: "evil.example" })).toThrow(DatabaseConfigError);
    expect(() => new GoogleAdsProvider({ ...tokenConnection, database: "123" })).toThrow(/10 digits/);
    expect(() => new GoogleAdsProvider({ ...tokenConnection, password: " " })).toThrow(DatabaseConfigError);
  });
});
