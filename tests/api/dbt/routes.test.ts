import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);
const mockCompile = mock(
  async (): Promise<{ files: Record<string, string> } | { error: string }> => ({
    files: { "models/orders.sql": "select 1" },
  }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const session = await mockGetSession();
    return session ? { kind: "authenticated", session } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code?: string,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    SeedConnectionError,
    resolveConnection: mock(async (body: { connectionId?: string }) => {
      if (body.connectionId === "seed:pg") {
        return {
          id: "seed:pg",
          name: "Pg",
          type: "postgres",
          host: "db.example",
          user: "app",
          password: "s3cret-password",
          database: "app",
          createdAt: new Date(),
        };
      }
      if (body.connectionId === "seed:redis") {
        return { id: "seed:redis", name: "Redis", type: "redis", host: "db.example", createdAt: new Date() };
      }
      throw new SeedConnectionError("Invalid connection ID format", 400);
    }),
  };
});

mock.module("@/lib/dbt/runner", () => ({ compileProject: mockCompile }));

const { POST: openProject } = await import("@/app/api/dbt/project/route");
const { POST: compileProject } = await import("@/app/api/dbt/compile/route");

const TOKEN = "ghp_testtokenvalue";
const TREE = {
  "dbt_project.yml": "name: analytics\n",
  "models/orders.sql": "select * from {{ ref('stg_orders') }}\n",
};

function githubFetch(status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (status !== 200 && !url.includes("/contents/")) return new Response("no", { status });
    if (url.includes("/git/trees/")) {
      return Response.json({ tree: Object.keys(TREE).map((path) => ({ path, type: "blob" })) });
    }
    if (url.includes("/contents/")) {
      const path = decodeURIComponent(url.split("/contents/")[1]?.split("?")[0] ?? "");
      const text = TREE[path as keyof typeof TREE];
      return text === undefined ? new Response("missing", { status: 404 }) : new Response(text);
    }
    return Response.json({ default_branch: "main" });
  }) as typeof fetch;
}

function request(url: string, body: unknown): Request {
  return createMockRequest(url, { method: "POST", body });
}

describe("dbt routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockResolvedValue({ role: "admin", username: "admin" });
    mockCompile.mockResolvedValue({ files: { "models/orders.sql": "select 1" } });
    globalThis.fetch = githubFetch();
  });

  test("requires a session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await openProject(request("/api/dbt/project", { repo: "acme/analytics" }));
    expect(response.status).toBe(401);
    const compiled = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", connectionId: "seed:pg" }),
    );
    expect(compiled.status).toBe(401);
  });

  test("refuses a body that is not an object", async () => {
    const response = await openProject(
      new Request("http://localhost:3000/api/dbt/project", {
        method: "POST",
        body: "[]",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe("Invalid request body");
    const compiled = await compileProject(
      new Request("http://localhost:3000/api/dbt/compile", {
        method: "POST",
        body: "null",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(compiled.status).toBe(400);
  });

  test("opens a project without returning the token or the password", async () => {
    const response = await openProject(
      request("/api/dbt/project", { repo: "acme/analytics", token: TOKEN, connectionId: "seed:pg" }),
    );
    expect(response.status).toBe(200);
    const body = await parseResponseJSON<{ name: string; profile: { ready: boolean }; models: { name: string }[] }>(
      response,
    );
    const text = JSON.stringify(body);
    expect(body.name).toBe("analytics");
    expect(body.profile.ready).toBe(true);
    expect(body.models.map((model) => model.name)).toContain("orders");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("s3cret-password");
  });

  test("opens a project with no connection and reports a profile that cannot compile", async () => {
    const alone = await openProject(request("/api/dbt/project", { repo: "acme/analytics" }));
    expect((await parseResponseJSON<{ profile: { ready: boolean; reason: string } }>(alone)).profile.reason).toContain(
      "Choose a connection",
    );
    const redis = await openProject(
      request("/api/dbt/project", { repo: "acme/analytics", connectionId: "seed:redis" }),
    );
    expect((await parseResponseJSON<{ profile: { reason: string } }>(redis)).profile.reason).toContain("no dbt target");
    const bad = await openProject(request("/api/dbt/project", { repo: "not a repo" }));
    expect(bad.status).toBe(400);
    globalThis.fetch = githubFetch(404);
    const missing = await openProject(request("/api/dbt/project", { repo: "acme/analytics" }));
    expect(missing.status).toBe(400);
  });

  test("keeps a connection failure's own status", async () => {
    const response = await openProject(
      request("/api/dbt/project", { repo: "acme/analytics", connectionId: "missing" }),
    );
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Invalid connection ID");
  });

  test("compiles with the saved connection", async () => {
    const response = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", token: TOKEN, connectionId: "seed:pg" }),
    );
    expect(response.status).toBe(200);
    const body = await parseResponseJSON<{ ref: string; files: Record<string, string> }>(response);
    expect(body.files["models/orders.sql"]).toBe("select 1");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("s3cret-password");
  });

  test("reports a compile that cannot run", async () => {
    expect((await compileProject(request("/api/dbt/compile", { repo: "acme/analytics" }))).status).toBe(400);
    const redis = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", connectionId: "seed:redis" }),
    );
    expect((await parseResponseJSON<{ error: string }>(redis)).error).toContain("no dbt target");
    globalThis.fetch = githubFetch(404);
    const missing = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", connectionId: "seed:pg" }),
    );
    expect(missing.status).toBe(400);
    globalThis.fetch = githubFetch();
    mockCompile.mockResolvedValue({ error: "dbt is not installed on this server." });
    const absent = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", connectionId: "seed:pg" }),
    );
    expect((await parseResponseJSON<{ error: string }>(absent)).error).toBe("dbt is not installed on this server.");
    const failed = await compileProject(
      request("/api/dbt/compile", { repo: "acme/analytics", connectionId: "missing" }),
    );
    expect((await parseResponseJSON<{ error: string }>(failed)).error).toContain("Invalid connection ID");
  });
});
