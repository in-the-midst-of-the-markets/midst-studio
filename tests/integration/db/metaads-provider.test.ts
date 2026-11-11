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
import { MetaAdsProvider } from "@/lib/db/providers/sql/metaads";
import { META_ADS_RESOURCES } from "@/lib/db/providers/sql/metaads/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "meta",
  name: "meta",
  type: "metaads",
  host: "",
  user: "",
  database: "act_100539998049706",
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

const probe = { data: [] };
const campaign = {
  data: [{ id: "9", name: "Brand", status: "ACTIVE", daily_budget: "1250" }],
};

describe("MetaAdsProvider", () => {
  test("reads campaigns with the access token and the account tree", async () => {
    const wire = scripted([{ body: probe }, { body: campaign }, { body: { data: [{ id: "1", name: "A" }] } }]);
    const opened = new MetaAdsProvider(connection, {}, wire.createTransport);
    await opened.connect();
    await opened.connect();
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.url).toContain("https://graph.facebook.com/v27.0/act_100539998049706/campaigns?");
    expect(wire.requests[0]?.url).toContain("limit=1000");
    expect(wire.requests[0]?.url).toContain("fields=");
    expect(wire.requests[0]?.url).not.toContain("access-token-value");
    expect(wire.requests[0]?.method).toBe("GET");
    expect(wire.options[0]?.headers?.Authorization).toBe("Bearer access-token-value");
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "graph.facebook.com", port: 443 });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    const containers = await opened.listContainers();
    expect(containers).toEqual([{ path: ["account"], name: "account", level: 0 }]);
    expect(await opened.listContainers(["account"])).toEqual([]);
    expect(await opened.countObjects(["account"])).toEqual({ table: { count: META_ADS_RESOURCES.length } });
    const tables = await opened.listObjects(["account"], "table");
    expect(tables.map((item) => item.name)).toEqual(["campaign", "ad_set", "ad"]);
    const described = await opened.describeObject(["account", "campaign"], "table");
    expect(described.columns[0]).toMatchObject({
      name: "campaign.id",
      type: "varchar",
      isPrimary: true,
      nullable: false,
    });
    expect(described.columns.find((column) => column.name === "campaign.daily_budget")).toMatchObject({
      type: "double",
    });
    expect((await opened.describeObjects(["account"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["account"], "table")).details).toHaveLength(META_ADS_RESOURCES.length);
    await expect(opened.describeObjects(["account"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["account"], "table", 1.5)).rejects.toThrow(QueryError);
    await expect(opened.describeObject(["account", "missing"], "table")).rejects.toThrow(QueryError);
    await expect(opened.listObjects(["account"], "view")).rejects.toThrow(QueryError);
    expect(opened.getLabels().entityName).toBe("Table");
    expect((await opened.getOverview()).version).toBe("Meta Marketing API v27.0");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow("Meta Ads has no maintenance operation");
    const result = await opened.query(
      "SELECT campaign.name, campaign.daily_budget FROM campaign WHERE campaign.status = 'ACTIVE'",
    );
    expect(result.rows).toEqual([{ "campaign.name": "Brand", "campaign.daily_budget": 1250 }]);
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

  test("opens a new transport when the token changes and warns when another page exists", async () => {
    const wire = scripted([
      { body: probe },
      { body: { data: [{ id: "4", name: "Group" }], paging: { next: "https://graph.facebook.com/v27.0/next" } } },
      { body: { data: [] } },
      { body: probe },
    ]);
    const opened = new MetaAdsProvider({ ...connection }, {}, wire.createTransport);
    await opened.connect();
    const group = await opened.query("SELECT ad_set.name FROM ad_set");
    expect(wire.requests[1]?.url).toContain("/v27.0/act_100539998049706/adsets?");
    expect(group.rows).toEqual([{ "ad_set.name": "Group" }]);
    expect(group.warnings?.[0]?.message).toContain("1000");
    const empty = await opened.query("SELECT ad.name FROM ad");
    expect(wire.requests[2]?.url).toContain("/ads?");
    expect(empty.rows).toEqual([]);
    expect(empty.warnings).toBeUndefined();
    expect(wire.closed.count).toBe(0);
    (opened as unknown as { config: DatabaseConnection }).config.password = "second-access-token";
    await opened.query("SELECT campaign.id FROM campaign LIMIT 1");
    expect(wire.closed.count).toBe(1);
    expect(wire.options.at(-1)?.headers?.Authorization).toBe("Bearer second-access-token");
  });

  test("refuses a bad answer without repeating the token", async () => {
    const fail = async (page: ScriptedPage, host = ""): Promise<unknown> => {
      const wire = scripted([page]);
      const opened = new MetaAdsProvider({ ...connection, host }, {}, wire.createTransport);
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
    expect(
      ((await fail({ status: 400, body: { error: { message: "m".repeat(400) } } })) as Error).message.length,
    ).toBeLessThan(400);
    expect(((await fail({ status: 400, body: { error: { message: 1 } } })) as Error).message).toContain("400");
    const failed = await fail({ status: 200, body: { error: { message: "access-token-value bad", code: 190 } } });
    expect(failed).toBeInstanceOf(QueryError);
    expect((failed as Error).message).not.toContain("access-token-value");
    expect(((await fail({ status: 200, body: { error: { message: "" } } })) as Error).message).toContain("200");
    expect(await fail({ status: 200, body: [] })).toBeInstanceOf(QueryError);
    expect(await fail({ status: 200, text: "not-json" })).toBeInstanceOf(QueryError);
    expect(await fail({ status: 200, text: "" })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 200, body: { data: "nope" } })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 302, text: "" })).toBeInstanceOf(ConnectionError);
    expect(((await fail({ status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) })) as Error).message).toContain("2 MB");
    const reached = await fail({ throw: new TransportError("unreachable", "access-token-value failed") });
    expect(reached).toBeInstanceOf(ConnectionError);
    expect((reached as Error).message).not.toContain("access-token-value");
    expect(((await fail({ throw: "down" })) as Error).message).toContain("could not be reached");
    expect(await fail({ throw: new QueryError("query failed", "metaads") })).toBeInstanceOf(QueryError);
    expect(await fail({ throw: new DatabaseConfigError("kept", "metaads") })).toBeInstanceOf(DatabaseConfigError);
    expect(await fail({ throw: new AuthenticationError("kept", "metaads") })).toBeInstanceOf(AuthenticationError);
    expect(await fail({ throw: new PermissionDeniedError("kept", "metaads") })).toBeInstanceOf(PermissionDeniedError);
    expect(await fail({ throw: new ConnectionError("kept", "metaads") })).toBeInstanceOf(ConnectionError);
    expect(await fail({ throw: new Error("socket") })).toBeInstanceOf(ConnectionError);
    const nested = scripted([{ body: probe }, { body: { data: "nope" } }]);
    const opened = new MetaAdsProvider(connection, {}, nested.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT ad.id FROM ad")).rejects.toThrow("not a list");
    expect(
      () => new MetaAdsProvider({ ...connection, host: "https://evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new MetaAdsProvider({ ...connection, password: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
    expect(() => new MetaAdsProvider({ ...connection, database: "0" }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
  });
});
