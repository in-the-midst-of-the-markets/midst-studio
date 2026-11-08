import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  DatabaseConfigError,
  PermissionDeniedError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { NodeRequest, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { StripeProvider, stripeApiHost } from "@/lib/db/providers/sql/stripe";
import type { DatabaseConnection } from "@/lib/types";

const connection = {
  id: "st",
  name: "st",
  type: "stripe",
  password: "sk_test_secret_value",
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
  options?: NodeTransportOptions;
  closed: number;
} {
  const requests: { url: string; method: string; body?: string }[] = [];
  const state: { options?: NodeTransportOptions; closed: number } = { closed: 0 };
  const createTransport = (options: NodeTransportOptions): NodeTransport => {
    state.options = options;
    return {
      async request(request: NodeRequest) {
        requests.push({ url: request.url, method: request.method, body: request.body });
        const next = pages.shift();
        if (next === undefined) throw new Error(`no response for ${request.method} ${request.url}`);
        if (next.throw !== undefined) throw next.throw;
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
    get options() {
      return state.options;
    },
    get closed() {
      return state.closed;
    },
  };
}

function clock(values: readonly number[]): { now(): number; wait(ms: number): Promise<void> } {
  let index = 0;
  return {
    now() {
      const value = values[Math.min(index, values.length - 1)] ?? 0;
      index += 1;
      return value;
    },
    async wait() {
      return undefined;
    },
  };
}

const schemas = {
  object: "v2.list",
  data: [
    {
      id: "schema_1",
      name: "balance_transactions",
      columns: [
        { name: "id", type: "varchar", is_primary_key: true },
        { name: "amount", type: "bigint", is_primary_key: false },
        { name: "note", is_primary_key: false },
        { name: "loose" },
        { name: "" },
        "skip",
      ],
    },
    { id: "schema_2", name: "charges", columns: [] },
    { id: "..", name: "hidden" },
    { name: "no-id" },
  ],
  next_page_url: null,
};

const reports = {
  object: "v2.list",
  data: [
    {
      id: "report_1",
      name: "balance.summary",
      parameters: {
        "": { type: "timestamp", required: true },
        interval_start: { type: "timestamp", required: true },
        interval_end: { type: "", required: true },
        flag: { type: "boolean", required: false },
        bad: "nope",
      },
    },
    { id: "report_2", name: "plain.report" },
    { id: "not an id", name: "skipped.report" },
    { id: "report_9", name: "" },
    "nope",
  ],
  next_page_url: null,
};

function provider(
  createTransport: (options: NodeTransportOptions) => NodeTransport,
  extra: Partial<DatabaseConnection> = {},
  options: { queryTimeout?: number } = {},
  time = clock([0]),
): StripeProvider {
  return new StripeProvider({ ...connection, ...extra }, options, createTransport, time);
}

const queryRun = { id: "qrun_1", object: "v2.data.query_run", status: "succeeded" };
const inline = {
  id: "qrun_1",
  status: "succeeded",
  result: {
    file: { download_url: { url: "https://stripeusercontent.com/files/secret" } },
    inline: {
      columns: [
        { name: "id", type: "varchar" },
        { name: "amount", type: "bigint" },
        { name: "extra", type: "varchar" },
        { name: "flag", type: "boolean" },
        { name: "n", type: "integer" },
        { name: "empty", type: "varchar" },
        { name: "__proto__", type: "varchar" },
        { name: "" },
        "skip",
      ],
      rows: [
        {
          data: {
            id: "txn_1",
            amount: "1000",
            flag: true,
            n: 1,
            empty: null,
            extra: { nested: true },
            client_secret: "pi_secret",
          },
        },
        { id: "plain" },
        null,
      ],
      next_page_url: null,
    },
  },
};

describe("StripeProvider", () => {
  test("requires a printable secret key and sends it only to api.stripe.com", async () => {
    expect(() => new StripeProvider(connection)).not.toThrow();
    expect(() => new StripeProvider({ ...connection, password: "  " })).toThrow(DatabaseConfigError);
    const injected = "sk_test_secret_value\r\nX-Injected: 1";
    try {
      new StripeProvider({ ...connection, password: injected });
      throw new Error("the key was accepted");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/single line/);
      expect(message).not.toContain("Injected");
      expect(message).not.toContain("sk_test");
    }
    expect(() => new StripeProvider({ ...connection, password: "x".repeat(1024) })).toThrow(/single line/);
    expect(stripeApiHost(connection)).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: " https://api.stripe.com/v1 " })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "http://api.stripe.com" })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "   " })).toBe("api.stripe.com");
    expect(stripeApiHost({ ...connection, host: "API.stripe.com" })).toBe("api.stripe.com");
    for (const host of [
      "evil.com",
      "api.stripe.com.evil.com",
      "https://sk_test_secret_value@evil.com",
      "api.stripe.com:8443",
      "https://",
    ]) {
      expect(() => new StripeProvider({ ...connection, host })).toThrow(DatabaseConfigError);
      try {
        stripeApiHost({ ...connection, host });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("stripe.com");
        expect(message).not.toContain("evil");
        expect(message).not.toContain("8443");
        expect(message).not.toContain("sk_test");
      }
    }
    expect(() => stripeApiHost({ ...connection, host: "files.stripe.com" })).toThrow(
      "The API host must be api.stripe.com. The secret key is sent only there.",
    );
    const dial = scripted([{ body: { data: [], next_page_url: null } }, { body: { data: [], next_page_url: null } }]);
    await provider(dial.createTransport, { host: "http://api.stripe.com" }).connect();
    expect(dial.requests[0]?.url.startsWith("https://api.stripe.com/")).toBe(true);
    expect(dial.options?.origin).toEqual({ scheme: "https", host: "api.stripe.com", port: 443 });
  });

  test("lists schemas and reports, then runs Sigma SQL as a query run", async () => {
    const catalog = scripted([
      { body: schemas },
      { body: reports },
      { body: { ...queryRun, status: "running" } },
      { body: queryRun },
      { body: inline },
    ]);
    const opened = provider(catalog.createTransport);
    await opened.connect();
    await opened.connect();
    expect(catalog.requests).toHaveLength(2);
    expect(catalog.requests[0]?.url).toContain("/v2/data/schemas");
    expect(catalog.requests[0]?.url).toContain("dataset=analytical");
    expect(catalog.requests[1]?.url).toContain("/v2/data/reports");
    expect(catalog.options?.origin).toEqual({ scheme: "https", host: "api.stripe.com", port: 443 });
    expect(catalog.options?.tls).toEqual({ rejectUnauthorized: true, identity: "api.stripe.com" });
    expect(catalog.options?.refusesLinkLocal).toBe(true);
    expect(catalog.options?.refusesUpgrade).toBe(true);
    expect(catalog.options?.headers.Authorization).toBe("Bearer sk_test_secret_value");
    expect(catalog.options?.headers["Stripe-Version"]).toBe("2026-10-28.preview");

    const listed = await opened.query("SELECT id, amount FROM balance_transactions LIMIT 10;");
    const posted = catalog.requests[2];
    expect(posted?.method).toBe("POST");
    expect(posted?.url).toBe("https://api.stripe.com/v2/data/query_runs");
    expect(JSON.parse(posted?.body ?? "{}")).toEqual({
      query: { sql: "SELECT id, amount FROM balance_transactions LIMIT 10" },
      dataset: "analytical",
      format: "csv",
    });
    expect(catalog.requests[3]?.url).toBe("https://api.stripe.com/v2/data/query_runs/qrun_1");
    expect(catalog.requests[4]?.url).toContain("include%5B0%5D=result.inline");
    expect(catalog.requests.every((request) => request.url.startsWith("https://api.stripe.com/"))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("stripeusercontent");
    expect(JSON.stringify(listed)).not.toContain("pi_secret");
    expect(listed.rows[0]).toMatchObject({
      id: "txn_1",
      amount: "1000",
      extra: '{"nested":true}',
      flag: true,
      n: 1,
      empty: null,
    });
    expect(listed.rows[1]).toMatchObject({ id: "plain", amount: null, extra: null });
    expect(listed.rows[0]).not.toHaveProperty("client_secret");
    expect(Object.hasOwn(listed.rows[0] ?? {}, "__proto__")).toBe(false);
    expect(listed.fields).toEqual(["id", "amount", "extra", "flag", "n", "empty", "__proto__"]);

    expect(await opened.listContainers()).toEqual([
      { path: ["analytical"], name: "analytical", level: 0 },
      { path: ["reports"], name: "reports", level: 0 },
    ]);
    expect(await opened.listContainers(["analytical"])).toEqual([]);
    expect(await opened.countObjects(["analytical"])).toEqual({ table: { count: 2 } });
    expect(await opened.countObjects(["reports"])).toEqual({ report: { count: 2 } });
    const tables = await opened.listObjects(["analytical"], "table");
    expect(tables.map((table) => table.name)).toEqual(["balance_transactions", "charges"]);
    expect(await opened.listObjects(["analytical"], "report")).toEqual([]);
    expect(await opened.listObjects(["reports"], "table")).toEqual([]);
    expect((await opened.listObjects(["reports"], "report")).map((report) => report.name)).toEqual([
      "balance.summary",
      "plain.report",
    ]);
    const described = await opened.describeObject(["analytical", "balance_transactions"], "table");
    expect(described.columns).toEqual([
      { name: "id", type: "varchar", nullable: false, isPrimary: true },
      { name: "amount", type: "bigint", nullable: true, isPrimary: false },
      { name: "note", type: "varchar", nullable: true, isPrimary: false },
      { name: "loose", type: "varchar", nullable: true, isPrimary: false },
    ]);
    const report = await opened.describeObject(["reports", "balance.summary"], "report");
    expect(report.columns.map((column) => column.name)).toEqual(["interval_start", "interval_end", "flag"]);
    expect(report.columns[0]).toMatchObject({ type: "timestamp", nullable: false, isPrimary: false });
    expect(report.columns[1]).toMatchObject({ type: "varchar", nullable: false });
    expect(opened.getCapabilities().supportsConstantPredicate).toBe(false);
    expect(opened.getCapabilities().supportsExplain).toBe(false);
    expect(opened.getCapabilities().enforcesReadOnly).toBeUndefined();
    expect(opened.getLabels().entityName).toBe("Table");
    await expect(opened.query("INSERT INTO t VALUES (1)")).rejects.toThrow(/read-only/);
    await expect(opened.query("SELECT 1", ["x"])).rejects.toThrow(/bind parameters/);
    await expect(opened.listObjects(["analytical"], "view")).rejects.toThrow(/no object kind/);
    await expect(opened.describeObject(["analytical", "missing"], "table")).rejects.toThrow(/no table/);
    await expect(opened.describeObject(["reports", "missing"], "report")).rejects.toThrow(/no report/);
    expect((await opened.describeObjects(["analytical"], "table")).details).toHaveLength(2);
    const batch = await opened.describeObjects(["reports"], "report", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated?.limit).toBe(1);
    await expect(opened.describeObjects(["analytical"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(opened.describeObjects(["analytical"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    expect(await opened.getOverview()).toMatchObject({ version: "Stripe Data API", tableCount: 2 });
    expect(await opened.getHealth()).toMatchObject({ databaseSize: "N/A" });
    await expect(opened.runMaintenance()).rejects.toBeInstanceOf(QueryError);
    expect(await opened.getPerformanceMetrics()).toEqual({});
    expect(await opened.getSlowQueries()).toEqual([]);
    expect(await opened.getActiveSessions()).toEqual([]);
    expect(await opened.getTableStats()).toEqual([]);
    expect(await opened.getIndexStats()).toEqual([]);
    expect(await opened.getStorageStats()).toEqual([]);
    await opened.disconnect();
    expect(catalog.closed).toBe(1);
    await expect(opened.query("SELECT 1")).rejects.toThrow(/Not connected/);
  });

  test("follows a schema page on api.stripe.com and refuses one anywhere else", async () => {
    const paged = scripted([
      {
        body: {
          data: [{ id: "schema_1", name: "charges", columns: [] }],
          next_page_url: "https://api.stripe.com:443/v2/data/schemas?page=2",
        },
      },
      { body: { data: [{ id: "schema_3", name: "refunds", columns: 1 }], next_page_url: "/v2/data/schemas?page=3" } },
      { body: { data: [], next_page_url: null } },
      { body: reports },
    ]);
    const opened = provider(paged.createTransport);
    await opened.connect();
    expect(paged.requests[1]?.url).toContain("page=2");
    expect(paged.requests[2]?.url).toContain("page=3");
    expect((await opened.listObjects(["analytical"], "table")).map((table) => table.name)).toEqual([
      "charges",
      "refunds",
    ]);
    expect((await opened.describeObject(["analytical", "refunds"], "table")).columns).toEqual([]);

    const evil = scripted([{ body: { data: [], next_page_url: "https://evil.example/v2/data/schemas?page=2" } }]);
    await expect(provider(evil.createTransport).connect()).rejects.toThrow(/not on api.stripe.com/);
    const signed = scripted([
      { body: { data: [], next_page_url: "https://user:sk_test_secret_value@api.stripe.com/v2/data/schemas" } },
    ]);
    let signedMessage = "";
    try {
      await provider(signed.createTransport).connect();
    } catch (error) {
      signedMessage = error instanceof Error ? error.message : "";
    }
    expect(signedMessage).toMatch(/not on api.stripe.com/);
    expect(signedMessage).not.toContain("sk_test");
    await expect(
      provider(
        scripted([{ body: { data: [], next_page_url: "https://api.stripe.com:8443/v2/data/schemas" } }])
          .createTransport,
      ).connect(),
    ).rejects.toThrow(/not on api.stripe.com/);
    await expect(
      provider(
        scripted([{ body: { data: [], next_page_url: "https://api.stripe.com/v1/charges" } }]).createTransport,
      ).connect(),
    ).rejects.toThrow(/not on api.stripe.com/);
    await expect(
      provider(
        scripted([{ body: { data: [], next_page_url: "http://api.stripe.com/v2/data/schemas" } }]).createTransport,
      ).connect(),
    ).rejects.toThrow(/not on api.stripe.com/);
    await expect(
      provider(scripted([{ body: { data: [], next_page_url: "https://[" } }]).createTransport).connect(),
    ).rejects.toThrow(/not on api.stripe.com/);
    await expect(provider(scripted([{ body: { nope: true } }]).createTransport).connect()).rejects.toThrow(
      /did not return a list/,
    );

    const full = Array.from({ length: 50 }, () => ({
      body: {
        data: [{ id: "schema_1", name: "charges", columns: [] }],
        next_page_url: "https://api.stripe.com/v2/data/schemas?page=next",
      },
    }));
    await expect(provider(scripted(full).createTransport).connect()).rejects.toThrow(/more pages/);
  });

  test("loads a table or a report when the list did not include its fields", async () => {
    const catalog = scripted([
      { body: { data: [{ id: "schema_2", name: "charges" }], next_page_url: null } },
      { body: { data: [{ id: "report_2", name: "plain.report" }], next_page_url: null } },
      { body: { id: "schema_2", name: "charges", columns: [{ name: "id", type: "varchar", is_primary_key: true }] } },
      {
        body: { id: "report_2", name: "plain.report", parameters: { window: { type: "timestamp", required: false } } },
      },
    ]);
    const opened = provider(catalog.createTransport);
    await opened.connect();
    const table = await opened.describeObject(["analytical", "charges"], "table");
    expect(table.columns).toEqual([{ name: "id", type: "varchar", nullable: false, isPrimary: true }]);
    expect(catalog.requests[2]?.url).toBe("https://api.stripe.com/v2/data/schemas/schema_2");
    await opened.describeObject(["analytical", "charges"], "table");
    expect(catalog.requests).toHaveLength(3);
    const report = await opened.describeObject(["reports", "plain.report"], "report");
    expect(report.columns).toEqual([{ name: "window", type: "timestamp", nullable: true, isPrimary: false }]);
    expect(catalog.requests[3]?.url).toBe("https://api.stripe.com/v2/data/reports/report_2");
  });

  test("runs a report, and a click names the parameters a report still needs", async () => {
    const catalog = scripted([
      { body: schemas },
      { body: reports },
      { body: { id: "rrun_1", status: "succeeded" } },
      {
        body: {
          id: "rrun_1",
          status: "succeeded",
          result: {
            inline: {
              columns: [{ name: "amount", type: "bigint" }],
              rows: [{ data: { amount: "10" } }],
              next_page_url: "",
            },
          },
        },
      },
    ]);
    const opened = provider(catalog.createTransport);
    await opened.connect();
    await expect(opened.query('SELECT * FROM "reports"."balance.summary" LIMIT 500')).rejects.toThrow(
      /interval_start =>/,
    );
    expect(catalog.requests).toHaveLength(2);
    const ran = await opened.query("REPORT plain.report (window => '2026-01-01T00:00:00.000Z')");
    expect(JSON.parse(catalog.requests[2]?.body ?? "{}")).toEqual({
      report: { name: "plain.report" },
      parameters: { window: "2026-01-01T00:00:00.000Z" },
      format: "csv",
    });
    expect(ran.rows).toEqual([{ amount: "10" }]);
    const preview = scripted([
      { body: schemas },
      { body: reports },
      { body: { id: "rrun_2", status: "succeeded" } },
      { body: { id: "rrun_2", status: "succeeded", result: { inline: { rows: [{ data: { id: "r1", n: 2 } }] } } } },
    ]);
    const other = provider(preview.createTransport);
    await other.connect();
    const rows = await other.query('SELECT * FROM "reports"."plain.report";');
    expect(JSON.parse(preview.requests[2]?.body ?? "{}")).toMatchObject({
      report: { name: "plain.report" },
      parameters: {},
    });
    expect(rows.fields).toEqual(["id", "n"]);
    expect(rows.rows).toEqual([{ id: "r1", n: 2 }]);
  });

  test("polls a running query and stops at the deadline", async () => {
    const slow = scripted([
      { body: schemas },
      { body: reports },
      { body: { id: "qrun_9", status: "running" } },
      { body: queryRun },
      {
        body: {
          ...inline,
          result: { inline: { columns: [{ name: "id" }], rows: [], next_page_url: "https://evil.example/next" } },
        },
      },
    ]);
    const opened = provider(slow.createTransport);
    await opened.connect();
    const warned = await opened.query("SELECT id FROM charges");
    expect(slow.requests[3]?.method).toBe("GET");
    expect(warned.warnings?.[0]?.message).toContain("1000");
    expect(warned.warnings?.[0]?.message).not.toContain("evil.example");
    expect(slow.requests.every((request) => !request.url.includes("evil.example"))).toBe(true);

    const early = scripted([{ body: schemas }, { body: reports }, { body: { id: "qrun_1", status: "running" } }]);
    const earlyOpened = provider(early.createTransport, {}, {}, clock([0, 0, 70_000]));
    await earlyOpened.connect();
    await expect(earlyOpened.query("SELECT 1")).rejects.toBeInstanceOf(TimeoutError);
    const late = scripted([{ body: schemas }, { body: reports }, { body: { id: "qrun_1", status: "running" } }]);
    const lateOpened = provider(late.createTransport, {}, {}, clock([0, 0, 0, 70_000]));
    await lateOpened.connect();
    await expect(lateOpened.query("SELECT 1")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("uses the real clock while a run is still going", async () => {
    const live = scripted([
      { body: schemas },
      { body: reports },
      { body: { id: "qrun_1", status: "running" } },
      { body: queryRun },
      {
        body: {
          id: "qrun_1",
          status: "succeeded",
          result: { inline: { columns: [{ name: "id" }], rows: [{ data: { id: "a" } }] } },
        },
      },
    ]);
    const opened = new StripeProvider(connection, {}, live.createTransport);
    await opened.connect();
    const rows = await opened.query("SELECT id FROM charges");
    expect(rows.rows).toEqual([{ id: "a" }]);
  });

  test("reports a failed run without the key or the download URL", async () => {
    const token = "sk_test_secret_value";
    const failed = (body: unknown) => scripted([{ body: schemas }, { body: reports }, { body }]);
    async function failQuery(body: unknown, sql = "SELECT 1"): Promise<unknown> {
      const probe = failed(body);
      const opened = provider(probe.createTransport);
      await opened.connect();
      return opened.query(sql).then(
        () => {
          throw new Error("the run was accepted");
        },
        (error: unknown) => error,
      );
    }
    const canceled = await failQuery({ id: "qrun_1", status: "canceled" });
    expect(canceled instanceof Error ? canceled.message : "").toMatch(/canceled/);
    const invalid = await failQuery({
      id: "qrun_1",
      status: "failed",
      status_details: {
        code: "query_run_invalid_sql",
        query_errors: [{ type: "unknown_column", message: `bad ${token}` }, "skip", { message: "" }],
      },
    });
    expect(invalid instanceof Error ? invalid.message : "").toMatch(/••••/);
    expect(invalid instanceof Error ? invalid.message : "").not.toContain(token);
    const detailed = await failQuery({
      id: "qrun_1",
      status: "failed",
      status_details: { message: "too big", query_errors: [] },
    });
    expect(detailed instanceof Error ? detailed.message : "").toMatch(/too big/);
    const plain = await failQuery({ id: "qrun_1", status: "failed", message: "nope" });
    expect(plain instanceof Error ? plain.message : "").toMatch(/nope/);
    const bare = await failQuery({ id: "qrun_1", status: "failed" });
    expect(bare instanceof Error ? bare.message : "").toMatch(/Stripe run failed/);
    const weird = await failQuery({ id: "qrun_1", status: "paused" });
    expect(weird instanceof Error ? weird.message : "").toMatch(/paused/);
    const nameless = await failQuery({ status: "succeeded" });
    expect(nameless instanceof Error ? nameless.message : "").toMatch(/will not request/);
    const shapeless = await failQuery({ id: "qrun_1" });
    expect(shapeless instanceof Error ? shapeless.message : "").toMatch(/did not return a run/);
    const fileProbe = scripted([
      { body: schemas },
      { body: reports },
      { body: { id: "qrun_1", status: "succeeded" } },
      {
        body: {
          id: "qrun_1",
          status: "succeeded",
          result: { file: { download_url: { url: "https://stripeusercontent.com/x" } } },
        },
      },
    ]);
    const fileOpened = provider(fileProbe.createTransport);
    await fileOpened.connect();
    let fileMessage = "";
    try {
      await fileOpened.query("SELECT 1");
    } catch (error) {
      fileMessage = error instanceof Error ? error.message : "";
    }
    expect(fileMessage).toMatch(/does not download/);
    expect(fileMessage).not.toContain("stripeusercontent");
    expect(fileProbe.requests.every((request) => request.url.startsWith("https://api.stripe.com/"))).toBe(true);
    const long = provider(scripted([{ body: schemas }, { body: reports }]).createTransport);
    await long.connect();
    await expect(long.query(`SELECT ${"a".repeat(100_000)}`)).rejects.toThrow(/100000/);
  });

  test("connects when only one of the two reads is granted", async () => {
    const queriesOnly = scripted([{ body: schemas }, { status: 403, body: { error: { message: "no reports" } } }]);
    const queries = provider(queriesOnly.createTransport);
    await queries.connect();
    expect(await queries.countObjects(["reports"])).toEqual({ report: { count: 0 } });
    const reportsOnly = scripted([{ status: 403, body: { error: { message: "no schemas" } } }, { body: reports }]);
    const reported = provider(reportsOnly.createTransport);
    await reported.connect();
    expect(await reported.countObjects(["analytical"])).toEqual({ table: { count: 0 } });
    const neither = scripted([
      { status: 403, body: { error: { message: "no" } } },
      { status: 403, body: { error: { message: "no" } } },
    ]);
    await expect(provider(neither.createTransport).connect()).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(neither.closed).toBe(1);
    const broken = scripted([{ body: schemas }, { status: 500, text: "down" }]);
    await expect(provider(broken.createTransport).connect()).rejects.toThrow("down");
    expect(broken.closed).toBe(1);
  });

  test("reports API failures without repeating the key", async () => {
    const token = "sk_test_secret_value";
    const denied = scripted([{ status: 401, body: { error: { message: "nope" } } }]);
    await expect(provider(denied.createTransport).connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(denied.closed).toBe(1);
    await expect(provider(scripted([{ status: 400, text: "" }]).createTransport).connect()).rejects.toThrow(
      /answered 400/,
    );
    await expect(provider(scripted([{ status: 400, text: "[]" }]).createTransport).connect()).rejects.toThrow(
      /answered 400/,
    );
    await expect(
      provider(scripted([{ throw: new Error(`offline ${token}`) }]).createTransport).connect(),
    ).rejects.toThrow(/••••/);
    await expect(provider(scripted([{ throw: "offline" }]).createTransport).connect()).rejects.toThrow(
      /could not be reached/,
    );
    await expect(
      provider(scripted([{ status: 400, body: { error: { message: `bad ${token}` } } }]).createTransport).connect(),
    ).rejects.toThrow(/••••/);
    await expect(provider(scripted([{ status: 302, text: "go" }]).createTransport).connect()).rejects.toThrow(
      /does not follow/,
    );
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(provider(scripted([{ text: huge }]).createTransport).connect()).rejects.toThrow(/larger than 2 MB/);
    const stolen = "https://evil.example/steal";
    await expect(
      provider(scripted([{ throw: new TransportError("redirect", `Location: ${stolen}`) }]).createTransport).connect(),
    ).rejects.toThrow(/does not follow/);
    try {
      await provider(
        scripted([{ throw: new TransportError("redirect", `Location: ${stolen}`) }]).createTransport,
      ).connect();
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("evil.example");
    }
    await expect(
      provider(scripted([{ throw: new TransportError("too-large", "body") }]).createTransport).connect(),
    ).rejects.toThrow(/larger than 2 MB/);
    await expect(
      provider(scripted([{ throw: new TransportError("network", `reset ${token}`) }]).createTransport).connect(),
    ).rejects.toThrow(/••••/);
    await expect(
      provider(scripted([{ throw: new DatabaseConfigError("blocked", "stripe") }]).createTransport).connect(),
    ).rejects.toThrow("blocked");
    const idle = provider(scripted([]).createTransport);
    await idle.disconnect();
    await expect(idle.listContainers()).rejects.toThrow(/Not connected/);
  });
});
