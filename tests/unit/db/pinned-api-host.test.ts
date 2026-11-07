import { describe, expect, test } from "bun:test";
import { assignOwnField, ownEntries, pinnedApiHost, readApiAnswer, redactSecret } from "@/lib/db/http/pinned-api-host";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";

describe("pinnedApiHost", () => {
  test("keeps a host under the vendor and refuses everything else without repeating it", () => {
    expect(pinnedApiHost(undefined, "hubapi.com", "api.hubapi.com", "hubspot")).toBe("api.hubapi.com");
    expect(pinnedApiHost("  ", "hubapi.com", "api.hubapi.com", "hubspot")).toBe("api.hubapi.com");
    expect(pinnedApiHost("HTTP://API.HUBAPI.COM.", "hubapi.com", "api.hubapi.com", "hubspot")).toBe("api.hubapi.com");
    expect(() => pinnedApiHost("hubapi.com", "hubapi.com", "api.hubapi.com", "hubspot")).toThrow(DatabaseConfigError);
    for (const host of ["https://", "http://[", "ftp://api.hubapi.com", "https://user:pw@api.hubapi.com"]) {
      expect(() => pinnedApiHost(host, "hubapi.com", "api.hubapi.com", "hubspot")).toThrow(DatabaseConfigError);
      try {
        pinnedApiHost(host, "hubapi.com", "api.hubapi.com", "hubspot");
      } catch (error) {
        expect(error instanceof Error ? error.message : "").not.toContain(host);
      }
    }
  });
});

describe("redactSecret", () => {
  test("hides a long token and leaves a short one, and stops after 500 characters", () => {
    expect(redactSecret("bad pat", "pat")).toBe("bad pat");
    expect(redactSecret("bad pat-secret", "pat-secret")).toBe("bad ••••");
    expect(redactSecret("no token here", "pat-secret")).toBe("no token here");
    const long = `${"x".repeat(600)}pat-secret`;
    expect(redactSecret(long, "pat-secret").endsWith("…")).toBe(true);
    expect(redactSecret(long, "pat-secret")).not.toContain("pat-secret");
  });
});

describe("readApiAnswer", () => {
  test("returns a small body, refuses a redirect, and stops a body past 2 MB", async () => {
    expect(await readApiAnswer(new Response("ok", { status: 200 }), "hubspot", "HubSpot")).toBe("ok");
    const redirected = new Response(null, { status: 302 });
    await expect(readApiAnswer(redirected, "hubspot", "HubSpot")).rejects.toBeInstanceOf(ConnectionError);
    const empty = { status: 301, body: null } as Response;
    await expect(readApiAnswer(empty, "airtable", "Airtable")).rejects.toThrow(/does not follow/);
    const huge = new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });
    await expect(readApiAnswer(huge, "hubspot", "HubSpot")).rejects.toBeInstanceOf(QueryError);
  });

  test("lets a stream failure through", async () => {
    const stream = new ReadableStream({
      pull() {
        throw new Error("broken stream");
      },
    });
    await expect(readApiAnswer(new Response(stream), "hubspot", "HubSpot")).rejects.toThrow(/broken stream/);
  });
});

describe("own fields", () => {
  test("skips a name that would change the object", () => {
    const row: Record<string, unknown> = {};
    assignOwnField(row, "email", "a@b.c");
    assignOwnField(row, "__proto__", { polluted: true });
    assignOwnField(row, "constructor", 1);
    assignOwnField(row, "prototype", 1);
    expect(row).toEqual({ email: "a@b.c" });
    expect(
      ownEntries([
        ["name", "Ada"],
        ["__proto__", "no"],
      ]),
    ).toEqual({ name: "Ada" });
  });
});
