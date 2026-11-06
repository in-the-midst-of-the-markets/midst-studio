import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { openDbtProject, readDbtRequest } from "@/lib/dbt/open";
import { DBT_TARGETS, connectionSecrets, dbtCompileProfile, dbtProfile, dbtSchema } from "@/lib/dbt/profile";
import { previewModel, readDbtProject, refsIn, sourceSchemas, sourcesIn } from "@/lib/dbt/project";
import {
  compileEnvironment,
  compileProject,
  prepareProject,
  projectCompileRefusal,
  redactSecrets,
  spawnCaptured,
} from "@/lib/dbt/runner";
import { readMetrics } from "@/lib/metricflow/metrics";
import {
  GITHUB_FILE_CAP,
  GITHUB_FILE_CHARS,
  GITHUB_JSON_CAP,
  modelPathsOf,
  parseGitDirectory,
  parseGitHubRepo,
  parseGitRef,
  parseGitToken,
  readGitHubProject,
  selectProjectFiles,
} from "@/lib/git/github";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

function connection(type: DatabaseType, extra: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: "c1", name: "Warehouse", type, createdAt: new Date(), ...extra };
}

const PROJECT = "name: analytics\nmodel-paths:\n  - models\n";
const ORDERS = "select * from {{ ref('stg_orders') }}\n{{ config(materialized='view') }}\n";
const STAGING = "select * from {{ source('raw', 'orders') }}\n";
const SOURCES = "sources:\n  - name: raw\n    schema: staging\n";

function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "dbt_project.yml": PROJECT,
    "packages.yml": "packages: []\n",
    "models/orders.sql": ORDERS,
    "models/stg_orders.sql": STAGING,
    "models/schema.yml": SOURCES,
    "README.md": "notes",
    ...extra,
  };
}

function githubFetch(
  tree: Record<string, string>,
  options: { status?: number; truncated?: boolean; branch?: unknown; json?: boolean; throw?: boolean } = {},
) {
  const seen: { url: string; authorization: string | null; redirect: RequestRedirect | null }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (options.throw) throw new Error("offline");
    const url = String(input);
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect ?? null,
    });
    if (options.status !== undefined && !url.includes("/contents/"))
      return new Response("no", { status: options.status });
    if (url.includes("/git/trees/")) {
      return Response.json({
        truncated: options.truncated === true,
        tree: [
          null,
          { path: 1 },
          { path: "other/skip.sql", type: "blob" },
          { path: "models", type: "tree" },
          ...Object.keys(tree).map((path) => ({ path, type: "blob" })),
        ],
      });
    }
    if (url.includes("/contents/")) {
      const path = decodeURIComponent(url.split("/contents/")[1]?.split("?")[0] ?? "");
      const text = tree[path];
      if (text === undefined) return new Response("missing", { status: 404 });
      return new Response(text);
    }
    if (options.json === false) return new Response("not-json", { status: 200 });
    return Response.json({ default_branch: options.branch ?? "main" });
  };
  return { fetchImpl, seen };
}

describe("GitHub repository", () => {
  test("accepts owner/repo and a github.com URL", () => {
    expect(parseGitHubRepo("  acme/analytics  ")).toEqual({ owner: "acme", repo: "analytics" });
    expect(parseGitHubRepo("https://github.com/acme/analytics.git")).toEqual({ owner: "acme", repo: "analytics" });
    expect(parseGitHubRepo("https://github.com/acme/analytics/tree/main")).toEqual({
      owner: "acme",
      repo: "analytics",
    });
    expect(parseGitRef("")).toBe("");
    expect(parseGitRef("refs/heads/main")).toBe("refs/heads/main");
    expect(parseGitDirectory("")).toBe("");
    expect(parseGitDirectory("./models/")).toBe("models");
    expect(parseGitToken("")).toBe("");
    expect(parseGitToken("ghp_abc.123")).toBe("ghp_abc.123");
  });

  test("refuses a repository, ref, directory or token it will not request", () => {
    const badRepos = [
      "",
      "acme",
      "acme/analytics/extra",
      "https://",
      "http://github.com/acme/analytics",
      "https://user:pass@github.com/acme/analytics",
      "https://gitlab.com/acme/analytics",
      "https://github.com/acme",
      "-acme/analytics",
      "acme/.",
      "acme/..",
    ];
    for (const repo of badRepos) expect(typeof parseGitHubRepo(repo)).toBe("string");
    expect(parseGitRef("a..b")).toBeNull();
    expect(parseGitRef("/main")).toBeNull();
    expect(parseGitRef("main/")).toBeNull();
    expect(parseGitRef("main branch")).toBeNull();
    expect(parseGitDirectory("models/../secret")).toBeNull();
    expect(parseGitDirectory("/models")).toBeNull();
    expect(parseGitDirectory("models\\secret")).toBeNull();
    expect(parseGitDirectory("models//secret")).toBeNull();
    expect(parseGitDirectory("models/./secret")).toBeNull();
    expect(parseGitToken("token with space")).toBeNull();
  });

  test("reads the default branch, the model files and a token header", async () => {
    const { fetchImpl, seen } = githubFetch(files());
    const project = await readGitHubProject(
      { owner: "acme", repo: "analytics" },
      { ref: "", directory: "", token: "ghp_abc", fetch: fetchImpl },
    );
    expect(typeof project).not.toBe("string");
    if (typeof project === "string") return;
    expect(project.ref).toBe("main");
    expect(project.files.map((file) => file.path).sort()).toEqual([
      "dbt_project.yml",
      "models/orders.sql",
      "models/schema.yml",
      "models/stg_orders.sql",
      "packages.yml",
    ]);
    expect(seen.some((call) => call.authorization === "Bearer ghp_abc")).toBe(true);
    expect(seen.every((call) => !call.url.includes("ghp_abc"))).toBe(true);
    expect(seen.every((call) => call.redirect === "manual")).toBe(true);
  });

  test("uses the requested ref and directory", async () => {
    const tree = {
      "warehouse/dbt_project.yml": 'name: analytics\nmodel-paths: ["marts"]\n',
      "warehouse/marts/orders.sql": "select 1\n",
      "warehouse/models/skip.sql": "select 2\n",
      "warehouse/packages.yml": "packages: []\n",
    };
    const { fetchImpl, seen } = githubFetch(tree);
    const project = await readGitHubProject(
      { owner: "acme", repo: "analytics" },
      { ref: "feature/one", directory: "warehouse", token: "", fetch: fetchImpl },
    );
    expect(typeof project).not.toBe("string");
    if (typeof project === "string") return;
    expect(project.ref).toBe("feature/one");
    expect(project.files.map((file) => file.path)).toContain("marts/orders.sql");
    expect(project.files.map((file) => file.path)).not.toContain("models/skip.sql");
    expect(seen.some((call) => call.url.includes("/git/trees/feature%2Fone"))).toBe(true);
    expect(seen.every((call) => call.authorization === null)).toBe(true);
  });

  test("reports one message when GitHub refuses or cannot be read", async () => {
    const refused = githubFetch(files(), { status: 401 });
    const missing = githubFetch(files(), { status: 404 });
    const repo = { owner: "acme", repo: "analytics" };
    const options = { ref: "main", directory: "", token: "", fetch: refused.fetchImpl };
    expect(await readGitHubProject(repo, options)).toBe(
      "This repository could not be read. Check the name and the token.",
    );
    expect(await readGitHubProject(repo, { ...options, fetch: missing.fetchImpl })).toBe(
      options && "This repository could not be read. Check the name and the token.",
    );
    const unreadable = githubFetch(files());
    const readable = unreadable.fetchImpl;
    unreadable.fetchImpl = async (input, init) => {
      if (String(input).includes("/git/trees/")) return new Response("not-json", { status: 200 });
      return readable(input, init);
    };
    expect(await readGitHubProject(repo, { ...options, fetch: unreadable.fetchImpl })).toBe(
      "GitHub returned a response that could not be read.",
    );
    expect(await readGitHubProject(repo, { ...options, fetch: githubFetch(files(), { throw: true }).fetchImpl })).toBe(
      "GitHub could not be reached.",
    );
    expect(
      await readGitHubProject(repo, { ...options, ref: "", fetch: githubFetch(files(), { branch: 4 }).fetchImpl }),
    ).toBe("GitHub did not name a branch.");
    expect(
      await readGitHubProject(repo, { ...options, ref: "", fetch: githubFetch(files(), { branch: "a..b" }).fetchImpl }),
    ).toBe("GitHub did not name a branch.");
    expect(
      await readGitHubProject(repo, { ...options, fetch: githubFetch(files(), { truncated: true }).fetchImpl }),
    ).toBe("This repository tree is too large to read.");
    const noTree = githubFetch(files());
    const original = noTree.fetchImpl;
    noTree.fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ truncated: false });
      return original(input, init);
    };
    expect(await readGitHubProject(repo, { ...options, fetch: noTree.fetchImpl })).toBe(
      "GitHub did not return the repository tree.",
    );
  });

  test("stops on a missing project, a file that is too large, or too many files", async () => {
    const repo = { owner: "acme", repo: "analytics" };
    const base = { ref: "main", directory: "", token: "", fetch: githubFetch({ "README.md": "no" }).fetchImpl };
    expect(await readGitHubProject(repo, base)).toBe("This repository has no dbt_project.yml.");
    const huge = "x".repeat(GITHUB_FILE_CHARS + 1);
    expect(await readGitHubProject(repo, { ...base, fetch: githubFetch({ "dbt_project.yml": huge }).fetchImpl })).toBe(
      "A model file is larger than 200KB.",
    );
    const many: Record<string, string> = { "dbt_project.yml": PROJECT };
    for (let index = 0; index < GITHUB_FILE_CAP; index += 1) many[`models/m${index}.sql`] = "select 1\n";
    expect(await readGitHubProject(repo, { ...base, fetch: githubFetch(many).fetchImpl })).toBe(
      `This project has more than ${GITHUB_FILE_CAP} model files.`,
    );
    const broken = githubFetch({ "dbt_project.yml": PROJECT, "packages.yml": "no" });
    const original = broken.fetchImpl;
    broken.fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.includes("/contents/") && url.includes("packages.yml")) return new Response("missing", { status: 404 });
      return original(input, init);
    };
    expect(await readGitHubProject(repo, { ...base, fetch: broken.fetchImpl })).toBe(
      "This repository could not be read. Check the name and the token.",
    );
    const oversized = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response("{}", { status: 200, headers: { "content-length": String(GITHUB_JSON_CAP + 1) } });
      }
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: oversized })).toBe(
      "GitHub returned a response that is too large.",
    );
    const fatBody = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/git/trees/"))
        return new Response(`{${" ".repeat(GITHUB_JSON_CAP)}}`, { status: 200 });
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: fatBody })).toBe(
      "GitHub returned a response that is too large.",
    );
    const fatFile = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "dbt_project.yml", type: "blob" }] });
      if (url.includes("/contents/")) {
        return new Response("name: analytics\n", {
          status: 200,
          headers: { "content-length": String(GITHUB_FILE_CHARS + 1) },
        });
      }
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: fatFile })).toBe("A model file is larger than 200KB.");
    const lyingLength = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "dbt_project.yml", type: "blob" }] });
      if (url.includes("/contents/")) {
        return new Response("x".repeat(GITHUB_FILE_CHARS + 1), { status: 200, headers: { "content-length": "10" } });
      }
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: lyingLength })).toBe("A model file is larger than 200KB.");
    const redirected = async (): Promise<Response> =>
      new Response("no", { status: 302, headers: { location: "http://127.0.0.1/secret" } });
    expect(await readGitHubProject(repo, { ...base, fetch: redirected })).toBe(
      "This repository could not be read. Check the name and the token.",
    );
    const emptyBody = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/git/trees/")) return new Response(null);
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: emptyBody })).toBe(
      "GitHub returned a response that could not be read.",
    );
    const brokenStream = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("/git/trees/")) {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("broken"));
            },
          }),
        );
      }
      return Response.json({ default_branch: "main" });
    };
    expect(await readGitHubProject(repo, { ...base, fetch: brokenStream })).toBe("GitHub could not be reached.");
  });

  test("reads model paths from either YAML shape", () => {
    expect(modelPathsOf("name: a\n")).toEqual(["models"]);
    expect(modelPathsOf("model-paths: []\n")).toEqual(["models"]);
    expect(modelPathsOf("model-paths: ['staging', \"marts\"]\n")).toEqual(["staging", "marts"]);
    expect(modelPathsOf('model-paths:\n  - "marts"\n')).toEqual(["marts"]);
    expect(selectProjectFiles([{ path: "nested/dbt_project.yml", type: "blob" }], "", ["models"])).toBe(
      "This repository has no dbt_project.yml.",
    );
  });
});

describe("dbt project", () => {
  test("lists models, refs and sources", () => {
    const project = readDbtProject([
      { path: "dbt_project.yml", text: "name: analytics\n" },
      { path: "models/orders.sql", text: "select * from {{ ref('pkg', 'stg_orders') }} and {{ ref(\"orders\") }}" },
      { path: "models/stg_orders.sql", text: STAGING },
      { path: "models/schema.yml", text: SOURCES },
      { path: "models/broken.yml", text: ":\n  - [" },
      { path: "models/empty.yml", text: "models: []\n" },
      { path: "models/odd.yml", text: "sources:\n  - name: bad-name\n    schema: staging\n  - schema: staging\n" },
    ]);
    expect(typeof project).not.toBe("string");
    if (typeof project === "string") return;
    expect(project.name).toBe("analytics");
    expect(project.models[0]?.refs).toEqual(["stg_orders", "orders"]);
    expect(sourcesIn(STAGING)).toEqual([{ source: "raw", table: "orders" }]);
    expect(sourceSchemas(project.models.flatMap(() => [])).size).toBe(0);
    const schemas = sourceSchemas([
      { path: "dbt_project.yml", text: "name: analytics\n" },
      { path: "models/schema.yml", text: SOURCES },
      { path: "models/broken.yml", text: ":\n  - [" },
      { path: "models/odd.yml", text: "sources:\n  - name: bad-name\n    schema: staging\n" },
      { path: "README.md", text: "no" },
    ]);
    expect(schemas.get("raw")).toBe("staging");
    const preview = previewModel(ORDERS, "analytics", schemas);
    expect(preview.sql).toContain("analytics.stg_orders");
    expect(preview.unresolved).toBe(true);
    expect(previewModel(STAGING, "not a schema", schemas).sql).toContain("staging.orders");
    expect(previewModel(STAGING, "analytics", new Map([["raw", "not schema"]])).sql).toContain("raw.orders");
    expect(refsIn("select 1")).toEqual([]);
  });

  test("refuses a project it cannot name", () => {
    expect(readDbtProject([])).toBe("This repository has no dbt_project.yml.");
    expect(readDbtProject([{ path: "dbt_project.yml", text: "name: &a analytics\nx: [*a]\n" }])).toBe(
      "dbt_project.yml could not be read.",
    );
    expect(readDbtProject([{ path: "dbt_project.yml", text: "name: [" }])).toBe("dbt_project.yml could not be read.");
    expect(readDbtProject([{ path: "dbt_project.yml", text: "name: 1\n" }])).toBe(
      "dbt_project.yml needs a project name.",
    );
    expect(readDbtProject([{ path: "dbt_project.yml", text: "profile: x\n" }])).toBe(
      "dbt_project.yml needs a project name.",
    );
    expect(
      readDbtProject([
        { path: "dbt_project.yml", text: "name: analytics\n" },
        { path: "models/has-dash.sql", text: "select 1" },
      ]),
    ).toBe("A model file is not named as a model: models/has-dash.sql.");
    const duplicate = readDbtProject([
      { path: "dbt_project.yml", text: "name: analytics\n" },
      { path: "models/orders.sql", text: "select 1" },
      { path: "marts/orders.sql", text: "select 2" },
    ]);
    expect(duplicate).toBe("Two models are named orders.");
  });
});

describe("dbt profile", () => {
  test("names a target for the warehouses the studio runs", () => {
    expect(new Set(Object.keys(DBT_TARGETS))).toEqual(new Set([...EXTERNAL_DATABASE_TYPES, "libredb"]));
    const postgres = dbtProfile(
      connection("postgres", {
        host: "db.example",
        port: 5433,
        user: "app",
        password: "a: b",
        database: "app",
        schema: "analytics",
      }),
    );
    expect("yaml" in postgres).toBe(true);
    if (!("yaml" in postgres)) return;
    const parsed = parse(postgres.yaml) as { midst: { target: string; outputs: { dev: Record<string, unknown> } } };
    expect(parsed.midst.target).toBe("dev");
    expect(parsed.midst.outputs.dev).toMatchObject({
      type: "postgres",
      host: "db.example",
      port: 5433,
      schema: "analytics",
      password: "a: b",
    });
    expect(dbtSchema(connection("postgres", { host: "db.example", password: "secret", schema: "analytics" }))).toBe(
      "analytics",
    );
    expect(
      dbtSchema(connection("duckdb", { connectionString: "md:motherduck_token=s3cret-token", schema: "main" })),
    ).toBe("main");
    const secrets = connectionSecrets(
      connection("postgres", {
        host: "db.example",
        password: "s3cret-password",
        connectionString: "postgres://db.example/app",
        sshTunnel: {
          enabled: true,
          host: "bastion",
          port: 22,
          username: "jump",
          authMethod: "privateKey",
          privateKey: "private-key-material",
          passphrase: "key-passphrase",
        },
        ssl: { mode: "require", clientKey: "client-key-material" },
      }),
    );
    expect(secrets).toContain("s3cret-password");
    expect(secrets).toContain("private-key-material");
    expect(secrets).toContain("client-key-material");
    expect(secrets).not.toContain(":memory:");
    const mysql = dbtProfile(
      connection("mysql", { host: "db.example", password: "secret", database: "app", schema: "other" }),
    );
    expect("yaml" in mysql && parse(mysql.yaml).midst.outputs.dev.schema).toBe("app");
    const clickhouse = dbtProfile(connection("clickhouse", { host: "db.example", password: "secret" }));
    expect("yaml" in clickhouse && parse(clickhouse.yaml).midst.outputs.dev.port).toBe(8123);
    const databend = dbtProfile(connection("databend", { host: "db.example", password: "secret" }));
    expect("yaml" in databend && parse(databend.yaml).midst.outputs.dev.schema).toBe("default");
    const snowflake = dbtProfile(
      connection("snowflake", { host: "xy123.snowflakecomputing.com", password: "secret", warehouse: "WH" }),
    );
    expect("yaml" in snowflake && parse(snowflake.yaml).midst.outputs.dev).toMatchObject({
      account: "xy123",
      warehouse: "WH",
      schema: "PUBLIC",
    });
    const plainHost = dbtProfile(connection("snowflake", { host: "xy123", password: "secret", warehouse: "" }));
    expect("yaml" in plainHost && parse(plainHost.yaml).midst.outputs.dev.account).toBe("xy123");
    expect("yaml" in plainHost && parse(plainHost.yaml).midst.outputs.dev.warehouse).toBeUndefined();
    const duck = dbtProfile(connection("duckdb", { connectionString: "/tmp/warehouse.duckdb" }));
    expect("yaml" in duck && parse(duck.yaml).midst.outputs.dev.path).toBe("/tmp/warehouse.duckdb");
    expect(dbtProfile(connection("duckdb", { database: "file.duckdb" }))).toHaveProperty("yaml");
    expect(dbtProfile(connection("duckdb"))).toHaveProperty("yaml");
    const compiling = dbtCompileProfile(
      connection("postgres", {
        host: "db.example",
        password: "s3cret-password",
        sshTunnel: {
          enabled: true,
          host: "bastion",
          port: 22,
          username: "jump",
          authMethod: "privateKey",
          privateKey: "private-key-material",
          password: "tunnel-password",
          passphrase: "key-passphrase",
        },
        ssl: { mode: "require", caCert: "ca-material", clientCert: "cert-material", clientKey: "client-key-material" },
      }),
    );
    expect("yaml" in compiling && compiling.yaml.includes("s3cret-password")).toBe(false);
    expect("yaml" in compiling && compiling.yaml.includes("private-key-material")).toBe(false);
    expect("yaml" in compiling && compiling.yaml.includes("client-key-material")).toBe(false);
    const duckCompile = dbtCompileProfile(connection("duckdb", { connectionString: "/tmp/warehouse.duckdb" }));
    expect("yaml" in duckCompile && parse(duckCompile.yaml).midst.outputs.dev.path).toBe(":memory:");
  });

  test("refuses a connection dbt cannot use", () => {
    expect(dbtProfile(connection("redis", { host: "db.example" }))).toEqual({
      error: "This connection has no dbt target.",
    });
    expect(dbtSchema(connection("redis"))).toBe("public");
    expect(dbtProfile(connection("postgres"))).toEqual({ error: "This connection has no host for dbt." });
    expect(dbtProfile(connection("postgres", { host: "db.example" }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtSchema(connection("postgres", { host: "db.example" }))).toBe("public");
    expect(dbtProfile(connection("postgres", { host: "db.example", password: "sec\nret" }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtProfile(connection("postgres", { host: "db\n.example", password: "secret" }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtProfile(connection("postgres", { host: "db.example/evil", password: "secret" }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtProfile(connection("postgres", { host: "db.example", password: "secret", port: 0 }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtProfile(connection("snowflake", { host: "org/account", password: "secret" }))).toEqual({
      error: "This connection has no Snowflake account for dbt.",
    });
    expect(dbtProfile(connection("mysql", { password: "secret", database: "app" }))).toEqual({
      error: "This connection has no host for dbt.",
    });
    expect(dbtProfile(connection("snowflake"))).toEqual({ error: "This connection has no Snowflake account for dbt." });
    expect(dbtProfile(connection("snowflake", { host: "xy123", password: "secret", warehouse: "WH\n2" }))).toEqual({
      error: "This connection has a value that cannot be written into a profile.",
    });
    expect(dbtProfile(connection("duckdb", { connectionString: "/tmp/a\ndb" }))).toEqual({
      error: "This connection's DuckDB path cannot be written into a profile.",
    });
    expect(dbtProfile(connection("duckdb", { schema: "a\nb" }))).toEqual({
      error: "This connection's DuckDB path cannot be written into a profile.",
    });
  });
});

describe("MetricFlow", () => {
  const semantic = `
semantic_models:
  - name: orders
    model: "ref('orders')"
    defaults:
      agg_time_dimension: ordered_at
    measures:
      - name: revenue
        agg: sum
        expr: amount
      - name: order_count
        agg: count
      - name: buyers
        agg: count_distinct
        expr: customer_id
      - name: smallest
        agg: min
        expr: amount
      - name: largest
        agg: max
        expr: amount
      - name: mean
        agg: avg
        expr: amount
      - name: rows
        agg: count
        expr: "*"
      - name: product
        agg: sum
        expr: "amount * price"
      - name: injected
        agg: sum
        expr: "(SELECT password FROM secrets)"
      - name: open_paren
        agg: sum
        expr: "(amount"
      - name: close_paren
        agg: sum
        expr: ")"
      - name: empty_expr
        agg: sum
        expr: ""
      - name: bad_expr
        agg: sum
        expr: "amount; drop"
      - name: bad_agg
        agg: median
        expr: amount
  - name: bad
    model: "orders"
  - name: 1bad
    model: "ref('orders')"
  - name: customers
    model: "ref('customers')"
    measures:
      - name: customers
        agg: count
        expr: id
metrics:
  - name: revenue
    label: Revenue
    type: simple
    type_params:
      measure: revenue
  - name: product
    label: "${"P".repeat(201)}"
    type: simple
    type_params:
      measure: product
  - name: buyers
    type: simple
    type_params:
      measure:
        name: buyers
  - name: missing
    type: simple
  - name: gone
    type: simple
    type_params:
      measure: not_there
  - name: average_order
    label: Average order
    type: ratio
    type_params:
      numerator: revenue
      denominator: order_count
  - name: mixed
    type: ratio
    type_params:
      numerator: revenue
      denominator: customers
  - name: half
    type: ratio
    type_params:
      numerator: revenue
  - name: lifetime
    type: cumulative
  - label: no name
`;

  test("builds chart SQL for a simple metric and a ratio on one model", () => {
    const metrics = readMetrics(
      [
        { path: "models/orders.yml", text: semantic },
        { path: "models/broken.yml", text: ":\n  - [" },
        { path: "README.md", text: "no" },
        { path: "models/empty.yml", text: "version: 2\n" },
      ],
      "analytics",
    );
    const revenue = metrics.find((metric) => metric.name === "revenue");
    expect(revenue?.sql).toContain("SUM(amount) AS revenue");
    expect(metrics.find((metric) => metric.name === "product")?.sql).toContain("SUM(amount * price)");
    expect(metrics.find((metric) => metric.name === "product")?.label).toBe("product");
    expect(metrics.some((metric) => metric.sql?.includes("SELECT password"))).toBe(false);
    expect(revenue?.sql).toContain("GROUP BY ordered_at");
    expect(revenue?.timeDimension).toBe("ordered_at");
    expect(metrics.find((metric) => metric.name === "buyers")?.label).toBe("buyers");
    expect(metrics.find((metric) => metric.name === "average_order")?.sql).toContain("NULLIF");
    expect(metrics.find((metric) => metric.name === "missing")?.reason).toBe("This metric does not name a measure.");
    expect(metrics.find((metric) => metric.name === "mixed")?.reason).toBe("This ratio uses measures from two models.");
    expect(metrics.find((metric) => metric.name === "half")?.reason).toBe("This ratio does not name two measures.");
    expect(metrics.find((metric) => metric.name === "lifetime")?.reason).toBe(
      "Only simple and ratio metrics can be charted.",
    );
    const plain = readMetrics(
      [
        {
          path: "models/orders.yml",
          text: "semantic_models:\n  - name: orders\n    model: ref('orders')\n    defaults:\n      agg_time_dimension: 1bad\n    measures:\n      - name: revenue\n        agg: sum\n        expr: amount\nmetrics:\n  - name: revenue\n    type: simple\n    type_params:\n      measure: revenue\n",
        },
      ],
      "not schema",
    );
    expect(plain[0]?.sql).toContain("'all' AS bucket");
    expect(plain[0]?.sql).toContain("public.orders");
    const called = readMetrics(
      [
        {
          path: "models/orders.yml",
          text: "semantic_models:\n  - name: orders\n    model: ref('orders')\n    measures:\n      - name: leaked\n        agg: sum\n        expr: pg_read_file(amount)\nmetrics:\n  - name: leaked\n    type: simple\n    type_params:\n      measure: leaked\n",
        },
      ],
      "public",
    );
    expect(called[0]?.sql).toBeNull();
  });
});

describe("opening a project", () => {
  test("returns models, a preview and whether the connection can compile", async () => {
    const bad = readDbtRequest({ repo: 1 }, false);
    expect(bad).toBe("Enter a GitHub repository.");
    expect(typeof readDbtRequest({ repo: "nope" }, false)).toBe("string");
    expect(readDbtRequest({ repo: "acme/analytics", ref: 1 }, false)).toBe("Enter a branch or leave it empty.");
    expect(readDbtRequest({ repo: "acme/analytics", directory: 1 }, false)).toBe(
      "Enter a directory or leave it empty.",
    );
    expect(readDbtRequest({ repo: "acme/analytics", token: 1 }, false)).toBe("Enter a token or leave it empty.");
    expect(readDbtRequest({ repo: "acme/analytics", ref: "a..b" }, false)).toBe("Enter a branch or leave it empty.");
    expect(readDbtRequest({ repo: "acme/analytics", directory: ".." }, false)).toBe(
      "Enter a directory or leave it empty.",
    );
    expect(readDbtRequest({ repo: "acme/analytics", token: "bad token" }, false)).toBe(
      "Enter a token or leave it empty.",
    );
    expect(readDbtRequest({ repo: "acme/analytics" }, true)).toBe("Choose a connection.");
    expect(readDbtRequest({ repo: "acme/analytics", connectionId: "x".repeat(201) }, true)).toBe(
      "Choose a connection.",
    );
    const request = readDbtRequest({ repo: "acme/analytics", connectionId: "c1" }, true);
    expect(typeof request).not.toBe("string");
    if (typeof request === "string") return;
    const { fetchImpl } = githubFetch(
      files({
        "models/metrics.yml":
          "metrics:\n  - name: revenue\n    label: Revenue\n    type: simple\n    type_params:\n      measure: revenue\nsemantic_models:\n  - name: orders\n    model: ref('orders')\n    defaults:\n      agg_time_dimension: ordered_at\n    measures:\n      - name: revenue\n        agg: sum\n        expr: amount\n",
      }),
    );
    const opened = await openDbtProject(
      request,
      fetchImpl,
      connection("postgres", { host: "db.example", password: "secret", schema: "analytics" }),
    );
    expect(typeof opened).not.toBe("string");
    if (typeof opened === "string") return;
    expect(opened.name).toBe("analytics");
    expect(opened.profile).toEqual({ ready: true });
    expect(opened.models.find((model) => model.name === "orders")?.preview).toContain("analytics.stg_orders");
    expect(opened.metrics[0]?.label).toBe("Revenue");
    const unconnected = await openDbtProject({ ...request, connectionId: null }, fetchImpl, null);
    expect(typeof unconnected !== "string" && unconnected.profile).toEqual({
      ready: false,
      reason: "Choose a connection to compile with dbt.",
    });
    const unsupported = await openDbtProject(request, fetchImpl, connection("redis"));
    expect(typeof unsupported !== "string" && unsupported.profile).toEqual({
      ready: false,
      reason: "This connection has no dbt target.",
    });
    const failed = await openDbtProject(request, githubFetch({}, { status: 404 }).fetchImpl, null);
    expect(failed).toBe("This repository could not be read. Check the name and the token.");
    const unnamed = await openDbtProject(request, githubFetch({ "dbt_project.yml": "profile: x\n" }).fetchImpl, null);
    expect(unnamed).toBe("dbt_project.yml needs a project name.");
  });
});

describe("dbt compile", () => {
  test("refuses a path it will not write", async () => {
    expect(await prepareProject([{ path: "../secret", text: "x" }], "profile: yes\n")).toBe(
      "A project file has a path dbt will not be given.",
    );
    expect(await prepareProject([{ path: "models\\orders.sql", text: "x" }], "profile: yes\n")).toBe(
      "A project file has a path dbt will not be given.",
    );
    const prepared = await prepareProject(
      [
        { path: "dbt_project.yml", text: "name: demo\n" },
        { path: "models/orders.sql", text: "select 1\n" },
      ],
      "profile: yes\n",
    );
    expect(typeof prepared).not.toBe("string");
    if (typeof prepared === "string") return;
    await prepared.cleanup();
  });

  test("returns compiled SQL and still finishes when cleanup fails", async () => {
    const files = [{ path: "dbt_project.yml", text: "name: demo\n" }];
    const compiled = await compileProject(files, "profile: yes\n", {
      prepare: async () => {
        const prepared = await prepareProject(files, "profile: yes\n");
        if (typeof prepared === "string") throw new Error(prepared);
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(prepared.projectDir, "target", "compiled", "demo"), { recursive: true });
        await writeFile(join(prepared.projectDir, "target", "compiled", "demo", "orders.sql"), "select 1\n");
        await writeFile(join(prepared.projectDir, "target", "compiled", "demo", "notes.txt"), "no\n");
        return prepared;
      },
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(compiled).toEqual({ files: { [join("demo", "orders.sql")]: "select 1\n" } });

    const root = await mkdtemp(join(tmpdir(), "midst-dbt-test-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "target", "compiled"), { recursive: true });
    await writeFile(join(root, "target", "compiled", "one.sql"), "select 2\n");
    const cleaned = await compileProject(files, "profile: yes\n", {
      prepare: async () => ({
        projectDir: root,
        profilesDir: root,
        cleanup: async () => {
          throw new Error("cleanup");
        },
      }),
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(cleaned).toEqual({ files: { "one.sql": "select 2\n" } });
    await rm(root, { recursive: true, force: true });
  });

  test("reports a failed compile, a missing result and a thrown runner", async () => {
    const files = [{ path: "dbt_project.yml", text: "name: demo\n" }];
    const failed = await compileProject(files, "profile: yes\n", {
      prepare: async () => ({ projectDir: tmpdir(), profilesDir: tmpdir(), cleanup: async () => {} }),
      spawn: async () => ({ code: 1, stdout: "", stderr: "y".repeat(9000) }),
    });
    expect("error" in failed && failed.error.length).toBe(8000);
    const empty = await compileProject(files, "profile: yes\n", {
      prepare: async () => prepareProject(files, "profile: yes\n"),
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(empty).toEqual({ error: "dbt produced no compiled SQL." });
    const quiet = await compileProject(files, "profile: yes\n", {
      prepare: async () => ({ projectDir: tmpdir(), profilesDir: tmpdir(), cleanup: async () => {} }),
      spawn: async () => ({ code: null, stdout: "", stderr: "" }),
    });
    expect(quiet).toEqual({ error: "dbt compile failed." });
    const thrown = await compileProject(files, "profile: yes\n", {
      prepare: async () => ({ projectDir: tmpdir(), profilesDir: tmpdir(), cleanup: async () => {} }),
      spawn: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown).toEqual({ error: "boom" });
    const unknown = await compileProject(files, "profile: yes\n", {
      prepare: async () => ({ projectDir: tmpdir(), profilesDir: tmpdir(), cleanup: async () => {} }),
      spawn: async () => {
        throw "no";
      },
    });
    expect(unknown).toEqual({ error: "dbt compile failed." });
    expect(await compileProject([{ path: "../secret", text: "x" }], "profile: yes\n")).toEqual({
      error: "A project file has a path dbt will not be given.",
    });
    const many = Array.from({ length: GITHUB_FILE_CAP + 1 }, (_item, index) => ({
      path: `models/m${index}.sql`,
      text: "select 1",
    }));
    expect(await prepareProject(many, "profile: yes\n")).toBe(
      `This project has more than ${GITHUB_FILE_CAP} model files.`,
    );
    expect(await prepareProject([{ path: "dbt_project.yml", text: "x".repeat(GITHUB_FILE_CHARS + 1) }], "x")).toBe(
      "A model file is larger than 200KB.",
    );
    const leaked = await compileProject(
      [{ path: "dbt_project.yml", text: "name: demo\n" }],
      "profile: yes\n",
      {
        prepare: async () => ({ projectDir: tmpdir(), profilesDir: tmpdir(), cleanup: async () => {} }),
        spawn: async () => ({ code: 1, stdout: "", stderr: "saw s3cret-password" }),
      },
      1000,
      ["s3cret-password", "short"],
    );
    expect(leaked).toEqual({ error: "saw [redacted]" });
    expect(redactSecrets("plain", ["short"])).toBe("plain");
    const refused = { error: "This project uses a dbt feature compile will not run." };
    expect(await compileProject([{ path: "models/orders.sql", text: "{{ env_var('JWT_SECRET') }}" }], "x")).toEqual(
      refused,
    );
    expect(await compileProject([{ path: "models/orders.sql", text: "{{ modules.datetime.date }}" }], "x")).toEqual(
      refused,
    );
    expect(await compileProject([{ path: "models/orders.sql", text: "select {{ name__id }}" }], "x")).toEqual(refused);
    expect(
      await compileProject([{ path: "models/orders.sql", text: "{% call statement('x') %}select 1" }], "x"),
    ).toEqual(refused);
    const hugeSql = await compileProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x", {
      prepare: async () => {
        const prepared = await prepareProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x");
        if (typeof prepared === "string") throw new Error(prepared);
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(prepared.projectDir, "target", "compiled"), { recursive: true });
        await writeFile(join(prepared.projectDir, "target", "compiled", "big.sql"), "x".repeat(200_001));
        return prepared;
      },
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(hugeSql).toEqual({ error: "dbt produced SQL that is too large." });
    const linked = await compileProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x", {
      prepare: async () => {
        const prepared = await prepareProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x");
        if (typeof prepared === "string") throw new Error(prepared);
        const compiled = join(prepared.projectDir, "target", "compiled");
        await mkdir(compiled, { recursive: true });
        const outside = join(prepared.profilesDir, "outside.txt");
        await writeFile(outside, "secret-file");
        await symlink(outside, join(compiled, "leak.sql"));
        await writeFile(join(compiled, "ok.sql"), "select 1");
        return prepared;
      },
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(linked).toEqual({ error: "dbt produced a file compile will not read." });
    const linkedDir = await compileProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x", {
      prepare: async () => {
        const prepared = await prepareProject([{ path: "dbt_project.yml", text: "name: demo\n" }], "x");
        if (typeof prepared === "string") throw new Error(prepared);
        const compiled = join(prepared.projectDir, "target", "compiled");
        await mkdir(compiled, { recursive: true });
        await mkdir(join(prepared.profilesDir, "outside-dir"), { recursive: true });
        await symlink(join(prepared.profilesDir, "outside-dir"), join(compiled, "nested"));
        await writeFile(join(compiled, "ok.sql"), "select 1");
        return prepared;
      },
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(linkedDir).toEqual({ error: "dbt produced a file compile will not read." });
    expect(projectCompileRefusal([{ path: "models/orders.sql", text: "select context from t" }])).toBeNull();
    expect(
      projectCompileRefusal([{ path: "models/orders.sql", text: "{{ config(materialized='view') }}" }]),
    ).toBeNull();
    for (const text of [
      "{{ context['name'] }}",
      "{{ name | attr('id') }}",
      "{{ attr('id') }}",
      "{% include 'models/orders.sql' %}",
      "{%- include 'models/orders.sql' %}",
      "{% import 'macros.sql' as macros %}",
      "{% from 'macros.sql' import name %}",
      "{% do 1 %}",
    ]) {
      expect(projectCompileRefusal([{ path: "models/orders.sql", text }])).toBe(
        "This project uses a dbt feature compile will not run.",
      );
    }
  });

  test("runs a process without a shell", async () => {
    const ok = await spawnCaptured(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(9000)); process.stderr.write('y'.repeat(9000));"],
      { cwd: tmpdir(), timeoutMs: 5000 },
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout.length).toBe(8000);
    expect(ok.stderr.length).toBe(8000);
    const planted = "MIDST_PLANTED_SECRET";
    const previous = process.env[planted];
    process.env[planted] = "super-secret-value";
    const seen = await spawnCaptured(
      process.execPath,
      ["-e", "process.stdout.write(process.env.MIDST_PLANTED_SECRET ?? 'absent')"],
      { cwd: tmpdir(), timeoutMs: 5000 },
    );
    if (previous === undefined) delete process.env[planted];
    else process.env[planted] = previous;
    expect(seen.stdout).toBe("absent");
    expect(compileEnvironment({ PATH: "/bin", [planted]: "nope" }).PATH).toBe("/bin");
    expect(compileEnvironment({ PATH: "/bin" })[planted]).toBeUndefined();
    expect(compileEnvironment({ NODE_ENV: "development" }).NODE_ENV).toBe("development");
    expect(compileEnvironment({ NODE_ENV: "test" }).NODE_ENV).toBe("test");
    expect(compileEnvironment({ NODE_ENV: "production" }).NODE_ENV).toBe("production");
    expect(compileEnvironment({ NODE_ENV: "staging" }).NODE_ENV).toBe("production");
    const failed = await spawnCaptured(process.execPath, ["-e", "process.exit(1)"], { cwd: tmpdir(), timeoutMs: 5000 });
    expect(failed.code).toBe(1);
    const missing = await spawnCaptured("dbt-not-installed-midst", [], { cwd: tmpdir(), timeoutMs: 1000 });
    expect(missing.stderr).toBe("dbt is not installed on this server.");
    const dir = await mkdtemp(join(tmpdir(), "midst-spawn-"));
    const file = join(dir, "not-a-binary");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "echo hi\n");
    const denied = await spawnCaptured(file, [], { cwd: dir, timeoutMs: 1000 });
    expect(denied.stderr).not.toBe("dbt is not installed on this server.");
    await rm(dir, { recursive: true, force: true });
    const timed = await spawnCaptured(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: tmpdir(),
      timeoutMs: 200,
    });
    expect(timed.code).not.toBe(0);
    const real = await compileProject(
      [{ path: "dbt_project.yml", text: "name: demo\n" }],
      "midst:\n  target: dev\n",
      {},
      2000,
    );
    expect("error" in real || "files" in real).toBe(true);
  });
});
