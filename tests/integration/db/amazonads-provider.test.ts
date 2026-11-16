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
import { AmazonAdsProvider } from "@/lib/db/providers/sql/amazonads";
import { AMAZON_ADS_RESOURCES } from "@/lib/db/providers/sql/amazonads/translate";
import type { DatabaseConnection } from "@/lib/types";

const CLIENT = "amzn1.application-oa2-client.example";
const SECRET = "client-secret-value";
const REFRESH = "Atzr|refresh-token-value";
const ACCESS = "Atza|access-token-value";

const connection = {
  id: "ads",
  name: "ads",
  type: "amazonads",
  host: "",
  user: CLIENT,
  password: SECRET,
  database: REFRESH,
  schema: "1234567890",
  createdAt: new Date(0),
} as DatabaseConnection;

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

interface SeenRequest {
  url: string;
  method: string;
  body?: string;
  form?: Readonly<Record<string, string>>;
  contentType?: string;
  headers?: Readonly<Record<string, string>>;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: SeenRequest[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: SeenRequest[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push({
          url: request.url,
          method: request.method,
          body: request.body,
          form: request.form,
          contentType: request.contentType,
          headers: request.headers,
        });
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

const token = { access_token: ACCESS, expires_in: 3600 };
const probe = { campaigns: [] };
const campaign = {
  campaigns: [
    {
      campaignId: 9,
      name: "Brand",
      state: "ENABLED",
      budget: { budget: "12.50", budgetType: "DAILY" },
      startDate: "2026-01-01",
    },
  ],
};

describe("AmazonAdsProvider", () => {
  test("reads campaigns with the access token kept off the token host", async () => {
    const wire = scripted([
      { body: token },
      { body: probe },
      { body: campaign },
      { body: { campaigns: [{ campaignId: "1", name: "A", state: "ENABLED" }] } },
      { body: { campaigns: [] } },
    ]);
    const opened = new AmazonAdsProvider(connection, {}, wire.createTransport);
    await expect(opened.query("SELECT campaign.name FROM campaign")).rejects.toThrow("Not connected");
    await expect(opened.getOverview()).rejects.toThrow("Not connected");
    await opened.connect();
    await opened.connect();
    expect(wire.requests).toHaveLength(2);
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.amazon.com/auth/O2/token",
      form: {
        grant_type: "refresh_token",
        refresh_token: REFRESH,
        client_id: CLIENT,
        client_secret: SECRET,
      },
    });
    expect(wire.requests[0]?.headers).toBeUndefined();
    expect(JSON.stringify(wire.options[0]?.headers)).not.toContain(SECRET);
    expect(JSON.stringify(wire.options[0]?.headers)).not.toContain(ACCESS);
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "api.amazon.com", port: 443 });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    expect(wire.options[0]?.refusesUpgrade).toBe(true);
    expect(wire.requests[1]).toMatchObject({
      method: "POST",
      url: "https://advertising-api.amazon.com/sp/campaigns/list",
      body: JSON.stringify({ maxResults: 100 }),
      contentType: "application/vnd.spCampaign.v3+json",
      headers: { Accept: "application/vnd.spCampaign.v3+json" },
    });
    expect(wire.requests[1]?.url).not.toContain(SECRET);
    expect(wire.requests[1]?.url).not.toContain(REFRESH);
    expect(wire.requests[1]?.body).not.toContain(SECRET);
    expect(wire.options[1]?.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS}`,
      "Amazon-Advertising-API-ClientId": CLIENT,
      "Amazon-Advertising-API-Scope": "1234567890",
    });
    expect(JSON.stringify(wire.options[1]?.headers)).not.toContain(SECRET);
    expect(JSON.stringify(wire.options[1]?.headers)).not.toContain(REFRESH);
    expect(wire.options[1]?.refusesLinkLocal).toBe(true);
    expect(wire.options[1]?.requestHeaderNames).toEqual(["Accept"]);
    const containers = await opened.listContainers();
    expect(containers).toEqual([{ path: ["profile"], name: "profile", level: 0 }]);
    expect(await opened.listContainers(["profile"])).toEqual([]);
    expect(await opened.countObjects(["profile"])).toEqual({ table: { count: AMAZON_ADS_RESOURCES.length } });
    const tables = await opened.listObjects(["profile"], "table");
    expect(tables.map((item) => item.name)).toEqual(["campaign", "ad_group", "product_ad"]);
    const described = await opened.describeObject(["profile", "campaign"], "table");
    expect(described.columns[0]).toMatchObject({
      name: "campaign.campaign_id",
      type: "varchar",
      isPrimary: true,
      nullable: false,
    });
    expect(described.columns.find((column) => column.name === "campaign.budget")).toMatchObject({ type: "double" });
    expect((await opened.describeObjects(["profile"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["profile"], "table")).details).toHaveLength(AMAZON_ADS_RESOURCES.length);
    await expect(opened.describeObjects(["profile"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["profile"], "table", 1.5)).rejects.toThrow(QueryError);
    await expect(opened.describeObject(["profile", "missing"], "table")).rejects.toThrow(QueryError);
    await expect(opened.listObjects(["profile"], "view")).rejects.toThrow(QueryError);
    expect(opened.getLabels().entityName).toBe("Table");
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect((await opened.getOverview()).version).toBe("Amazon Advertising API Sponsored Products v3");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow("Amazon Ads has no maintenance operation");
    const result = await opened.query(
      "SELECT campaign.name, campaign.budget, campaign.campaign_id FROM campaign WHERE campaign.state = 'ENABLED'",
    );
    expect(result.rows).toEqual([{ "campaign.name": "Brand", "campaign.budget": 12.5, "campaign.campaign_id": "9" }]);
    expect(wire.requests).toHaveLength(3);
    await expect(opened.query("DELETE FROM campaign")).rejects.toThrow(QueryError);
    await expect(opened.query("SELECT campaign.campaign_id FROM campaign", ["x"])).rejects.toThrow(QueryError);
    const skipped = await opened.query("SELECT campaign.campaign_id FROM campaign OFFSET 100");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("100");
    expect(wire.requests).toHaveLength(3);
    const wide = await opened.query("SELECT campaign.campaign_id FROM campaign LIMIT 500");
    expect(wide.warnings?.[0]?.message).toContain("100");
    expect(wire.requests).toHaveLength(4);
    const quiet = await opened.query("SELECT * FROM campaign");
    expect(quiet.warnings).toBeUndefined();
    expect(quiet.fields).toContain("campaign.name");
    await opened.disconnect();
    await opened.disconnect();
    await expect(opened.query("SELECT campaign.campaign_id FROM campaign")).rejects.toThrow("Not connected");
    await expect(opened.listContainers()).rejects.toThrow("Not connected");
  });

  test("opens a new transport when the profile changes and warns when another page exists", async () => {
    const wire = scripted([
      { body: token },
      { body: probe },
      { body: { adGroups: [{ adGroupId: "4", name: "Group", defaultBid: "1.5" }], nextToken: "more" } },
      { body: { productAds: [{ adId: "8", asin: "B000", state: "ENABLED" }], nextToken: "" } },
      { body: { campaigns: [], nextToken: 1 } },
      { body: { campaigns: [] } },
      { body: { campaigns: [] } },
    ]);
    const opened = new AmazonAdsProvider(
      { ...connection, host: "advertising-api-eu.amazon.com" },
      {},
      wire.createTransport,
    );
    await opened.connect();
    expect(wire.requests[1]?.url).toContain("https://advertising-api-eu.amazon.com/sp/campaigns/list");
    const group = await opened.query("SELECT ad_group.name, ad_group.default_bid FROM ad_group");
    expect(wire.requests[2]?.url).toContain("/sp/adGroups/list");
    expect(wire.requests[2]?.contentType).toBe("application/vnd.spAdGroup.v3+json");
    expect(group.rows).toEqual([{ "ad_group.name": "Group", "ad_group.default_bid": 1.5 }]);
    expect(group.warnings?.[0]?.message).toContain("100");
    const ad = await opened.query("SELECT product_ad.asin FROM product_ad");
    expect(wire.requests[3]?.contentType).toBe("application/vnd.spProductAd.v3+json");
    expect(ad.rows).toEqual([{ "product_ad.asin": "B000" }]);
    expect(ad.warnings).toBeUndefined();
    const numbered = await opened.query("SELECT campaign.campaign_id FROM campaign");
    expect(numbered.warnings).toBeUndefined();
    expect(wire.closed.count).toBe(0);
    (opened as unknown as { config: DatabaseConnection }).config.schema = "42";
    await opened.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(wire.closed.count).toBe(1);
    expect(wire.options.at(-1)?.headers?.["Amazon-Advertising-API-Scope"]).toBe("42");
    expect(wire.requests.filter((item) => item.url.includes("/auth/"))).toHaveLength(1);
    (opened as unknown as { config: DatabaseConnection }).config.user = "amzn1.application-oa2-client.second";
    await opened.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(wire.options.at(-1)?.headers?.["Amazon-Advertising-API-ClientId"]).toBe(
      "amzn1.application-oa2-client.second",
    );
  });

  test("asks for a new access token once the cached one is due", async () => {
    const wire = scripted([
      { body: { access_token: ACCESS, expires_in: 3600 } },
      { body: probe },
      { body: { access_token: "Atza|second-token", expires_in: 30 } },
      { body: { campaigns: [] } },
    ]);
    const opened = new AmazonAdsProvider(connection, {}, wire.createTransport);
    await opened.connect();
    (opened as unknown as { grant: { until: number } }).grant.until = 0;
    await opened.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(wire.requests.filter((item) => item.url.includes("/auth/"))).toHaveLength(2);
    expect(wire.options.at(-1)?.headers?.Authorization).toBe("Bearer Atza|second-token");
    expect(wire.requests[2]?.form?.refresh_token).toBe(REFRESH);
    expect(wire.requests[3]?.url).not.toContain(REFRESH);
  });

  test("keeps a token whose lifetime is zero or omitted, and refreshes one that is already due", async () => {
    const held = scripted([{ body: { access_token: ACCESS } }, { body: probe }, { body: { campaigns: [] } }]);
    const omitted = new AmazonAdsProvider(connection, {}, held.createTransport);
    await omitted.connect();
    await omitted.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(held.requests.filter((item) => item.url.includes("/auth/"))).toHaveLength(1);
    await omitted.disconnect();

    const zero = scripted([
      { body: { access_token: ACCESS, expires_in: 0 } },
      { body: probe },
      { body: { campaigns: [] } },
    ]);
    const kept = new AmazonAdsProvider(connection, {}, zero.createTransport);
    await kept.connect();
    await kept.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(zero.requests.filter((item) => item.url.includes("/auth/"))).toHaveLength(1);

    const soon = scripted([
      { body: { access_token: ACCESS, expires_in: -5 } },
      { body: probe },
      { body: { campaigns: [] } },
    ]);
    const negative = new AmazonAdsProvider(connection, {}, soon.createTransport);
    await negative.connect();
    await negative.query("SELECT campaign.campaign_id FROM campaign LIMIT 1");
    expect(soon.requests.filter((item) => item.url.includes("/auth/"))).toHaveLength(1);
  });

  test("refuses a bad answer without repeating the secret or the token", async () => {
    const fail = async (pages: ScriptedPage[], host = ""): Promise<unknown> => {
      const wire = scripted(pages);
      const opened = new AmazonAdsProvider({ ...connection, host }, {}, wire.createTransport);
      try {
        await opened.connect();
        return await opened.query("SELECT campaign.campaign_id FROM campaign");
      } catch (error) {
        return error;
      }
    };
    const tokenThen = (page: ScriptedPage): ScriptedPage[] => [{ body: token }, page];
    const denied = await fail(tokenThen({ status: 401, text: `${ACCESS} ${SECRET} ${REFRESH} ${CLIENT} rejected` }));
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect((denied as Error).message).not.toContain(ACCESS);
    expect((denied as Error).message).not.toContain(SECRET);
    expect((denied as Error).message).not.toContain(REFRESH);
    expect(await fail(tokenThen({ status: 403, text: "no" }))).toBeInstanceOf(PermissionDeniedError);
    expect(((await fail(tokenThen({ status: 429, text: "" }))) as Error).message).toContain("limiting");
    expect(((await fail(tokenThen({ status: 500, text: "" }))) as Error).message).toContain("500");
    expect(((await fail(tokenThen({ status: 400, text: "x".repeat(400) }))) as Error).message.length).toBeLessThan(400);
    expect(((await fail(tokenThen({ status: 400, text: "[1,2]" }))) as Error).message).toContain("400");
    expect(
      ((await fail(tokenThen({ status: 400, body: { message: "m".repeat(400) } }))) as Error).message.length,
    ).toBeLessThan(400);
    expect(((await fail(tokenThen({ status: 400, body: { message: "short" } }))) as Error).message).toContain("short");
    expect(
      ((await fail(tokenThen({ status: 400, body: { message: "", errors: [{ message: "e".repeat(400) }] } }))) as Error)
        .message.length,
    ).toBeLessThan(400);
    expect(
      ((await fail(tokenThen({ status: 400, body: { errors: [{ message: "from-list" }] } }))) as Error).message,
    ).toContain("from-list");
    expect(((await fail(tokenThen({ status: 400, body: { message: 1 } }))) as Error).message).toContain("400");
    expect(((await fail(tokenThen({ status: 400, body: { errors: "no" } }))) as Error).message).toContain("400");
    expect(((await fail(tokenThen({ status: 400, body: { errors: [{}] } }))) as Error).message).toContain("400");
    expect(((await fail(tokenThen({ status: 400, body: { errors: [{ message: "" }] } }))) as Error).message).toContain(
      "400",
    );
    expect(await fail(tokenThen({ status: 200, body: [] }))).toBeInstanceOf(ConnectionError);
    expect(await fail(tokenThen({ status: 200, text: "not-json" }))).toBeInstanceOf(QueryError);
    expect(await fail(tokenThen({ status: 200, text: "" }))).toBeInstanceOf(ConnectionError);
    expect(await fail(tokenThen({ status: 200, body: { campaigns: "nope" } }))).toBeInstanceOf(ConnectionError);
    expect(await fail(tokenThen({ status: 302, text: "" }))).toBeInstanceOf(ConnectionError);
    expect(
      ((await fail(tokenThen({ status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) }))) as Error).message,
    ).toContain("2 MB");
    const reached = await fail(tokenThen({ throw: new TransportError("unreachable", `${SECRET} failed`) }));
    expect(reached).toBeInstanceOf(ConnectionError);
    expect((reached as Error).message).not.toContain(SECRET);
    expect(await fail(tokenThen({ throw: new TransportError("redirect", SECRET) }))).toBeInstanceOf(ConnectionError);
    expect(((await fail(tokenThen({ throw: new TransportError("redirect", SECRET) }))) as Error).message).not.toContain(
      SECRET,
    );
    expect(((await fail(tokenThen({ throw: new TransportError("too-large", SECRET) }))) as Error).message).toContain(
      "2 MB",
    );
    expect(((await fail(tokenThen({ throw: "down" }))) as Error).message).toContain("could not be reached");
    expect(await fail(tokenThen({ throw: new QueryError("query failed", "amazonads") }))).toBeInstanceOf(QueryError);
    expect(await fail(tokenThen({ throw: new DatabaseConfigError("kept", "amazonads") }))).toBeInstanceOf(
      DatabaseConfigError,
    );
    expect(await fail(tokenThen({ throw: new AuthenticationError("kept", "amazonads") }))).toBeInstanceOf(
      AuthenticationError,
    );
    expect(await fail(tokenThen({ throw: new PermissionDeniedError("kept", "amazonads") }))).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(await fail(tokenThen({ throw: new ConnectionError("kept", "amazonads") }))).toBeInstanceOf(ConnectionError);
    expect(await fail(tokenThen({ throw: new Error(`${REFRESH} socket`) }))).toBeInstanceOf(ConnectionError);
    expect(((await fail(tokenThen({ throw: new Error(REFRESH) }))) as Error).message).not.toContain(REFRESH);
    const nested = scripted([{ body: token }, { body: probe }, { body: { adGroups: "nope" } }]);
    const opened = new AmazonAdsProvider(connection, {}, nested.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT ad_group.name FROM ad_group")).rejects.toThrow("not a list");
    expect(await fail([{ status: 401, text: SECRET }])).toBeInstanceOf(AuthenticationError);
    expect(((await fail([{ status: 401, text: SECRET }])) as Error).message).not.toContain(SECRET);
    expect(await fail([{ status: 302, text: SECRET }])).toBeInstanceOf(ConnectionError);
    expect(((await fail([{ status: 500, text: SECRET }])) as Error).message).not.toContain(SECRET);
    expect(await fail([{ status: 200, text: "not-json" }])).toBeInstanceOf(ConnectionError);
    expect(await fail([{ status: 200, text: "[]" }])).toBeInstanceOf(ConnectionError);
    expect(await fail([{ status: 200, body: { access_token: "" } }])).toBeInstanceOf(AuthenticationError);
    expect(await fail([{ status: 200, body: { access_token: 1 } }])).toBeInstanceOf(AuthenticationError);
    expect(await fail([{ status: 200, body: { access_token: "bad token" } }])).toBeInstanceOf(ConnectionError);
    expect(await fail([{ status: 200, body: { access_token: "x".repeat(1025) } }])).toBeInstanceOf(ConnectionError);
    expect(((await fail([{ throw: new TransportError("unreachable", SECRET) }])) as Error).message).not.toContain(
      SECRET,
    );
    expect(
      () => new AmazonAdsProvider({ ...connection, host: "https://evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new AmazonAdsProvider({ ...connection, password: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
    expect(() => new AmazonAdsProvider({ ...connection, schema: "0" }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
    const fe = new AmazonAdsProvider(
      { ...connection, host: "advertising-api-fe.amazon.com" },
      {},
      scripted([]).createTransport,
    );
    expect(fe.getLabels().entityNamePlural).toBe("Tables");
  });
});
