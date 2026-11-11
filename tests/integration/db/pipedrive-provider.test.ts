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
import { PipedriveProvider } from "@/lib/db/providers/sql/pipedrive";
import { PIPEDRIVE_RESOURCES } from "@/lib/db/providers/sql/pipedrive/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "pd",
  name: "pd",
  type: "pipedrive",
  host: "",
  user: "",
  database: "",
  password: "api-token-value",
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

const probe = { success: true, data: [] };
const deal = {
  success: true,
  data: [{ id: 9, title: "Brand", status: "open", value: 12.5, currency: "USD" }],
};

describe("PipedriveProvider", () => {
  test("reads deals with the API token and the company tree", async () => {
    const wire = scripted([
      { body: probe },
      { body: deal },
      { body: { success: true, data: [{ id: 1, title: "A" }] } },
    ]);
    const opened = new PipedriveProvider(connection, {}, wire.createTransport);
    await opened.connect();
    await opened.connect();
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.url).toBe("https://api.pipedrive.com/api/v2/deals?limit=500");
    expect(wire.requests[0]?.method).toBe("GET");
    expect(wire.options[0]?.headers?.["x-api-token"]).toBe("api-token-value");
    expect(wire.options[0]?.headers?.Authorization).toBeUndefined();
    expect(wire.requests[0]?.url).not.toContain("api-token-value");
    expect(wire.options[0]?.origin).toEqual({ scheme: "https", host: "api.pipedrive.com", port: 443 });
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    const containers = await opened.listContainers();
    expect(containers).toEqual([{ path: ["company"], name: "company", level: 0 }]);
    expect(await opened.listContainers(["company"])).toEqual([]);
    expect(await opened.countObjects(["company"])).toEqual({ table: { count: PIPEDRIVE_RESOURCES.length } });
    const tables = await opened.listObjects(["company"], "table");
    expect(tables.map((item) => item.name)).toContain("stage");
    const described = await opened.describeObject(["company", "deal"], "table");
    expect(described.columns[0]).toMatchObject({ name: "deal.id", type: "double", isPrimary: true, nullable: false });
    expect(described.columns.find((column) => column.name === "deal.title")).toMatchObject({ type: "varchar" });
    expect((await opened.describeObjects(["company"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["company"], "table")).details).toHaveLength(PIPEDRIVE_RESOURCES.length);
    await expect(opened.describeObjects(["company"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["company"], "table", 1.5)).rejects.toThrow(QueryError);
    await expect(opened.describeObject(["company", "missing"], "table")).rejects.toThrow(QueryError);
    await expect(opened.listObjects(["company"], "view")).rejects.toThrow(QueryError);
    expect(opened.getLabels().entityName).toBe("Table");
    expect((await opened.getOverview()).version).toBe("Pipedrive API v2");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow("Pipedrive has no maintenance operation");
    const result = await opened.query("SELECT deal.title, deal.value FROM deal WHERE deal.status = 'open'");
    expect(result.rows).toEqual([{ "deal.title": "Brand", "deal.value": 12.5 }]);
    await expect(opened.query("DELETE FROM deal")).rejects.toThrow(QueryError);
    await expect(opened.query("SELECT deal.id FROM deal", ["x"])).rejects.toThrow(QueryError);
    const skipped = await opened.query("SELECT deal.id FROM deal OFFSET 500");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("500");
    expect(wire.requests).toHaveLength(2);
    const wide = await opened.query("SELECT deal.id FROM deal LIMIT 5000");
    expect(wide.warnings?.[0]?.message).toContain("500");
    expect(wire.requests).toHaveLength(3);
    await opened.disconnect();
    await expect(opened.query("SELECT deal.id FROM deal")).rejects.toThrow("Not connected");
    await expect(opened.getOverview()).rejects.toThrow("Not connected");
  });

  test("uses a company host and opens a new transport when the token changes", async () => {
    const wire = scripted([
      { body: probe },
      {
        body: {
          success: true,
          data: [{ id: 4, subject: "Call", done: true }],
          additional_data: { next_cursor: "abc" },
        },
      },
      { body: { success: true, data: null } },
      { body: probe },
    ]);
    const opened = new PipedriveProvider({ ...connection, host: "acme.pipedrive.com" }, {}, wire.createTransport);
    await opened.connect();
    const activity = await opened.query("SELECT activity.subject FROM activity");
    expect(wire.requests[1]?.url).toBe("https://acme.pipedrive.com/api/v2/activities?limit=500");
    expect(activity.rows).toEqual([{ "activity.subject": "Call" }]);
    expect(activity.warnings?.[0]?.message).toContain("500");
    const empty = await opened.query("SELECT person.name FROM person");
    expect(empty.rows).toEqual([]);
    expect(empty.warnings).toBeUndefined();
    expect(wire.closed.count).toBe(0);
    (opened as unknown as { config: DatabaseConnection }).config.password = "second-api-token";
    await opened.query("SELECT deal.id FROM deal LIMIT 1");
    expect(wire.closed.count).toBe(1);
    expect(wire.options.at(-1)?.headers?.["x-api-token"]).toBe("second-api-token");
  });

  test("refuses a bad answer without repeating the token", async () => {
    const fail = async (page: ScriptedPage, host = ""): Promise<unknown> => {
      const wire = scripted([page]);
      const opened = new PipedriveProvider({ ...connection, host }, {}, wire.createTransport);
      try {
        await opened.connect();
        return await opened.query("SELECT deal.id FROM deal");
      } catch (error) {
        return error;
      }
    };
    const denied = await fail({ status: 401, text: "api-token-value rejected" });
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect((denied as Error).message).not.toContain("api-token-value");
    expect(await fail({ status: 403, text: "no" })).toBeInstanceOf(PermissionDeniedError);
    expect(((await fail({ status: 429, text: "" })) as Error).message).toContain("limiting");
    expect(((await fail({ status: 500, text: "" })) as Error).message).toContain("500");
    expect(((await fail({ status: 400, body: { error: "m".repeat(400) } })) as Error).message.length).toBeLessThan(400);
    expect(((await fail({ status: 400, body: { error: 1, error_info: "nope" } })) as Error).message).toContain("nope");
    expect(((await fail({ status: 400, body: { error: 1, message: 1 } })) as Error).message).toContain("400");
    const failed = await fail({ status: 200, body: { success: false, error: "api-token-value bad" } });
    expect(failed).toBeInstanceOf(QueryError);
    expect((failed as Error).message).not.toContain("api-token-value");
    expect(((await fail({ status: 200, body: { success: false } })) as Error).message).toContain("200");
    expect(await fail({ status: 200, text: "not-json" })).toBeInstanceOf(QueryError);
    expect(await fail({ status: 200, text: "" })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 200, body: { success: true, data: "nope" } })).toBeInstanceOf(ConnectionError);
    expect(await fail({ status: 302, text: "" })).toBeInstanceOf(ConnectionError);
    expect(((await fail({ status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) })) as Error).message).toContain("2 MB");
    const reached = await fail({ throw: new TransportError("unreachable", "api-token-value failed") });
    expect(reached).toBeInstanceOf(ConnectionError);
    expect((reached as Error).message).not.toContain("api-token-value");
    expect(((await fail({ throw: "down" })) as Error).message).toContain("could not be reached");
    expect(await fail({ throw: new QueryError("query failed", "pipedrive") })).toBeInstanceOf(QueryError);
    expect(await fail({ throw: new DatabaseConfigError("kept", "pipedrive") })).toBeInstanceOf(DatabaseConfigError);
    const nested = scripted([{ body: probe }, { body: { success: true, data: ["nope"] } }]);
    const opened = new PipedriveProvider(connection, {}, nested.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT person.id FROM person")).rejects.toThrow("not a list");
    expect(
      () => new PipedriveProvider({ ...connection, host: "https://evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new PipedriveProvider({ ...connection, password: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
  });
});
