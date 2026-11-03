import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  RANKING_CATEGORIES,
  RANKINGS_MAX_AGE_MS,
  rankingsFilePath,
  refreshOpenRouterRankings,
  type OpenRouterRankingsFile,
} from "@/lib/ai/openrouter-rankings";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalPath = process.env.OPENROUTER_RANKINGS_PATH;
const originalSqlite = process.env.STORAGE_SQLITE_PATH;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function filePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rankings-"));
  return path.join(dir, "nested", "openrouter-rankings.json");
}

function snapshot(fetchedAt: string): OpenRouterRankingsFile {
  return {
    fetchedAt,
    citation: "Source: OpenRouter (openrouter.ai/rankings), as of saved.",
    categories: RANKING_CATEGORIES.map((category) => ({
      category,
      asOf: "saved",
      models: [{ id: "openai/gpt-4o", totalTokens: "1" }],
    })),
  };
}

function writeSnapshot(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

function week(category: string, extras: unknown[] = [], meta: unknown = { as_of: "2026-11-03T00:00:00.000Z" }) {
  return {
    data: [
      { date: "2026-10-26", model_permaslug: "openai/old", total_tokens: "1000" },
      { date: "2026-11-02", model_permaslug: "other", total_tokens: "9" },
      { date: "2026-11-02", model_permaslug: " openai/gpt-4o ", total_tokens: "10" },
      { date: "2026-11-02", model_permaslug: "anthropic/claude", total_tokens: "10" },
      { date: "2026-11-02", model_permaslug: "google/gemini", total_tokens: "2" },
      ...extras,
    ],
    meta,
    category,
  };
}

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalPath === undefined) delete process.env.OPENROUTER_RANKINGS_PATH;
  else process.env.OPENROUTER_RANKINGS_PATH = originalPath;
  if (originalSqlite === undefined) delete process.env.STORAGE_SQLITE_PATH;
  else process.env.STORAGE_SQLITE_PATH = originalSqlite;
});

describe("rankingsFilePath", () => {
  test("uses the override, then the storage directory", () => {
    process.env.OPENROUTER_RANKINGS_PATH = "  /tmp/rankings.json  ";
    expect(rankingsFilePath()).toBe("/tmp/rankings.json");
    process.env.OPENROUTER_RANKINGS_PATH = "   ";
    process.env.STORAGE_SQLITE_PATH = "/var/studio/libredb-storage.db";
    expect(rankingsFilePath()).toBe("/var/studio/openrouter-rankings.json");
    delete process.env.OPENROUTER_RANKINGS_PATH;
    expect(rankingsFilePath()).toBe("/var/studio/openrouter-rankings.json");
  });
});

describe("refreshOpenRouterRankings", () => {
  test("serves a copy from the last day without calling OpenRouter", async () => {
    const target = filePath();
    const saved = snapshot(new Date().toISOString());
    writeSnapshot(target, saved);
    let calls = 0;
    const served = await refreshOpenRouterRankings({
      filePath: target,
      key: "server-secret",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    expect(served).toEqual(saved);
    expect(calls).toBe(0);
  });

  test("keeps a stale copy when the server has no key", async () => {
    const target = filePath();
    const saved = snapshot("2020-01-01T00:00:00.000Z");
    writeSnapshot(target, saved);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({});
    };
    expect(await refreshOpenRouterRankings({ filePath: target, key: null, fetchImpl })).toEqual(saved);
    expect(await refreshOpenRouterRankings({ filePath: target, key: "   ", fetchImpl })).toEqual(saved);
    delete process.env.OPENROUTER_API_KEY;
    expect(await refreshOpenRouterRankings({ filePath: target, fetchImpl })).toEqual(saved);
    expect(calls).toBe(0);
    expect(
      await refreshOpenRouterRankings({ filePath: path.join(target, "missing"), key: null, fetchImpl }),
    ).toBeNull();
  });

  test("replaces a stale copy after every domain succeeds", async () => {
    const target = filePath();
    writeSnapshot(target, snapshot("2020-01-01T00:00:00.000Z"));
    const seen: string[] = [];
    const now = Date.parse("2026-11-03T12:00:00.000Z");
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-secret");
      expect(new Headers(init?.headers).get("X-Title")).toBe("Midst");
      const category = new URL(url).searchParams.get("category");
      if (category === "programming") return jsonResponse(week(category, [], null));
      if (category === "roleplay") return jsonResponse(week(category, [], { as_of: 4 }));
      if (category === "marketing") return jsonResponse(week(category, [], undefined));
      return jsonResponse(
        week(category ?? "", [
          null,
          "nope",
          { date: "2026-11-2", model_permaslug: "openai/bad-date", total_tokens: "8" },
          { date: "2026-11-02", model_permaslug: " ", total_tokens: "8" },
          { date: "2026-11-02", model_permaslug: "openai/words", total_tokens: "eight" },
          { date: "2026-11-02", model_permaslug: "openai/number", total_tokens: 8 },
          { date: "2026-11-02", total_tokens: "8" },
        ]),
      );
    };
    const saved = await refreshOpenRouterRankings({
      filePath: target,
      key: "  server-secret  ",
      now: () => now,
      fetchImpl,
    });
    expect(seen).toHaveLength(RANKING_CATEGORIES.length);
    expect(seen.some((url) => url.includes("period=week"))).toBe(true);
    expect(seen.some((url) => url.includes("category=marketing%2Fseo"))).toBe(true);
    expect(saved?.fetchedAt).toBe("2026-11-03T12:00:00.000Z");
    expect(saved?.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03T00:00:00.000Z.");
    expect(saved?.categories.find((category) => category.category === "programming")?.asOf).toBe("");
    expect(saved?.categories[0]?.models.map((model) => model.id)).toEqual([
      "anthropic/claude",
      "openai/gpt-4o",
      "google/gemini",
    ]);
    const text = fs.readFileSync(target, "utf8");
    expect(text).not.toContain("server-secret");
    expect(text).not.toContain("openai/old");

    let again = 0;
    const second = await refreshOpenRouterRankings({
      filePath: target,
      key: "server-secret",
      now: () => now + 1_000,
      fetchImpl: async () => {
        again += 1;
        return jsonResponse({}, 500);
      },
    });
    expect(second?.fetchedAt).toBe(saved?.fetchedAt);
    expect(again).toBe(0);
  });

  test("keeps the previous file when a domain fails or the disk rejects the write", async () => {
    const target = filePath();
    const saved = snapshot("2020-01-01T00:00:00.000Z");
    writeSnapshot(target, saved);
    const failures: Array<(input: string) => Response | Promise<Response>> = [
      () => jsonResponse({}, 503),
      () => {
        const response = jsonResponse({});
        response.json = () => Promise.reject(new Error("bad json"));
        return response;
      },
      () => jsonResponse(null),
      () => jsonResponse({ data: {} }),
      () => jsonResponse({ data: [{ date: "2026-11-02", model_permaslug: "other", total_tokens: "1" }] }),
      () => {
        throw new Error("offline");
      },
    ];
    for (const fetchImpl of failures) {
      const served = await refreshOpenRouterRankings({
        filePath: target,
        key: "server-secret",
        now: () => Date.parse("2026-11-03T00:00:00.000Z"),
        fetchImpl,
      });
      expect(served).toEqual(saved);
      expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(saved));
    }

    const missing = path.join(path.dirname(target), "absent.json");
    expect(
      await refreshOpenRouterRankings({
        filePath: missing,
        key: "server-secret",
        fetchImpl: async () => jsonResponse({}, 503),
      }),
    ).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);

    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV");
    });
    const kept = await refreshOpenRouterRankings({
      filePath: target,
      key: "server-secret",
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: async () => jsonResponse(week("programming")),
    });
    expect(kept).toEqual(saved);
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp"))).toBe(false);
    rename.mockRestore();

    const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const still = await refreshOpenRouterRankings({
      filePath: target,
      key: "server-secret",
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: async () => jsonResponse(week("programming")),
    });
    expect(still).toEqual(saved);
    write.mockRestore();
    expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(saved));
  });

  test("refetches an unreadable file and shares one pull", async () => {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{");
    expect(await refreshOpenRouterRankings({ filePath: target, key: null })).toBeNull();
    writeSnapshot(`${target}.shape`, {
      fetchedAt: 1,
      citation: "x",
      categories: [{ category: "programming", asOf: "", models: [{ id: "", totalTokens: "1" }] }],
    });
    expect(await refreshOpenRouterRankings({ filePath: `${target}.shape`, key: null })).toBeNull();
    const directory = path.dirname(target);
    expect(await refreshOpenRouterRankings({ filePath: directory, key: null })).toBeNull();

    const boundary = filePath();
    const fetchedAt = new Date(Date.parse("2026-11-03T00:00:00.000Z") - RANKINGS_MAX_AGE_MS).toISOString();
    writeSnapshot(boundary, snapshot(fetchedAt));
    let calls = 0;
    await refreshOpenRouterRankings({
      filePath: boundary,
      key: "server-secret",
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(week("programming", [], { as_of: "" }));
      },
    });
    expect(calls).toBe(RANKING_CATEGORIES.length);

    writeSnapshot(target, snapshot("not-a-date"));
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = async () => {
      started += 1;
      await gate;
      return jsonResponse(week("programming", [], {}));
    };
    const first = refreshOpenRouterRankings({ filePath: target, key: "server-secret", fetchImpl });
    const second = refreshOpenRouterRankings({
      filePath: target,
      key: "other",
      fetchImpl: async () => {
        started += 100;
        return jsonResponse({}, 500);
      },
    });
    expect(started).toBe(RANKING_CATEGORIES.length);
    release?.();
    const [saved, shared] = await Promise.all([first, second]);
    expect(saved?.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of the latest weekly rankings.");
    expect(shared).toEqual(saved);
    expect(started).toBe(RANKING_CATEGORIES.length);
  });
});
