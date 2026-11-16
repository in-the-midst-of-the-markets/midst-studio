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
import {
  CrispProvider,
  crispAuthorization,
  crispHost,
  crispTokenIdentifier,
  crispTokenKey,
  crispWebsiteId,
} from "@/lib/db/providers/sql/crisp";
import type { DatabaseConnection } from "@/lib/types";

const IDENTIFIER = "crisp-token-identifier";
const KEY = "crisp-token-key";
const WEBSITE = "42286AB3-B29A-4FDE-8538-DA0AE501D825";
const WEBSITE_LOWER = WEBSITE.toLowerCase();

const connection = {
  id: "crisp",
  name: "crisp",
  type: "crisp",
  user: IDENTIFIER,
  password: KEY,
  database: WEBSITE,
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
  requests: { url: string; method: string; headers: Record<string, string> }[];
  options: NodeTransportOptions[];
  closed: number;
} {
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  const state: { options: NodeTransportOptions[]; closed: number } = { options: [], closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options.push(options);
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, headers: { ...request.headers } });
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

const website = { error: false, reason: "resolved", data: { name: "Ada" } };
const created = 1_720_000_000_000;

describe("CrispProvider", () => {
  test("sends the token only to the REST host", () => {
    expect(() => new CrispProvider(connection)).not.toThrow();
    expect(crispHost(connection)).toBe("api.crisp.chat");
    expect(crispHost({ host: " https://API.CRISP.CHAT/v1 " })).toBe("api.crisp.chat");
    expect(crispTokenIdentifier(connection)).toBe(IDENTIFIER);
    expect(crispTokenKey(connection)).toBe(KEY);
    expect(crispWebsiteId(connection)).toBe(WEBSITE_LOWER);
    expect(crispWebsiteId({ database: `  ${WEBSITE_LOWER}  ` })).toBe(WEBSITE_LOWER);
    expect(crispAuthorization(connection)).toBe(
      `Basic ${Buffer.from(`${IDENTIFIER}:${KEY}`, "utf8").toString("base64")}`,
    );
    const refused = (config: DatabaseConnection, secret: string): string => {
      try {
        new CrispProvider(config);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(secret);
        return message;
      }
      throw new Error("expected a refusal");
    };
    expect(refused({ ...connection, host: "plugin.crisp.chat" }, "plugin.crisp.chat")).toBe(
      "The API host must be api.crisp.chat. The token is sent only there.",
    );
    const underCrisp = "The API host must be a host under crisp.chat. The access token is sent only there.";
    expect(refused({ ...connection, host: "gocrisp.com" }, "gocrisp.com")).toBe(underCrisp);
    expect(refused({ ...connection, host: "https://user:secret@api.crisp.chat" }, "secret")).toBe(underCrisp);
    expect(refused({ ...connection, host: "api.crisp.chat:8443" }, "8443")).toBe(underCrisp);
    expect(refused({ ...connection, user: "  " }, IDENTIFIER)).toBe("The token identifier is required.");
    expect(refused({ ...connection, password: "" }, KEY)).toBe("The token key is required.");
    expect(refused({ ...connection, user: "id:with-colon" }, "id:with-colon")).toBe(
      "The token identifier must not contain a colon.",
    );
    expect(refused({ ...connection, user: "has space" }, "has space")).toBe(
      "Crisp credentials must be a single line of printable text.",
    );
    expect(refused({ ...connection, password: "s".repeat(201) }, "s".repeat(201))).toBe(
      "Crisp credentials must be a single line of printable text.",
    );
    expect(refused({ ...connection, database: "  " }, "not-the-id")).toBe("The workspace id is required.");
    expect(refused({ ...connection, database: undefined }, "not-the-id")).toBe("The workspace id is required.");
    expect(refused({ ...connection, database: "not-a-uuid" }, "not-a-uuid")).toBe("The workspace id must be a UUID.");
  });

  test("connects, lists the workspace, and closes the transport", async () => {
    const pages = scripted([{ body: website }]);
    const opened = new CrispProvider(connection, {}, pages.createTransport);
    await opened.connect();
    await opened.connect();
    expect(pages.requests).toHaveLength(1);
    expect(pages.requests[0]?.url).toBe(`https://api.crisp.chat/v1/website/${WEBSITE_LOWER}`);
    expect(pages.options[0]?.headers.authorization).toBe(crispAuthorization(connection));
    expect(pages.options[0]?.headers["x-crisp-tier"]).toBe("website");
    expect(pages.options[0]?.headers["user-agent"]).toBe("KnowSQL");
    expect(pages.options[0]?.refusesUpgrade).toBe(true);
    expect(pages.options[0]?.refusesLinkLocal).toBe(true);
    expect(opened.getCapabilities().supportsMaintenance).toBe(false);
    expect(opened.getCapabilities().supportsResultPagination).toBe(true);
    expect(opened.getLabels().entityNamePlural).toBe("Tables");
    expect(await opened.listContainers()).toEqual([{ path: ["workspace"], name: "workspace", level: 0 }]);
    expect(await opened.listContainers(["other"])).toEqual([]);
    expect(await opened.countObjects(["workspace"])).toEqual({ table: { count: 3 } });
    expect((await opened.listObjects(["workspace"], "table")).map((object) => object.name)).toEqual([
      "Conversation",
      "People",
      "Operator",
    ]);
    expect((await opened.describeObject(["workspace", "operator"], "table")).columns[0]?.name).toBe("UserId");
    expect((await opened.describeObjects(["workspace"], "table", 2)).details).toHaveLength(2);
    expect((await opened.describeObjects(["workspace"], "table")).details).toHaveLength(3);
    expect(await opened.getOverview()).toMatchObject({ version: "Crisp REST API V1", tableCount: 3 });
    expect(await opened.getHealth()).toMatchObject({ cacheHitRatio: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/maintenance/);
    await expect(opened.describeObject(["workspace", "Missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObjects(["workspace"], "view")).rejects.toThrow(/object kind/);
    await expect(opened.describeObjects(["workspace"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.query("DELETE FROM Operator")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT UserId FROM Operator", ["x"])).rejects.toThrow(/bind parameters/);
    await opened.disconnect();
    await expect(opened.query("SELECT UserId FROM Operator")).rejects.toThrow(/Not connected/);
    await expect(opened.getOverview()).rejects.toThrow(/Not connected/);
    expect(pages.closed).toBe(1);
  });

  test("reads conversations, people and operators", async () => {
    const conversation = {
      session_id: "session-1",
      state: "unresolved",
      availability: "offline",
      is_blocked: false,
      last_message: "Hello",
      topic: "Support",
      people_id: "people-1",
      created_at: created,
      updated_at: "2024-07-18",
      meta: {
        nickname: "Ada",
        email: "ada@example.com",
        device: { geolocation: { country: "US" } },
      },
      assigned: { user_id: "user-1" },
      unread: { operator: 2 },
    };
    const person = {
      people_id: "people-1",
      email: "ada@example.com",
      person: { nickname: "Ada", phone: "+1" },
      company: { name: "Ada Co", domain: "ada.example" },
      segments: ["customer", 1, "vip"],
      score: 4,
      created_at: 12,
      updated_at: 1e20,
    };
    const operatorPage = {
      error: false,
      data: [
        {
          type: "operator",
          details: {
            user_id: "user-1",
            email: "ada@example.com",
            first_name: "Ada",
            last_name: "Lovelace",
            role: "owner",
            availability: "online",
          },
        },
        { type: "invite" },
      ],
    };
    const pages = scripted([
      { body: website },
      { body: { error: false, data: [conversation, null, "skip"] } },
      {
        body: {
          error: false,
          data: [{ session_id: "session-2", meta: { email: "bea@example.com" }, created_at: Number.MAX_VALUE }],
        },
      },
      {
        body: {
          error: false,
          data: Array.from({ length: 20 }, (_, index) => ({
            session_id: String(index),
            state: 3,
            is_blocked: true,
            ...(index === 0 ? { meta: { device: {} }, unread: { operator: "no" } } : {}),
          })),
        },
      },
      { body: { error: false, data: [person] } },
      { body: { error: false, data: [{ people_id: "bare", segments: [] }] } },
      { body: operatorPage },
      { body: operatorPage },
      { body: { error: false, data: [] } },
      { body: { error: false } },
      { body: { error: false, data: null } },
      { body: { data: "nope" } },
      { body: [] },
    ]);
    const opened = new CrispProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const listed = await opened.query(
      "SELECT SessionId, State, Nickname, Email, Country, LastMessage, Topic, AssignedUserId, PeopleId, Unread, IsBlocked, CreatedAt, UpdatedAt FROM Conversation WHERE FilterNotResolved = '1' AND SearchText = 'hello' LIMIT 20",
    );
    expect(pages.requests[1]?.url).toContain(`https://api.crisp.chat/v1/website/${WEBSITE_LOWER}/conversations/1?`);
    expect(pages.requests[1]?.url).toContain("per_page=20");
    expect(pages.requests[1]?.url).toContain("filter_not_resolved=1");
    expect(pages.requests[1]?.url).toContain("search_query=hello");
    expect(pages.requests[1]?.url).toContain("search_type=text");
    expect(listed.rows[0]).toMatchObject({
      SessionId: "session-1",
      State: "unresolved",
      Nickname: "Ada",
      Email: "ada@example.com",
      Country: "US",
      LastMessage: "Hello",
      Topic: "Support",
      AssignedUserId: "user-1",
      PeopleId: "people-1",
      Unread: 2,
      IsBlocked: "false",
      CreatedAt: new Date(created).toISOString(),
      UpdatedAt: "2024-07-18",
    });
    expect(listed.warnings).toBeUndefined();
    const partial = await opened.query("SELECT SessionId, Missing FROM Conversation LIMIT 20 OFFSET 20");
    expect(pages.requests[2]?.url).toContain("/conversations/2?");
    expect(partial.rows).toEqual([{ SessionId: "session-2", Missing: null }]);
    expect(partial.warnings).toBeUndefined();
    const fullPage = await opened.query(
      "SELECT SessionId, State, IsBlocked, Country, Unread FROM Conversation LIMIT 20",
    );
    expect(fullPage.rows).toHaveLength(20);
    expect(fullPage.rows[0]).toMatchObject({ State: "3", IsBlocked: "true", Country: null, Unread: null });
    expect(fullPage.warnings?.[0]?.message).toMatch(/this page only/);
    const people = await opened.query("SELECT * FROM People WHERE SearchText = 'ada' LIMIT 80");
    expect(pages.requests[4]?.url).toContain("/people/profiles/1?");
    expect(pages.requests[4]?.url).toContain("per_page=50");
    expect(pages.requests[4]?.url).toContain("search_text=ada");
    expect(pages.requests[4]?.url).not.toContain("search_type");
    expect(people.rows[0]).toMatchObject({
      PeopleId: "people-1",
      Nickname: "Ada",
      Phone: "+1",
      Company: "Ada Co",
      Domain: "ada.example",
      Segments: "customer, vip",
      Score: 4,
      CreatedAt: "12",
      UpdatedAt: null,
    });
    expect(people.warnings?.map((warning) => warning.message).join(" ")).toMatch(/at most 50/);
    const bare = await opened.query("SELECT PeopleId, Segments, Score FROM People LIMIT 20");
    expect(bare.rows).toEqual([{ PeopleId: "bare", Segments: null, Score: null }]);
    const operators = await opened.query(
      "SELECT UserId, Email, FirstName, LastName, Role, Availability, Type FROM Operator",
    );
    expect(pages.requests[6]?.url).toBe(`https://api.crisp.chat/v1/website/${WEBSITE_LOWER}/operators/list`);
    expect(operators.rows[0]).toMatchObject({
      UserId: "user-1",
      Email: "ada@example.com",
      FirstName: "Ada",
      LastName: "Lovelace",
      Role: "owner",
      Availability: "online",
      Type: "operator",
    });
    expect(operators.rows[1]).toMatchObject({ UserId: null, Type: "invite" });
    const sliced = await opened.query("SELECT Type FROM Operator LIMIT 1");
    expect(sliced.rows).toEqual([{ Type: "operator" }]);
    expect(sliced.warnings?.[0]?.message).toMatch(/this page only/);
    const none = await opened.query("SELECT UserId FROM Operator");
    expect(none.rows).toEqual([]);
    const missingData = await opened.query("SELECT UserId FROM Operator");
    expect(missingData.rows).toEqual([]);
    const counted = await opened.query("SELECT COUNT(*) AS total FROM Operator");
    expect(counted.rows).toEqual([{ total: 0 }]);
    await expect(opened.query("SELECT UserId FROM Operator")).rejects.toThrow(
      "Crisp returned an answer that was not a list.",
    );
    await expect(opened.query("SELECT UserId FROM Operator")).rejects.toThrow(
      "Crisp returned an answer that was not a JSON object.",
    );
    await opened.disconnect();
  });

  test("maps API failures and keeps the token out of the message", async () => {
    const connectCases: { pages: ScriptedPage[]; error: unknown; message: string }[] = [
      { pages: [{ status: 401, text: "no" }], error: AuthenticationError, message: "Crisp rejected the token." },
      { pages: [{ status: 403, text: "no" }], error: PermissionDeniedError, message: "Crisp refused this request." },
      {
        pages: [{ status: 429, text: "slow" }],
        error: ConnectionError,
        message: "Crisp asked the connection to slow down.",
      },
      {
        pages: [{ status: 302, text: "away" }],
        error: ConnectionError,
        message: "Crisp answered with a redirect, which Studio does not follow.",
      },
      { pages: [{ status: 500, text: `boom ${KEY}` }], error: ConnectionError, message: "boom ••••" },
      { pages: [{ text: "" }], error: ConnectionError, message: "Crisp returned an answer that was not JSON." },
      { pages: [{ text: "not-json" }], error: ConnectionError, message: "Crisp returned an answer that was not JSON." },
      {
        pages: [{ body: { error: true, reason: "not_found" } }],
        error: ConnectionError,
        message: "Crisp refused the request (not_found).",
      },
      {
        pages: [{ body: { error: true, reason: `see ${KEY}` } }],
        error: ConnectionError,
        message: "Crisp refused the request.",
      },
      {
        pages: [{ throw: new TransportError("redirect", "https://evil.example") }],
        error: ConnectionError,
        message: "Crisp answered with a redirect, which Studio does not follow.",
      },
      {
        pages: [{ throw: new TransportError("too-large", "big") }],
        error: QueryError,
        message: "Crisp's answer was larger than 2 MB and was not read.",
      },
      {
        pages: [{ throw: new TransportError("network", `down ${KEY}`) }],
        error: ConnectionError,
        message: "down ••••",
      },
      { pages: [{ throw: new DatabaseConfigError("kept", "crisp") }], error: DatabaseConfigError, message: "kept" },
      { pages: [{ throw: new Error(`socket ${IDENTIFIER}`) }], error: ConnectionError, message: "socket ••••" },
      { pages: [{ throw: "down" }], error: ConnectionError, message: "Crisp could not be reached." },
    ];
    for (const entry of connectCases) {
      const script = scripted(entry.pages);
      const provider = new CrispProvider(connection, {}, script.createTransport);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is a fresh connection, and the queue is one page deep.
        await provider.connect();
        throw new Error("expected connect to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(entry.error);
        const message = error instanceof Error ? error.message : "";
        expect(message).toBe(entry.message);
        expect(message).not.toContain(KEY);
        expect(message).not.toContain(IDENTIFIER);
      }
      expect(script.closed).toBe(1);
    }

    const pages = scripted([
      { body: website },
      { status: 401, text: "no" },
      { status: 403, text: "no" },
      { status: 429, text: "slow" },
      { status: 302, text: "away" },
      { status: 500, text: `failed ${KEY}` },
      { text: "" },
      { text: "not-json" },
      { text: "y".repeat(API_ANSWER_LIMIT + 1) },
      { body: { error: true, reason: "invalid_session" } },
      { body: { error: true, reason: 12 } },
      { throw: new TransportError("redirect", "https://evil.example") },
      { throw: new TransportError("too-large", "big") },
      { throw: new TransportError("tls", `pin ${KEY}`) },
      { throw: new DatabaseConfigError("kept", "crisp") },
      { throw: new Error("reset") },
      { throw: "down" },
      { body: { data: "nope" } },
    ]);
    const opened = new CrispProvider(connection, {}, pages.createTransport);
    await opened.connect();
    const sql = "SELECT UserId FROM Operator";
    await expect(opened.query(sql)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(opened.query(sql)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(opened.query(sql)).rejects.toThrow("Crisp asked the connection to slow down.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp answered with a redirect, which Studio does not follow.");
    await expect(opened.query(sql)).rejects.toThrow("failed ••••");
    await expect(opened.query(sql)).rejects.toThrow("Crisp returned an answer that was not JSON.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp returned an answer that was not JSON.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp's answer was larger than 2 MB and was not read.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp refused the request (invalid_session).");
    await expect(opened.query(sql)).rejects.toThrow("Crisp refused the request.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp answered with a redirect, which Studio does not follow.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp's answer was larger than 2 MB and was not read.");
    await expect(opened.query(sql)).rejects.toThrow("pin ••••");
    await expect(opened.query(sql)).rejects.toThrow("kept");
    await expect(opened.query(sql)).rejects.toThrow("reset");
    await expect(opened.query(sql)).rejects.toThrow("Crisp could not be reached.");
    await expect(opened.query(sql)).rejects.toThrow("Crisp returned an answer that was not a list.");
    await opened.disconnect();
  });
});
