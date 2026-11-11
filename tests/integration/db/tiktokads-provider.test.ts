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
import { TikTokAdsProvider } from "@/lib/db/providers/sql/tiktokads";
import { TIKTOK_ADS_RESOURCES } from "@/lib/db/providers/sql/tiktokads/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "tt",
  name: "tt",
  type: "tiktokads",
  host: "",
  user: "",
  database: "7123456789",
  password: "access-token-value",
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

const probe = { code: 0, message: "OK", data: { list: [], page_info: { total_page: 1 } } };
const campaign = {
  code: 0,
  message: "OK",
  data: {
    list: [{ campaign_id: "9", campaign_name: "Brand", operation_status: "ENABLE", budget: 12.5 }],
    page_info: { total_page: 1 },
  },
};

describe("TikTokAdsProvider", () => {
  test("reads campaigns with the access token and the advertiser tree", async () => {
    const wire = scripted([
      { body: probe },
      { body: campaign },
      {
        body: {
          code: 0,
          message: "OK",
          data: { list: [{ campaign_id: "1", campaign_name: "A" }], page_info: { total_page: 1 } },
        },
      },
    ]);
    const opened = new TikTokAdsProvider(connection, {}, wire.createTransport);
    await opened.connect();
    await opened.connect();
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.url).toContain("https://business-api.tiktok.com/open_api/v1.3/campaign/get/?");
    expect(wire.requests[0]?.url).toContain("advertiser_id=7123456789");
    expect(wire.requests[0]?.url).toContain("page_size=1000");
    expect(wire.requests[0]?.url).toContain("campaign_id");
    expect(wire.requests[0]?.url).not.toContain("access-token-value");
    expect(wire.requests[0]?.method).toBe("GET");
    expect(wire.options[0]?.headers?.["Access-Token"]).toBe("access-token-value");
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "business-api.tiktok.com", port: 443 });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    const containers = await opened.listContainers();
    expect(containers).toEqual([{ path: ["advertiser"], name: "advertiser", level: 0 }]);
    expect(await opened.listContainers(["advertiser"])).toEqual([]);
    expect(await opened.countObjects(["advertiser"])).toEqual({ table: { count: TIKTOK_ADS_RESOURCES.length } });
    const tables = await opened.listObjects(["advertiser"], "table");
    expect(tables.map((item) => item.name)).toEqual(["campaign", "ad_group", "ad"]);
    const described = await opened.describeObject(["advertiser", "campaign"], "table");
    expect(described.columns[0]).toMatchObject({
      name: "campaign.id",
      type: "varchar",
      isPrimary: true,
      nullable: false,
    });
    expect(described.columns.find((column) => column.name === "campaign.budget")).toMatchObject({ type: "double" });
    expect((await opened.describeObjects(["advertiser"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["advertiser"], "table")).details).toHaveLength(TIKTOK_ADS_RESOURCES.length);
    await expect(opened.describeObjects(["advertiser"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["advertiser"], "table", 1.5)).rejects.toThrow(QueryError);
    await expect(opened.describeObject(["advertiser", "missing"], "table")).rejects.toThrow(QueryError);
    await expect(opened.listObjects(["advertiser"], "view")).rejects.toThrow(QueryError);
    expect(opened.getLabels().entityName).toBe("Table");
    expect((await opened.getOverview()).version).toBe("TikTok Marketing API v1.3");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow("TikTok Ads has no maintenance operation");
    const result = await opened.query(
      "SELECT campaign.name, campaign.budget FROM campaign WHERE campaign.operation_status = 'ENABLE'",
    );
    expect(result.rows).toEqual([{ "campaign.name": "Brand", "campaign.budget": 12.5 }]);
    await expect(opened.query("DELETE FROM campaign")).rejects.toThrow(QueryError);
    await expect(opened.query("SELECT campaign.id FROM campaign", ["x"])).rejects.toThrow(QueryError);
    const skipped = await opened.query("SELECT campaign.id FROM campaign OFFSET 1000");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("1000");
    expect(wire.requests).toHaveLength(2);
    const wide = await opened.query("SELECT campaign.id FROM campaign LIMIT 5000");
    expect(wide.warnings?.[0]?.message).toContain("1000");
    expect(wire.requests).toHaveLength(3);
    await opened.disconnect();
    await expect(opened.query("SELECT campaign.id FROM campaign")).rejects.toThrow("Not connected");
    await expect(opened.getOverview()).rejects.toThrow("Not connected");
  });

  test("opens a new transport when the token or the advertiser changes", async () => {
    const wire = scripted([
      { body: probe },
      {
        body: {
          code: 0,
          message: "OK",
          data: { list: [{ adgroup_id: "4", adgroup_name: "Group" }], page_info: { total_page: 2 } },
        },
      },
      { body: { code: 0, message: "OK", data: { list: [] } } },
      { body: probe },
    ]);
    const opened = new TikTokAdsProvider({ ...connection }, {}, wire.createTransport);
    await opened.connect();
    const group = await opened.query("SELECT ad_group.name FROM ad_group");
    expect(wire.requests[1]?.url).toContain("/open_api/v1.3/adgroup/get/");
    expect(group.rows).toEqual([{ "ad_group.name": "Group" }]);
    expect(group.warnings?.[0]?.message).toContain("1000");
    const empty = await opened.query("SELECT ad.name FROM ad");
    expect(empty.rows).toEqual([]);
    expect(empty.warnings).toBeUndefined();
    expect(wire.closed.count).toBe(0);
    (opened as unknown as { config: DatabaseConnection }).config.password = "second-access-token";
    await opened.query("SELECT campaign.id FROM campaign LIMIT 1");
    expect(wire.closed.count).toBe(1);
    expect(wire.options.at(-1)?.headers?.["Access-Token"]).toBe("second-access-token");
  });

  test("refuses a bad answer without repeating the token", async () => {
    const fail = async (page: ScriptedPage, host = ""): Promise<unknown> => {
      const wire = scripted([page]);
      const opened = new TikTokAdsProvider({ ...connection, host }, {}, wire.createTransport);
      try {
        await opened.connect();
        return await opened.query("SELECT campaign.id FROM campaign");
      } catch (error) {
        return error;
      }
    };
    const denied = await fail({ status: 401, text: "access-token-value rejected" });
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect((denied as Error).message).not.toContain("access-token-value");
    expect(await fail({ status: 403, text: "no" })).toBeInstanceOf(PermissionDeniedError);
    expect(((await fail({ status: 429, text: "" })) as Error).message).toContain("limiting");
    expect(((await fail({ status: 500, text: "" })) as Error).message).toContain("500");
    expect(((await fail({ status: 400, body: { message: "m".repeat(400) } })) as Error).message.length).toBeLessThan(
      400,
    );
    expect(((await fail({ status: 400, body: { message: 1 } })) as Error).message).toContain("400");
    const failed = await fail({ status: 200, body: { code: 40105, message: "access-token-value bad" } });
    expect(failed).toBeInstanceOf(QueryError);
    expect((failed as Error).message).not.toContain("access-token-value");
    expect(((await fail({ status: 200, body: { code: 40001 } })) as Error).message).toContain("200");
    expect(await fail({ status: 200, body: [] })).toBeInstanceOf(QueryError);
    expect(await fail({ status: 200, text: "not-json" })).toBeInstanceOf(QueryError);
    expect(await fail({ status: 200, text: "" })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 200, body: { code: 0, data: { list: "nope" } } })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 302, text: "" })).toBeInstanceOf(ConnectionError);
    expect(((await fail({ status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) })) as Error).message).toContain("2 MB");
    const reached = await fail({ throw: new TransportError("unreachable", "access-token-value failed") });
    expect(reached).toBeInstanceOf(ConnectionError);
    expect((reached as Error).message).not.toContain("access-token-value");
    expect(((await fail({ throw: "down" })) as Error).message).toContain("could not be reached");
    expect(await fail({ throw: new QueryError("query failed", "tiktokads") })).toBeInstanceOf(QueryError);
    expect(await fail({ throw: new DatabaseConfigError("kept", "tiktokads") })).toBeInstanceOf(DatabaseConfigError);
    const nested = scripted([{ body: probe }, { body: { code: 0, message: "OK", data: { list: "nope" } } }]);
    const opened = new TikTokAdsProvider(connection, {}, nested.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT ad.id FROM ad")).rejects.toThrow("not a list");
    expect(
      () => new TikTokAdsProvider({ ...connection, host: "https://evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new TikTokAdsProvider({ ...connection, password: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
    expect(() => new TikTokAdsProvider({ ...connection, database: "0" }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
  });
});
