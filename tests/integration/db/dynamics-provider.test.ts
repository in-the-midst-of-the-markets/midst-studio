import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { DynamicsProvider } from "@/lib/db/providers/sql/dynamics";
import { DYNAMICS_ENTITIES } from "@/lib/db/providers/sql/dynamics/translate";
import type { DatabaseConnection } from "@/lib/types";

const tokenConnection = {
  id: "dy",
  name: "dy",
  type: "dynamics",
  host: "contoso.crm.dynamics.com",
  password: "access-token-value",
  createdAt: new Date(0),
} as DatabaseConnection;

const clientConnection = {
  ...tokenConnection,
  user: "11111111-1111-1111-1111-111111111111",
  database: "22222222-2222-2222-2222-222222222222",
  password: "client-secret-value",
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

const who = { UserId: "user-1", OrganizationId: "org-1" };
const grant = { access_token: "issued-token-value", expires_in: 3600 };

function urlOf(raw: string): URL {
  return new URL(raw);
}

describe("DynamicsProvider", () => {
  test("probes the organization with a pasted token and refuses a write before a request", async () => {
    const probe = scripted([{ body: who }]);
    const opened = new DynamicsProvider(tokenConnection, {}, probe.createTransport);
    await opened.connect();
    await opened.connect();
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.url).toBe("https://contoso.crm.dynamics.com/api/data/v9.2/WhoAmI");
    expect(probe.requests[0]?.method).toBe("GET");
    expect(probe.options[0]?.origin).toEqual({ scheme: "https", host: "contoso.crm.dynamics.com", port: 443 });
    expect(probe.options[0]?.tls).toEqual({ rejectUnauthorized: true, identity: "contoso.crm.dynamics.com" });
    expect(probe.options[0]?.refusesLinkLocal).toBe(true);
    expect(probe.options[0]?.refusesUpgrade).toBe(true);
    expect(probe.options[0]?.headers.Authorization).toBe("Bearer access-token-value");
    expect(probe.options[0]?.headers.Accept).toBe("application/json");
    expect(probe.options[0]?.headers["OData-Version"]).toBe("4.0");
    expect(await opened.listContainers()).toEqual([{ path: ["organization"], name: "organization", level: 0 }]);
    expect(await opened.listContainers(["organization"])).toEqual([]);
    expect(await opened.countObjects(["organization"])).toEqual({ table: { count: DYNAMICS_ENTITIES.length } });
    const names = (await opened.listObjects(["organization"], "table")).map((object) => object.name);
    expect(names).toContain("accounts");
    const accounts = await opened.describeObject(["organization", "accounts"], "table");
    expect(accounts.columns.find((column) => column.name === "accountid")).toMatchObject({
      nullable: false,
      isPrimary: true,
      type: "varchar",
    });
    expect(accounts.columns.find((column) => column.name === "revenue")?.type).toBe("double");
    expect(accounts.columns.find((column) => column.name === "createdon")?.type).toBe("timestamptz");
    const users = await opened.describeObject(["organization", "systemusers"], "table");
    expect(users.columns.find((column) => column.name === "isdisabled")?.type).toBe("boolean");
    const contacts = await opened.describeObject(["organization", "Contacts"], "table");
    expect(contacts.columns.find((column) => column.name === "parentcustomerid")).toMatchObject({
      nullable: true,
      type: "varchar",
    });
    expect(await opened.describeObjects(["organization"], "table", 1)).toEqual({
      details: [await opened.describeObject(["organization", "accounts"], "table")],
    });
    expect(await opened.describeObjects(["organization"], "table")).toMatchObject({
      details: expect.any(Array),
    });
    await expect(opened.describeObjects(["organization"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObjects(["organization"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObject(["organization", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.listObjects(["organization"], "view")).rejects.toThrow(/no object kind/);
    expect((await opened.getOverview()).version).toBe("Dataverse Web API v9.2");
    expect((await opened.getOverview()).tableCount).toBe(DYNAMICS_ENTITIES.length);
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow(/no maintenance/);
    await expect(opened.query("INSERT INTO accounts (name) VALUES ('A')")).rejects.toThrow(/read-only/);
    expect(probe.requests).toHaveLength(1);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getLabels().entityName).toBe("Table");
    await opened.disconnect();
    await expect(opened.query("SELECT name FROM accounts")).rejects.toThrow(/Not connected/);
    expect(probe.closed.count).toBe(1);
  });

  test("sends a SELECT and a COUNT as OData on the organization host", async () => {
    const probe = scripted([
      { body: who },
      { body: { value: [{ accountid: "1", name: "Contoso", revenue: 12, emailaddress1: null }] } },
      { body: { value: ["not-a-row"] } },
      { text: "  4\n" },
    ]);
    const opened = new DynamicsProvider(tokenConnection, {}, probe.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT name FROM accounts", [1])).rejects.toThrow(/parameters/);
    const selected = await opened.query(
      "SELECT name, telephone1 FROM accounts WHERE name = 'Contoso' ORDER BY name DESC LIMIT 5",
    );
    expect(selected.fields).toEqual(["name", "telephone1"]);
    expect(selected.rows).toEqual([{ name: "Contoso", telephone1: null }]);
    const called = urlOf(probe.requests[1]?.url ?? "");
    expect(called.pathname).toBe("/api/data/v9.2/accounts");
    expect(called.searchParams.get("$select")).toBe("name,telephone1");
    expect(called.searchParams.get("$filter")).toBe("name eq 'Contoso'");
    expect(called.searchParams.get("$orderby")).toBe("name desc");
    expect(called.searchParams.get("$top")).toBe("5");
    await expect(opened.query("SELECT name FROM accounts")).rejects.toThrow(/not a list/);
    const counted = await opened.query("SELECT COUNT(*) AS row_count FROM accounts WHERE name IS NOT NULL");
    expect(counted.rows).toEqual([{ row_count: 4 }]);
    expect(urlOf(probe.requests[3]?.url ?? "").pathname).toBe("/api/data/v9.2/accounts/$count");
    const wide = scripted([{ body: who }, { body: { value: [{ name: "Contoso" }] } }]);
    const second = new DynamicsProvider(tokenConnection, {}, wide.createTransport);
    await second.connect();
    const star = await second.query("SELECT * FROM accounts");
    expect(star.fields[0]).toBe("accountid");
    expect(star.rows[0]?.name).toBe("Contoso");
    expect(star.rows[0]?.accountid).toBeNull();
    expect(star.warnings).toBeUndefined();
    const capped = scripted([{ body: who }, { body: { value: [] } }, { body: { value: [] } }]);
    const third = new DynamicsProvider(tokenConnection, {}, capped.createTransport);
    await third.connect();
    const limited = await third.query("SELECT name FROM accounts LIMIT 5000");
    expect(urlOf(capped.requests[1]?.url ?? "").searchParams.get("$top")).toBe("1000");
    expect(limited.warnings?.[0]?.message).toMatch(/1000 rows/);
    const skipped = await third.query("SELECT name FROM accounts OFFSET 1000");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toMatch(/OFFSET/);
    expect(capped.requests).toHaveLength(2);
    const shrunk = await third.query("SELECT name FROM accounts LIMIT 200 OFFSET 950");
    expect(urlOf(capped.requests[2]?.url ?? "").searchParams.get("$top")).toBe("50");
    expect(urlOf(capped.requests[2]?.url ?? "").searchParams.get("$skip")).toBe("950");
  });

  test("exchanges a client secret only at login.microsoftonline.com and reuses the token", async () => {
    let time = 1_000_000;
    const probe = scripted([
      { body: grant },
      { body: who },
      { body: { value: [{ name: "Contoso" }] } },
      { body: { value: [] } },
      { body: { access_token: "refreshed-token-value", expires_in: 61 } },
      { body: { value: [] } },
    ]);
    const opened = new DynamicsProvider(clientConnection, {}, probe.createTransport, () => time);
    await opened.connect();
    expect(probe.requests[0]?.method).toBe("POST");
    expect(probe.requests[0]?.url).toBe(
      "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/oauth2/v2.0/token",
    );
    expect(probe.requests[0]?.form).toEqual({
      grant_type: "client_credentials",
      client_id: "11111111-1111-1111-1111-111111111111",
      client_secret: "client-secret-value",
      scope: "https://contoso.crm.dynamics.com/.default",
    });
    expect(probe.options[0]?.origin.host).toBe("login.microsoftonline.com");
    expect(probe.options[1]?.headers.Authorization).toBe("Bearer issued-token-value");
    expect(JSON.stringify(probe.options[1]?.headers)).not.toContain("client-secret-value");
    await opened.query("SELECT name FROM accounts");
    await opened.query("SELECT name FROM accounts");
    expect(probe.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    time += 3_600_000;
    await opened.query("SELECT name FROM accounts");
    expect(probe.requests.filter((request) => request.method === "POST")).toHaveLength(2);
    expect(probe.closed.count).toBeGreaterThan(0);
    await opened.disconnect();
  });

  test("reports the status Dynamics sent and does not follow a redirect", async () => {
    const denied = scripted([{ status: 401, body: { error: { message: "rejected access-token-value" } } }]);
    const token = new DynamicsProvider(tokenConnection, {}, denied.createTransport);
    try {
      await token.connect();
      throw new Error("connected");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/••••/);
      expect(message).not.toContain("access-token-value");
    }
    expect(denied.closed.count).toBe(1);

    const forbidden = scripted([{ body: who }, { status: 403, text: "client-secret-value is not allowed" }]);
    const client = new DynamicsProvider(clientConnection, {}, forbidden.createTransport);
    await expect(client.connect()).rejects.toBeInstanceOf(AuthenticationError);
    const pasted = new DynamicsProvider(
      tokenConnection,
      {},
      scripted([{ body: who }, { status: 403, text: "no access-token-value here" }]).createTransport,
    );
    await pasted.connect();
    await expect(pasted.query("SELECT name FROM accounts")).rejects.toBeInstanceOf(PermissionDeniedError);

    const limited = scripted([{ body: who }, { status: 429, body: {} }]);
    const waiting = new DynamicsProvider(tokenConnection, {}, limited.createTransport);
    await waiting.connect();
    await expect(waiting.query("SELECT name FROM accounts")).rejects.toThrow(/limiting requests/);

    const broken = scripted([{ body: who }, { status: 500, body: { error: { message: "m".repeat(301) } } }]);
    const failed = new DynamicsProvider(tokenConnection, {}, broken.createTransport);
    await failed.connect();
    await expect(failed.query("SELECT name FROM accounts")).rejects.toThrow(/^m{300}$/);

    const plain = scripted([{ body: who }, { status: 500, text: "plain failure" }]);
    const text = new DynamicsProvider(tokenConnection, {}, plain.createTransport);
    await text.connect();
    await expect(text.query("SELECT name FROM accounts")).rejects.toThrow(/plain failure/);

    const array = scripted([{ body: who }, { status: 500, body: ["no"] }]);
    const listed = new DynamicsProvider(tokenConnection, {}, array.createTransport);
    await listed.connect();
    await expect(listed.query("SELECT name FROM accounts")).rejects.toThrow(/answered 500/);

    const empty = scripted([{ body: who }, { status: 500, text: "" }]);
    const blank = new DynamicsProvider(tokenConnection, {}, empty.createTransport);
    await blank.connect();
    await expect(blank.query("SELECT name FROM accounts")).rejects.toThrow(/answered 500/);

    const redirected = scripted([{ status: 302, text: "" }]);
    await expect(new DynamicsProvider(tokenConnection, {}, redirected.createTransport).connect()).rejects.toThrow(
      /redirect/,
    );

    const tokenRedirect = scripted([{ status: 302, text: "" }]);
    await expect(new DynamicsProvider(clientConnection, {}, tokenRedirect.createTransport).connect()).rejects.toThrow(
      /redirect/,
    );

    const huge = scripted([{ body: who }, { text: "x".repeat(2 * 1024 * 1024 + 1) }]);
    const large = new DynamicsProvider(tokenConnection, {}, huge.createTransport);
    await large.connect();
    await expect(large.query("SELECT name FROM accounts")).rejects.toThrow(/2 MB/);

    const garbled = scripted([{ body: who }, { text: "not-json" }]);
    const odd = new DynamicsProvider(tokenConnection, {}, garbled.createTransport);
    await odd.connect();
    await expect(odd.query("SELECT name FROM accounts")).rejects.toThrow(/not a list/);

    const objectCell = scripted([
      { body: who },
      { body: { value: [{ websiteurl: { host: "contoso.example" } }] } },
      { body: { value: [{ isdisabled: true }] } },
    ]);
    const nested = new DynamicsProvider(tokenConnection, {}, objectCell.createTransport);
    await nested.connect();
    const row = await nested.query("SELECT websiteurl FROM accounts");
    expect(row.rows[0]?.websiteurl).toBe('{"host":"contoso.example"}');
    const flag = await nested.query("SELECT isdisabled FROM systemusers");
    expect(flag.rows[0]?.isdisabled).toBe(true);

    const exchangeDown = scripted([{ throw: new TransportError("timeout", "token host down") }]);
    await expect(new DynamicsProvider(clientConnection, {}, exchangeDown.createTransport).connect()).rejects.toThrow(
      /token host down/,
    );
    const nameless = scripted([{ body: who }, { status: 500, body: { error: { code: "0x800" } } }]);
    const unnamed = new DynamicsProvider(tokenConnection, {}, nameless.createTransport);
    await unnamed.connect();
    await expect(unnamed.query("SELECT name FROM accounts")).rejects.toThrow(/answered 500/);

    const leaked = scripted([{ body: grant }, { body: who }, { status: 500, text: "saw client-secret-value" }]);
    const secret = new DynamicsProvider(clientConnection, {}, leaked.createTransport);
    await secret.connect();
    await expect(secret.query("SELECT name FROM accounts")).rejects.toThrow(/••••/);

    const missing = scripted([{ text: "" }]);
    await expect(new DynamicsProvider(tokenConnection, {}, missing.createTransport).connect()).rejects.toThrow(
      /not a list/,
    );

    const thrown = scripted([{ throw: new TransportError("timeout", "timed out access-token-value") }]);
    await expect(new DynamicsProvider(tokenConnection, {}, thrown.createTransport).connect()).rejects.toThrow(/••••/);
    const other = scripted([{ throw: "nope" }]);
    await expect(new DynamicsProvider(tokenConnection, {}, other.createTransport).connect()).rejects.toThrow(
      /could not be reached/,
    );
    const kept = scripted([{ throw: new DatabaseConfigError("kept", "dynamics") }]);
    await expect(new DynamicsProvider(tokenConnection, {}, kept.createTransport).connect()).rejects.toThrow(/^kept$/);
    const queryError = scripted([{ throw: new QueryError("query failed", "dynamics") }]);
    await expect(new DynamicsProvider(tokenConnection, {}, queryError.createTransport).connect()).rejects.toThrow(
      /query failed/,
    );

    const closed = new DynamicsProvider(tokenConnection, {}, scripted([]).createTransport);
    await expect(closed.getOverview()).rejects.toThrow(/Not connected/);
    await expect(closed.listContainers()).rejects.toThrow(/Not connected/);
  });
});
