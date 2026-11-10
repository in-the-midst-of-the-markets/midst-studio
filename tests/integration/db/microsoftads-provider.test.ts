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
import { MicrosoftAdsProvider } from "@/lib/db/providers/sql/microsoftads";
import { MICROSOFT_ADS_RESOURCES } from "@/lib/db/providers/sql/microsoftads/translate";
import type { DatabaseConnection } from "@/lib/types";

const password = JSON.stringify({ accessToken: "access-token-value", developerToken: "BBD37VB98" });

const connection = {
  id: "ads",
  name: "ads",
  type: "microsoftads",
  host: "campaign.api.bingads.microsoft.com",
  user: "123456",
  database: "7654321",
  password,
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

const probe = { Campaigns: [] };
const campaign = {
  Campaigns: [
    {
      Id: 9,
      Name: "Brand",
      Status: "Active",
      CampaignType: "Search",
      BudgetType: "DailyBudgetStandard",
      DailyBudget: 12.5,
    },
  ],
};

describe("MicrosoftAdsProvider", () => {
  test("reads campaigns with the two tokens and the account tree", async () => {
    const wire = scripted([
      { body: probe },
      { body: campaign },
      { body: { Campaigns: [{ Id: 1, Name: "A", Status: "Paused" }] } },
    ]);
    const opened = new MicrosoftAdsProvider(connection, {}, wire.createTransport);
    await opened.connect();
    await opened.connect();
    expect(wire.requests[0]?.url).toBe(
      "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId",
    );
    expect(wire.requests[0]?.method).toBe("POST");
    expect(wire.requests[0]?.body).toContain('"AccountId":7654321');
    expect(wire.requests[0]?.body).toContain("PerformanceMax");
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "campaign.api.bingads.microsoft.com", port: 443 });
    expect(wire.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "campaign.api.bingads.microsoft.com" });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    expect(wire.options[0]?.refusesUpgrade).toBe(true);
    expect(wire.options[0]?.headers.Authorization).toBe("Bearer access-token-value");
    expect(wire.options[0]?.headers.DeveloperToken).toBe("BBD37VB98");
    expect(wire.options[0]?.headers.CustomerId).toBe("123456");
    expect(wire.options[0]?.headers.CustomerAccountId).toBe("7654321");
    expect(await opened.listContainers()).toEqual([{ path: ["account"], name: "account", level: 0 }]);
    expect(await opened.listContainers(["account"])).toEqual([]);
    expect(await opened.countObjects(["account"])).toEqual({ table: { count: MICROSOFT_ADS_RESOURCES.length } });
    const names = (await opened.listObjects(["account"], "table")).map((object) => object.name);
    expect(names).toContain("keyword");
    const described = await opened.describeObject(["account", "campaign"], "table");
    expect(described.columns.find((column) => column.name === "campaign.id")).toMatchObject({
      nullable: false,
      isPrimary: true,
      type: "double",
    });
    expect(described.columns.find((column) => column.name === "campaign.name")?.type).toBe("varchar");
    expect(await opened.describeObjects(["account"], "table", 1)).toEqual({
      details: [await opened.describeObject(["account", "campaign"], "table")],
    });
    expect((await opened.describeObjects(["account"], "table")).details).toHaveLength(MICROSOFT_ADS_RESOURCES.length);
    await expect(opened.describeObjects(["account"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObjects(["account"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObject(["account", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["account"], "view")).rejects.toThrow(/no object kind/);
    expect(opened.getLabels().entityName).toBe("Table");
    expect((await opened.getOverview()).version).toBe("Microsoft Advertising API v13");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    const result = await opened.query(
      "SELECT campaign.name, campaign.daily_budget FROM campaign WHERE campaign.status = 'Active'",
    );
    expect(result.rows[0]).toEqual({ "campaign.name": "Brand", "campaign.daily_budget": 12.5 });
    await expect(opened.query("DELETE FROM campaign")).rejects.toThrow(QueryError);
    await expect(opened.query("SELECT campaign.id FROM campaign", ["x"])).rejects.toThrow(/parameters/);
    const skipped = await opened.query("SELECT campaign.id FROM campaign OFFSET 1000");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("1000");
    expect(wire.requests).toHaveLength(2);
    const wide = await opened.query("SELECT campaign.name FROM campaign LIMIT 5000");
    expect(wire.requests).toHaveLength(3);
    expect(wide.warnings?.[0]?.message).toContain("1000");
    await opened.disconnect();
    await expect(opened.query("SELECT campaign.id FROM campaign")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
  });

  test("lists one ad group, one ad and one keyword, and reopens when the token changes", async () => {
    const wire = scripted([
      { body: probe },
      { body: { AdGroups: [{ Id: 8, Name: "Alpha", Status: "Active" }] } },
      { body: { Ads: [{ Id: 3, Type: "ResponsiveSearch", Status: "Active", EditorialStatus: "Active" }] } },
      { body: { Keywords: [{ Id: 5, Text: "shoes", MatchType: "Exact", Status: "Active" }] } },
      { body: probe },
      { body: { Campaigns: [] } },
    ]);
    const opened = new MicrosoftAdsProvider(
      { ...connection, host: "campaign.api.sandbox.bingads.microsoft.com" },
      {},
      wire.createTransport,
    );
    await opened.connect();
    const groups = await opened.query("SELECT ad_group.name, campaign.id FROM ad_group WHERE campaign.id = 15");
    expect(wire.requests[1]?.url).toContain(
      "sandbox.bingads.microsoft.com/CampaignManagement/v13/AdGroups/QueryByCampaignId",
    );
    expect(wire.requests[1]?.body).toBe('{"CampaignId":15}');
    expect(groups.rows[0]).toEqual({ "ad_group.name": "Alpha", "campaign.id": 15 });
    const ads = await opened.query("SELECT ad.type FROM ad WHERE ad_group.id = 4");
    expect(ads.rows[0]?.["ad.type"]).toBe("ResponsiveSearch");
    const words = await opened.query(
      "SELECT keyword.text FROM keyword WHERE ad_group.id = 4 ORDER BY keyword.text ASC",
    );
    expect(words.rows[0]?.["keyword.text"]).toBe("shoes");
    expect(wire.options).toHaveLength(1);
    (opened as unknown as { config: DatabaseConnection }).config.password = JSON.stringify({
      accessToken: "second-access-token",
      developerToken: "BBD37VB98",
    });
    await opened.query("SELECT campaign.id FROM campaign LIMIT 1");
    expect(wire.closed.count).toBe(1);
    expect(wire.options[1]?.headers.Authorization).toBe("Bearer second-access-token");
  });

  test("reports a failed read without repeating the token", async () => {
    const cases: { page: ScriptedPage; error: new (...args: never[]) => Error; text: string }[] = [
      { page: { status: 401, body: { message: "no access-token-value" } }, error: AuthenticationError, text: "no" },
      { page: { status: 403, text: "forbidden" }, error: PermissionDeniedError, text: "forbidden" },
      { page: { status: 429, body: {} }, error: QueryError, text: "limiting" },
      { page: { status: 500, text: "" }, error: QueryError, text: "500" },
      { page: { status: 400, body: { message: "m".repeat(400) } }, error: QueryError, text: "m" },
      { page: { status: 400, body: { message: 1 } }, error: QueryError, text: "400" },
      {
        page: { status: 200, body: { Errors: [{ Message: "bad access-token-value" }] } },
        error: QueryError,
        text: "bad",
      },
      { page: { status: 200, body: { Errors: [{}] } }, error: QueryError, text: "200" },
      { page: { status: 200, text: "not-json" }, error: QueryError, text: "not a list" },
      { page: { status: 200, text: "" }, error: ConnectionError, text: "not a list" },
      { page: { status: 200, body: { Campaigns: "nope" } }, error: ConnectionError, text: "not a list" },
      { page: { status: 302, text: "" }, error: ConnectionError, text: "redirect" },
      { page: { status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) }, error: QueryError, text: "2 MB" },
    ];
    for (const item of cases) {
      const wire = scripted([item.page]);
      const opened = new MicrosoftAdsProvider(connection, {}, wire.createTransport);
      let thrown: unknown;
      try {
        await opened.connect();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(item.error);
      expect(thrown instanceof Error ? thrown.message : "").toContain(item.text);
      expect(thrown instanceof Error ? thrown.message : "").not.toContain("access-token-value");
    }
    const transport = scripted([{ throw: new TransportError("unreachable", "access-token-value failed") }]);
    const reached = new MicrosoftAdsProvider(connection, {}, transport.createTransport);
    await expect(reached.connect()).rejects.toThrow(ConnectionError);
    const other = scripted([{ throw: "down" }]);
    await expect(new MicrosoftAdsProvider(connection, {}, other.createTransport).connect()).rejects.toThrow(
      /could not be reached/,
    );
    const query = scripted([{ throw: new QueryError("kept", "microsoftads") }]);
    await expect(new MicrosoftAdsProvider(connection, {}, query.createTransport).connect()).rejects.toThrow(/kept/);
    const config = scripted([{ throw: new DatabaseConfigError("kept config", "microsoftads") }]);
    await expect(new MicrosoftAdsProvider(connection, {}, config.createTransport).connect()).rejects.toThrow(
      /kept config/,
    );
    const nested = scripted([{ body: probe }, { body: { AdGroups: ["nope"] } }]);
    const listing = new MicrosoftAdsProvider(connection, {}, nested.createTransport);
    await listing.connect();
    await expect(listing.query("SELECT ad_group.id FROM ad_group WHERE campaign.id = 4")).rejects.toThrow(/not a list/);
    expect(
      () => new MicrosoftAdsProvider({ ...connection, host: "evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new MicrosoftAdsProvider({ ...connection, database: "0" }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
    expect(() => new MicrosoftAdsProvider({ ...connection, password: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
  });
});
