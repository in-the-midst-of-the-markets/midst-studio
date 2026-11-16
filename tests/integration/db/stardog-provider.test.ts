/**
 * Stardog with an injected session, plus the address and SPARQL JSON reader.
 * A live server was not measured.
 */

import { describe, expect, test } from "bun:test";

import { AuthenticationError, PermissionDeniedError, QueryError } from "@/lib/db/errors";
import { StardogProvider, assertStardogRead } from "@/lib/db/providers/sql/stardog";
import {
  openStardogSession,
  readStardogAnswer,
  stardogAddress,
  stardogDatabase,
  stardogHttp,
  stardogNodeTransport,
  type StardogAnswer,
  type StardogHttp,
  type StardogSession,
} from "@/lib/db/providers/sql/stardog/session";
import { STARDOG_SQL_GRAMMAR } from "@/lib/db/providers/sql/stardog/sql-grammar";
import type { DatabaseConnection } from "@/lib/types";

const PERSON = "http://example.org/Person";
const NAME = "http://example.org/name";

interface Script {
  queries: string[];
  fail: unknown;
  answers: StardogAnswer[];
  ended: boolean;
  failEnd: boolean;
}

function script(): Script {
  return { queries: [], fail: undefined, answers: [], ended: false, failEnd: false };
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "sd",
    name: "Graph",
    host: "stardog.example.com",
    port: 5820,
    user: "admin",
    password: "secret",
    database: "catalog",
    ssl: { mode: "verify-full" },
    ...overrides,
    type: "stardog",
    createdAt: overrides.createdAt ?? new Date("2026-11-15T00:00:00.000Z"),
  };
}

function rows(fields: string[], values: unknown[][]): StardogAnswer {
  return {
    fields,
    rows: values.map((line) => Object.fromEntries(fields.map((field, index) => [field, line[index]]))),
    ask: null,
  };
}

function open(current: Script) {
  return async (): Promise<StardogSession> => ({
    async query(sparql: string): Promise<StardogAnswer> {
      current.queries.push(sparql);
      if (current.fail !== undefined) throw current.fail;
      return current.answers.shift() ?? { fields: [], rows: [], ask: null };
    },
    async end() {
      current.ended = true;
      if (current.failEnd) throw new Error("end failed");
    },
  });
}

function provider(current: Script, overrides: Partial<DatabaseConnection> = {}): StardogProvider {
  return new StardogProvider(connection(overrides), {}, undefined, open(current));
}

async function connected(current: Script, overrides: Partial<DatabaseConnection> = {}): Promise<StardogProvider> {
  current.answers.unshift({ fields: ["ask"], rows: [{ ask: true }], ask: true });
  const engine = provider(current, overrides);
  await engine.connect();
  current.queries.length = 0;
  return engine;
}

describe("Stardog address", () => {
  test("needs a database name and a host", () => {
    expect(() => stardogDatabase("")).toThrow(/database name/);
    expect(() => stardogDatabase("1bad")).toThrow(/database name/);
    expect(stardogDatabase("catalog")).toBe("catalog");
    expect(() => stardogAddress(connection({ host: "  " }))).toThrow(/host/);
    expect(() => stardogAddress(connection({ host: "http://user:pw@stardog.example.com" }))).toThrow(/fields/);
    expect(() => stardogAddress(connection({ host: "not a host" }))).toThrow(/host/);
    expect(() => stardogAddress(connection({ host: "http://[" }))).toThrow(/host/);
    expect(() => stardogAddress(connection({ host: "https://stardog.example.com", ssl: { mode: "disable" } }))).toThrow(
      /disable/,
    );
  });

  test("a remote password without TLS is refused until the box is ticked", () => {
    expect(() => stardogAddress(connection({ ssl: { mode: "disable" } }))).toThrow(/without TLS/);
    expect(stardogAddress(connection({ ssl: { mode: "disable" }, allowInsecureAuth: true })).origin.scheme).toBe(
      "http",
    );
    expect(stardogAddress(connection({ host: "127.0.0.1", ssl: { mode: "disable" } })).origin.scheme).toBe("http");
    expect(
      stardogAddress(connection({ host: "http://stardog.example.com:5821/ignored", allowInsecureAuth: true })).origin
        .port,
    ).toBe(5821);
    expect(() => stardogNodeTransport(connection({ user: "" }))).toThrow(/user/);
    expect(() => stardogNodeTransport(connection({ user: "a:b" }))).toThrow(/cannot send/);
    expect(() => stardogNodeTransport(connection({ password: "bad\nsecret" }))).toThrow(/cannot send/);
  });

  test("opens the node transport and posts the query", async () => {
    const { origin, transport } = stardogNodeTransport(connection());
    const http = stardogHttp(transport, origin);
    const seen: { path?: string; form?: Readonly<Record<string, string>> } = {};
    const scripted: StardogHttp = {
      async request(input) {
        seen.path = input.path;
        seen.form = input.form;
        return { status: 200, text: JSON.stringify({ boolean: false }) };
      },
      close() {
        http.close();
      },
    };
    const session = await openStardogSession(connection(), scripted);
    expect((await session.query("ASK { ?s ?p ?o }")).ask).toBe(false);
    expect(seen.path).toBe("/catalog/query");
    expect(seen.form?.query).toBe("ASK { ?s ?p ?o }");
    await session.end();
    const built = await openStardogSession(connection());
    await built.end();
    const fake = {
      async request() {
        return { status: 200, contentType: null, retryAfter: null, text: '{"boolean":true}' };
      },
      close() {},
    };
    const wrapped = stardogHttp(fake as unknown as import("@/lib/db/http/node-transport").NodeTransport, origin);
    expect((await wrapped.request({ method: "POST", path: "/catalog/query", form: { query: "ASK {}" } })).status).toBe(
      200,
    );
    wrapped.close();
  });
});

describe("SPARQL JSON", () => {
  test("reads an ASK, a number, a cut literal and the refusals", () => {
    expect(readStardogAnswer(200, JSON.stringify({ boolean: true }), "ASK {}").rows).toEqual([{ ask: true }]);
    const select = readStardogAnswer(
      200,
      JSON.stringify({
        head: { vars: ["n", "label", "missing", "odd", "n2"] },
        results: {
          bindings: [
            {
              n: { type: "literal", value: "3", datatype: "http://www.w3.org/2001/XMLSchema#integer" },
              label: { type: "literal", value: "x".repeat(5000) },
              odd: { type: "literal", value: 1 },
              n2: { type: "literal", value: "nope", datatype: "http://www.w3.org/2001/XMLSchema#integer" },
            },
          ],
        },
      }),
      "SELECT",
    );
    expect(select.rows[0].n).toBe(3);
    expect(String(select.rows[0].label)).toHaveLength(4000);
    expect(select.rows[0].missing).toBeNull();
    expect(select.rows[0].odd).toBeNull();
    expect(() => readStardogAnswer(401, JSON.stringify({ message: "nope" }), "ASK {}")).toThrow(AuthenticationError);
    expect(() => readStardogAnswer(403, "plain refusal", "ASK {}")).toThrow(PermissionDeniedError);
    expect(() => readStardogAnswer(400, "", "ASK {}")).toThrow(/answered 400/);
    expect(() => readStardogAnswer(200, "nope", "ASK {}")).toThrow(/JSON/);
    expect(() => readStardogAnswer(200, "null", "ASK {}")).toThrow(/result/);
    expect(() => readStardogAnswer(200, JSON.stringify({ boolean: "yes" }), "ASK {}")).toThrow(/ASK/);
    expect(() => readStardogAnswer(200, JSON.stringify({ head: { vars: [1] } }), "ASK {}")).toThrow(/rows/);
    expect(readStardogAnswer(200, JSON.stringify({ head: {}, results: { bindings: [] } }), "S").fields).toEqual([]);
    expect(() => readStardogAnswer(500, JSON.stringify({ other: true }), "ASK {}")).toThrow(/answered 500/);
    expect(
      readStardogAnswer(200, JSON.stringify({ head: { vars: [] }, results: { bindings: [null] } }), "S").rows,
    ).toEqual([{}]);
  });
});

describe("Stardog provider", () => {
  test("connects once and a failed open is closed", async () => {
    const current = script();
    const engine = await connected(current);
    await engine.connect();
    expect(current.queries).toEqual([]);
    expect(engine.getLabels().entityName).toBe("Class");
    expect(engine.prepareQuery("SELECT ?s WHERE { ?s ?p ?o }", { limit: 10 }).wasLimited).toBe(false);
    const again = script();
    again.fail = new AuthenticationError("no", "stardog");
    await expect(provider(again).connect()).rejects.toThrow(AuthenticationError);
    expect(again.ended).toBe(true);
    const broken = script();
    broken.fail = "down";
    await expect(provider(broken).connect()).rejects.toThrow(/could not be reached/);
    const ending = script();
    ending.fail = new QueryError("no", "stardog");
    ending.failEnd = true;
    await expect(provider(ending).connect()).rejects.toThrow(QueryError);
  });

  test("runs a SELECT and refuses a write and a parameter", async () => {
    const current = script();
    const engine = await connected(current);
    current.answers.push(rows(["s"], [[PERSON]]));
    const result = await engine.query("PREFIX ex: <http://example.org/> SELECT ?s WHERE { ?s a ex:Person }");
    expect(result.fields).toEqual(["s"]);
    expect(result.rows).toEqual([{ s: PERSON }]);
    await expect(engine.query("INSERT DATA { <a> <b> <c> }")).rejects.toThrow(/reads/);
    await expect(engine.query("SELECT ?s WHERE { ?s ?p ?o }", [1])).rejects.toThrow(/parameters/);
    await expect(provider(script()).query("SELECT ?s WHERE { ?s ?p ?o }")).rejects.toThrow(/Not connected/);
    assertStardogRead("BASE <http://example.org/> SELECT ?s WHERE { ?s ?p 'INSERT' }");
    expect(() => assertStardogRead("SELECT ?s WHERE { ?s ?p ?o } INSERT")).toThrow(/reads/);
    expect(() => assertStardogRead("CLEAR ALL")).toThrow(QueryError);
  });

  test("lists classes and describes properties once", async () => {
    const current = script();
    const engine = await connected(current);
    expect(await engine.listContainers(["other"])).toEqual([]);
    expect(await engine.listContainers()).toEqual([{ path: ["catalog"], name: "catalog", level: 0 }]);
    current.answers.push(rows(["count"], [[2]]));
    expect(await engine.countObjects(["catalog"])).toEqual({ class: { count: 2 } });
    current.answers.push(rows(["class"], [[PERSON], ["not a uri"], [PERSON]]));
    expect(await engine.listObjects(["catalog"], "class")).toEqual([
      { path: ["catalog", PERSON], name: PERSON, kind: "class" },
    ]);
    current.answers.push(rows(["property"], [[NAME]]));
    const detail = await engine.describeObject(["catalog", PERSON], "class");
    expect(detail.columns).toEqual([{ name: NAME, type: "text", nullable: true, isPrimary: false }]);
    const again = await engine.describeObject(["catalog", PERSON], "class");
    expect(again.columns).toHaveLength(1);
    expect(current.queries.filter((query) => query.includes("property"))).toHaveLength(1);
    await expect(engine.describeObject(["catalog", "Person"], "class")).rejects.toThrow(/no class/);
    await expect(engine.listObjects(["catalog"], "view")).rejects.toThrow(/no object kind/);
    current.answers.push(rows(["count"], [["no"]]));
    await expect(engine.countObjects(["catalog"])).rejects.toThrow(/class count/);
  });

  test("a bulk read stops at the caller's limit", async () => {
    const current = script();
    const engine = await connected(current);
    current.answers.push(rows(["class"], [[PERSON], ["urn:example:Other"]]));
    current.answers.push(rows(["property"], [[NAME]]));
    const batch = await engine.describeObjects(["catalog"], "class", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated?.limit).toBe(1);
    await expect(engine.describeObjects(["catalog"], "class", 0)).rejects.toThrow(/positive whole number/);
    current.answers.push(rows(["class"], []));
    expect((await engine.describeObjects(["catalog"], "class")).details).toEqual([]);
    await engine.disconnect();
    expect(current.ended).toBe(true);
    await engine.disconnect();
  });

  test("monitoring stays empty and maintenance is refused", async () => {
    const engine = provider(script());
    expect((await engine.getHealth()).databaseSize).toBe("N/A");
    expect((await engine.getOverview()).version).toBe("Stardog SPARQL");
    expect(await engine.getPerformanceMetrics()).toEqual({});
    expect(await engine.getSlowQueries()).toEqual([]);
    expect(await engine.getActiveSessions()).toEqual([]);
    expect(await engine.getTableStats()).toEqual([]);
    expect(await engine.getIndexStats()).toEqual([]);
    expect(await engine.getStorageStats()).toEqual([]);
    await expect(engine.runMaintenance()).rejects.toThrow(/maintenance/);
    expect(STARDOG_SQL_GRAMMAR.completion.formatSegment?.(PERSON)).toBe(`<${PERSON}>`);
    expect(STARDOG_SQL_GRAMMAR.completion.formatSegment?.("local")).toBe("local");
    expect(STARDOG_SQL_GRAMMAR.completion.readQuotedQualifier?.(`<${PERSON}>.`)).toBe(PERSON);
    expect(STARDOG_SQL_GRAMMAR.completion.readQuotedQualifier?.('"A""B".')).toBe('A"B');
  });
});
