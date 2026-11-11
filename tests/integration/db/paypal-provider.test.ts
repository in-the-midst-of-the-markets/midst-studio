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
import { PayPalProvider } from "@/lib/db/providers/sql/paypal";
import { PAYPAL_RESOURCES } from "@/lib/db/providers/sql/paypal/translate";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "pp",
  name: "pp",
  type: "paypal",
  host: "",
  user: "client-id",
  database: "",
  password: "client-secret",
  createdAt: new Date(0),
} as DatabaseConnection;

const token = { access_token: "access-token-value", expires_in: 32_000, token_type: "Bearer" };

interface ScriptedPage {
  status?: number;
  body?: unknown;
  text?: string;
  throw?: unknown;
}

function scripted(pages: ScriptedPage[]): {
  createTransport: (options: NodeTransportOptions) => NodeTransport;
  requests: NodeRequest[];
  options: NodeTransportOptions[];
  closed: { count: number };
} {
  const requests: NodeRequest[] = [];
  const options: NodeTransportOptions[] = [];
  const closed = { count: 0 };
  const createTransport = (built: NodeTransportOptions): NodeTransport => {
    options.push(built);
    return {
      async request(request: NodeRequest) {
        requests.push(request);
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

describe("PayPalProvider", () => {
  test("exchanges the secret once and reads a transaction page", async () => {
    const wire = scripted([
      { body: token },
      {
        body: {
          transaction_details: [
            {
              transaction_info: {
                transaction_id: "T1",
                transaction_status: "S",
                transaction_amount: { currency_code: "USD", value: "12.50" },
              },
              payer_info: { email_address: "a@example.com" },
            },
          ],
          total_pages: 1,
        },
      },
      { body: { products: [{ id: "P", name: "Hat" }] } },
      { body: { items: [] } },
    ]);
    const clock = { now: () => Date.parse("2026-01-31T00:00:00Z") };
    const opened = new PayPalProvider(connection, {}, wire.createTransport, clock);
    await opened.connect();
    await opened.connect();
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]?.method).toBe("POST");
    expect(wire.requests[0]?.url).toBe("https://api-m.paypal.com/v1/oauth2/token");
    expect(wire.requests[0]?.form).toEqual({ grant_type: "client_credentials" });
    expect(wire.requests[0]?.headers?.authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(wire.requests[0]?.url).not.toContain("client-secret");
    expect(wire.options[0]?.refusesLinkLocal).toBe(true);
    expect(wire.options[0]?.requestHeaderNames).toEqual(["authorization"]);
    const containers = await opened.listContainers();
    expect(containers).toEqual([{ path: ["account"], name: "account", level: 0 }]);
    expect(await opened.listContainers(["account"])).toEqual([]);
    expect(await opened.countObjects(["account"])).toEqual({ table: { count: PAYPAL_RESOURCES.length } });
    const tables = await opened.listObjects(["account"], "table");
    expect(tables.map((item) => item.name)).toContain("payout");
    const described = await opened.describeObject(["account", "transaction"], "table");
    expect(described.columns[0]).toMatchObject({ name: "transaction.id", type: "varchar", isPrimary: true });
    expect(described.columns.find((column) => column.name === "transaction.amount")).toMatchObject({ type: "double" });
    expect((await opened.describeObjects(["account"], "table", 1)).details).toHaveLength(1);
    expect((await opened.describeObjects(["account"], "table")).details).toHaveLength(PAYPAL_RESOURCES.length);
    await expect(opened.describeObjects(["account"], "table", 0)).rejects.toThrow(QueryError);
    await expect(opened.describeObjects(["account"], "table", 1.5)).rejects.toThrow(QueryError);
    await expect(opened.describeObject(["account", "missing"], "table")).rejects.toThrow(QueryError);
    await expect(opened.listObjects(["account"], "view")).rejects.toThrow(QueryError);
    expect(opened.getLabels().entityName).toBe("Table");
    expect((await opened.getOverview()).version).toBe("PayPal REST");
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await expect(opened.runMaintenance()).rejects.toThrow("PayPal has no maintenance operation");
    const result = await opened.query(
      "SELECT transaction.id, transaction.amount FROM transaction WHERE transaction.status = 'S'",
    );
    expect(result.rows).toEqual([{ "transaction.id": "T1", "transaction.amount": "12.50" }]);
    expect(wire.requests[1]?.url).toContain("start_date=2026-01-01T00%3A00%3A00Z");
    expect(wire.requests[1]?.url).toContain("end_date=2026-01-31T00%3A00%3A00Z");
    expect(wire.requests[1]?.headers?.authorization).toBe("Bearer access-token-value");
    await expect(opened.query("DELETE FROM transaction")).rejects.toThrow(QueryError);
    await expect(opened.query("SELECT transaction.id FROM transaction", ["x"])).rejects.toThrow(QueryError);
    const skipped = await opened.query("SELECT transaction.id FROM transaction OFFSET 500");
    expect(skipped.rows).toEqual([]);
    expect(skipped.warnings?.[0]?.message).toContain("500");
    const wide = await opened.query("SELECT product.name FROM product LIMIT 5000");
    expect(wide.rows).toEqual([{ "product.name": "Hat" }]);
    expect(wide.warnings?.[0]?.message).toContain("one page");
    expect(wire.requests[2]?.url).toBe(
      "https://api-m.paypal.com/v1/catalogs/products?page_size=20&page=1&total_required=false",
    );
    const empty = await opened.query("SELECT * FROM invoice");
    expect(empty.rows).toEqual([]);
    expect(empty.warnings).toBeUndefined();
    await opened.disconnect();
    await expect(opened.query("SELECT transaction.id FROM transaction")).rejects.toThrow("Not connected");
    await expect(opened.getOverview()).rejects.toThrow("Not connected");
    expect(wire.closed.count).toBeGreaterThan(0);
  });

  test("uses the sandbox host, warns on another page and refreshes an expired token", async () => {
    let now = Date.parse("2026-01-31T00:00:00Z");
    const wire = scripted([
      { body: { access_token: "first-token", expires_in: 300 } },
      {
        body: {
          balances: [{ currency: "USD", primary: false }],
          links: [{ rel: "next", href: "https://example.invalid" }],
        },
      },
      { body: { access_token: "second-token", expires_in: 300 } },
      { body: { plans: [{ id: "PL", name: "Monthly" }], total_pages: "2" } },
    ]);
    const opened = new PayPalProvider({ ...connection, host: "api-m.sandbox.paypal.com" }, {}, wire.createTransport, {
      now: () => now,
    });
    await opened.connect();
    const balance = await opened.query("SELECT balance.currency, balance.primary FROM balance");
    expect(wire.requests[1]?.url).toBe("https://api-m.sandbox.paypal.com/v1/reporting/balances");
    expect(balance.rows).toEqual([{ "balance.currency": "USD", "balance.primary": "false" }]);
    expect(balance.warnings?.[0]?.message).toContain("one page");
    now += 250_000;
    (opened as unknown as { config: DatabaseConnection }).config.password = "next-secret";
    const plan = await opened.query("SELECT plan.name FROM plan");
    expect(plan.rows).toEqual([{ "plan.name": "Monthly" }]);
    expect(wire.requests[2]?.headers?.authorization).toBe(
      `Basic ${Buffer.from("client-id:next-secret").toString("base64")}`,
    );
    expect(wire.requests[3]?.headers?.authorization).toBe("Bearer second-token");
    expect(wire.closed.count).toBeGreaterThan(0);
  });

  test("treats a non-positive expiry as five minutes", async () => {
    const wire = scripted([
      { body: { access_token: "access-token-value", expires_in: 0 } },
      { body: { products: [] } },
      { body: { products: [] } },
    ]);
    let now = 1_000;
    const opened = new PayPalProvider(connection, {}, wire.createTransport, { now: () => now });
    await opened.connect();
    await opened.query("SELECT product.id FROM product");
    now += 1_000;
    await opened.query("SELECT product.id FROM product");
    expect(wire.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("uses the default clock and a token with no expiry", async () => {
    const wire = scripted([
      { body: { access_token: "access-token-value" } },
      { body: { items: [{ dispute_id: "D1", status: "OPEN" }] } },
      { body: { items: [{ payout_batch_id: "B1", amount: { currency: "USD", value: "3" } }] } },
    ]);
    const opened = new PayPalProvider(connection, {}, wire.createTransport);
    await opened.connect();
    const dispute = await opened.query("SELECT dispute.id FROM dispute");
    expect(dispute.rows).toEqual([{ "dispute.id": "D1" }]);
    expect(wire.requests[1]?.url).toContain("/v1/customer/disputes?page_size=50");
    expect(wire.requests[1]?.url).not.toContain("start_date=");
    const payout = await opened.query("SELECT payout.amount FROM payout");
    expect(payout.rows).toEqual([{ "payout.amount": "3" }]);
    expect(wire.requests).toHaveLength(3);
  });

  test("refuses a bad answer without repeating the secret or the token", async () => {
    const fail = async (pages: ScriptedPage[], host = ""): Promise<unknown> => {
      const wire = scripted(pages);
      const opened = new PayPalProvider({ ...connection, host }, {}, wire.createTransport);
      try {
        await opened.connect();
        return await opened.query("SELECT transaction.id FROM transaction");
      } catch (error) {
        return error;
      }
    };
    const denied = await fail([{ status: 401, text: "client-secret rejected" }]);
    expect(denied).toBeInstanceOf(AuthenticationError);
    expect((denied as Error).message).not.toContain("client-secret");
    expect(await fail([{ status: 403, text: "no" }])).toBeInstanceOf(PermissionDeniedError);
    expect(((await fail([{ status: 429, text: "" }])) as Error).message).toContain("limiting");
    expect(((await fail([{ status: 500, text: "" }])) as Error).message).toContain("500");
    expect(((await fail([{ status: 400, body: { message: "short" } }])) as Error).message).toContain("short");
    expect(((await fail([{ status: 400, body: { message: "m".repeat(400) } }])) as Error).message.length).toBeLessThan(
      400,
    );
    expect(
      ((await fail([{ status: 400, body: { message: "", error_description: "described" } }])) as Error).message,
    ).toContain("described");
    expect(((await fail([{ status: 400, body: { error_description: "", error: "err" } }])) as Error).message).toContain(
      "err",
    );
    expect(((await fail([{ status: 400, body: { error: "", name: "NAME" } }])) as Error).message).toContain("NAME");
    expect(((await fail([{ status: 400, text: "[]" }])) as Error).message).toContain("400");
    expect(((await fail([{ status: 400, body: { error_description: "nope" } }])) as Error).message).toContain("nope");
    expect(((await fail([{ status: 400, body: { error: "bad" } }])) as Error).message).toContain("bad");
    expect(((await fail([{ status: 400, body: { name: "INVALID" } }])) as Error).message).toContain("INVALID");
    expect(((await fail([{ status: 400, body: { name: 1 } }])) as Error).message).toContain("400");
    expect(((await fail([{ status: 400, text: "not-json" }])) as Error).message).toContain("not-json");
    expect(await fail([{ status: 302, text: "" }])).toBeInstanceOf(ConnectionError);
    expect(((await fail([{ status: 200, text: "x".repeat(API_ANSWER_LIMIT + 1) }])) as Error).message).toContain(
      "2 MB",
    );
    const reached = await fail([{ throw: new TransportError("unreachable", "client-secret failed") }]);
    expect(reached).toBeInstanceOf(ConnectionError);
    expect((reached as Error).message).not.toContain("client-secret");
    expect(((await fail([{ throw: "down" }])) as Error).message).toContain("could not be reached");
    expect(await fail([{ throw: new QueryError("query failed", "paypal") }])).toBeInstanceOf(QueryError);
    expect(await fail([{ throw: new DatabaseConfigError("kept", "paypal") }])).toBeInstanceOf(DatabaseConfigError);
    expect(await fail([{ throw: new AuthenticationError("kept", "paypal") }])).toBeInstanceOf(AuthenticationError);
    expect(await fail([{ throw: new PermissionDeniedError("kept", "paypal") }])).toBeInstanceOf(PermissionDeniedError);
    expect(await fail([{ throw: new ConnectionError("kept", "paypal") }])).toBeInstanceOf(ConnectionError);
    expect(await fail([{ body: { access_token: "" } }])).toBeInstanceOf(QueryError);
    expect(await fail([{ body: { access_token: 1 } }])).toBeInstanceOf(QueryError);
    expect(await fail([{ body: [] }])).toBeInstanceOf(QueryError);
    expect(await fail([{ text: "not-json" }])).toBeInstanceOf(QueryError);
    expect(await fail([{ text: "" }])).toBeInstanceOf(QueryError);
    expect(await fail([{ body: { access_token: "has space" } }])).toBeInstanceOf(QueryError);
    expect(await fail([{ body: { access_token: "a".repeat(1100) } }])).toBeInstanceOf(QueryError);
    const leaked = await fail([{ body: token }, { status: 500, text: "access-token-value leaked" }]);
    expect((leaked as Error).message).not.toContain("access-token-value");
    const dropped = scripted([{ body: token }, { throw: new TransportError("unreachable", "access-token-value") }]);
    const late = new PayPalProvider(connection, {}, dropped.createTransport);
    await late.connect();
    const lateError = await late.query("SELECT product.id FROM product").then(
      () => null,
      (error: unknown) => error,
    );
    expect(lateError).toBeInstanceOf(ConnectionError);
    expect((lateError as Error).message).not.toContain("access-token-value");
    const nested = scripted([{ body: token }, { body: { transaction_details: "nope" } }]);
    const opened = new PayPalProvider(connection, {}, nested.createTransport);
    await opened.connect();
    await expect(opened.query("SELECT transaction.id FROM transaction")).rejects.toThrow("not a list");
    const blank = scripted([{ body: token }, { text: "" }]);
    const blanked = new PayPalProvider(connection, {}, blank.createTransport);
    await blanked.connect();
    await expect(blanked.query("SELECT balance.currency FROM balance")).rejects.toThrow("not a list");
    const broken = scripted([{ body: token }, { text: "not-json" }]);
    const unparsed = new PayPalProvider(connection, {}, broken.createTransport);
    await unparsed.connect();
    await expect(unparsed.query("SELECT balance.currency FROM balance")).rejects.toThrow("not a list");
    expect(
      () => new PayPalProvider({ ...connection, host: "https://evil.example" }, {}, scripted([]).createTransport),
    ).toThrow(DatabaseConfigError);
    expect(() => new PayPalProvider({ ...connection, user: " " }, {}, scripted([]).createTransport)).toThrow(
      DatabaseConfigError,
    );
  });
});
