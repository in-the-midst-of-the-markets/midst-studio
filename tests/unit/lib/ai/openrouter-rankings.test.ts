import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  OPENROUTER_DOMAIN_OPTIONS_URL,
  OPENROUTER_DOMAIN_SHARE_URL,
  OPENROUTER_WEEKLY_MODELS_URL,
  RANKINGS_FORMAT,
  RANKINGS_MAX_AGE_MS,
  rankingsFilePath,
  refreshOpenRouterRankings,
  type OpenRouterRankingsFile,
} from "@/lib/ai/openrouter-rankings";

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
    version: RANKINGS_FORMAT,
    fetchedAt,
    citation: "Source: OpenRouter (openrouter.ai/rankings), as of saved.",
    categories: [
      {
        category: "all",
        label: "All",
        asOf: "saved",
        models: [{ id: "openai/gpt-4o", totalTokens: "1" }],
      },
      {
        category: "finance",
        label: "Finance",
        asOf: "saved",
        models: [{ id: "anthropic/claude-opus-5.5-20260921", totalTokens: "1" }],
      },
    ],
  };
}

function writeSnapshot(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

function optionsBody(): unknown {
  return {
    data: {
      dimensions: [
        null,
        { note: "missing" },
        { dimension: "language", categories: [{ value: "english", label: "English" }] },
        {
          dimension: "domain",
          categories: [
            null,
            { value: 4, label: "Number" },
            { value: "  ", label: "Blank" },
            { value: " all ", label: "All" },
            { value: "finance", label: " Finance " },
            { value: "finance", label: "Again" },
            { value: "///", label: "" },
            { label: "No value" },
            { value: "health_wellness" },
          ],
        },
      ],
    },
  };
}

function shareBody(category: string): unknown {
  const latest =
    category === "finance"
      ? {
          " anthropic/claude-opus-5.5-20260921 ": 0.1522,
          "anthropic/claude-sonnet-5.5-20260928": 0.0919,
          "z-ai/glm-5.3-flash-20260826": 0.0296,
          "openai/tie": 0.0296,
          Others: 0.4743,
          " ": 0.2,
          "not-a-share": "0.5",
          tiny: 0.0000004,
          negative: -0.2,
          infinite: Number.POSITIVE_INFINITY,
        }
      : category === "health_wellness"
        ? { "openai/gpt-4o": 0.4, others: 0.6 }
        : { "openai/kept": 0.1 };
  return {
    data: {
      marketShareData: [
        null,
        { x: "2026-11-2", ys: { "openai/bad-date": 0.9 } },
        { x: "2026-11-02", ys: ["nope"] },
        { x: "2026-10-26", ys: { "openai/old": 0.99 } },
        { x: "2026-11-02", ys: { "openai/replaced": 0.01 } },
        { x: "2026-11-02", ys: latest },
        { note: "missing" },
      ],
    },
  };
}

function weeklyBody(): unknown {
  return {
    data: [
      null,
      "nope",
      { date: "not-a-day", model_permaslug: "openai/undated", rankingMetricValue: 4 },
      { date: "2026-11-01", model_permaslug: "other", rankingMetricValue: 99 },
      { date: "2026-11-02", model_permaslug: "others", variant_permaslug: "  ", rankingMetricValue: "8" },
      {
        date: "2026-11-03 00:00:00",
        model_permaslug: "openai/gpt-4o",
        variant_permaslug: "openai/gpt-4o",
        rankingMetricValue: 10,
      },
      {
        date: "2026-11-02",
        model_permaslug: "openai/gpt-4o",
        variant_permaslug: "openai/gpt-4o",
        rankingMetricValue: "5",
      },
      {
        date: "2026-11-03 00:00:00",
        model_permaslug: "anthropic/claude-opus-5.5-20260921",
        variant_permaslug: "anthropic/claude-opus-5.5-20260921:batch",
        rankingMetricValue: 3,
      },
      { date: "2026-11-03 00:00:00", model_permaslug: "openai/zero", rankingMetricValue: 0 },
      { date: "2026-11-03 00:00:00", model_permaslug: "openai/float", rankingMetricValue: 1.5 },
      { date: "2026-11-03 00:00:00", model_permaslug: "openai/missing" },
      { date: 4, rankingMetricValue: 9 },
    ],
  };
}

function chartFetch(
  extra?: (url: string) => Response | null,
): (input: RequestInfo | URL, init?: RequestInit) => Response {
  return (input, init) => {
    const url = String(input);
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    expect(new Headers(init?.headers).get("X-Title")).toBe("Midst");
    const replaced = extra?.(url);
    if (replaced) return replaced;
    if (url === OPENROUTER_DOMAIN_OPTIONS_URL) return jsonResponse(optionsBody());
    if (url.startsWith(OPENROUTER_DOMAIN_SHARE_URL)) {
      return jsonResponse(shareBody(new URL(url).searchParams.get("category") ?? ""));
    }
    if (url === OPENROUTER_WEEKLY_MODELS_URL) return jsonResponse(weeklyBody());
    return jsonResponse({}, 404);
  };
}

afterEach(() => {
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
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    expect(served).toEqual(saved);
    expect(calls).toBe(0);
  });

  test("replaces a stale copy with the latest domain week", async () => {
    const target = filePath();
    writeSnapshot(target, { fetchedAt: "2020-01-01T00:00:00.000Z", citation: "old", categories: [] });
    const seen: string[] = [];
    const now = Date.parse("2026-11-03T12:00:00.000Z");
    const saved = await refreshOpenRouterRankings({
      filePath: target,
      now: () => now,
      fetchImpl: (input, init) => {
        seen.push(String(input));
        return chartFetch()(input, init);
      },
    });
    expect(seen).toEqual([
      OPENROUTER_DOMAIN_OPTIONS_URL,
      `${OPENROUTER_DOMAIN_SHARE_URL}?routeSegment=text&dimension=domain&category=finance`,
      `${OPENROUTER_DOMAIN_SHARE_URL}?routeSegment=text&dimension=domain&category=${encodeURIComponent("///")}`,
      `${OPENROUTER_DOMAIN_SHARE_URL}?routeSegment=text&dimension=domain&category=health_wellness`,
      OPENROUTER_WEEKLY_MODELS_URL,
    ]);
    expect(saved?.fetchedAt).toBe("2026-11-03T12:00:00.000Z");
    expect(saved?.version).toBe(RANKINGS_FORMAT);
    expect(saved?.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03.");
    expect(saved?.categories.map((category) => category.category)).toEqual([
      "all",
      "finance",
      "///",
      "health_wellness",
    ]);
    expect(saved?.categories.map((category) => category.label)).toEqual(["All", "Finance", "///", "Health Wellness"]);
    const finance = saved?.categories.find((category) => category.category === "finance");
    expect(finance?.asOf).toBe("2026-11-02");
    expect(finance?.models.map((model) => [model.id, model.totalTokens])).toEqual([
      ["anthropic/claude-opus-5.5-20260921", "152200"],
      ["anthropic/claude-sonnet-5.5-20260928", "91900"],
      ["openai/tie", "29600"],
      ["z-ai/glm-5.3-flash-20260826", "29600"],
    ]);
    expect(saved?.categories[0]?.models.map((model) => [model.id, model.totalTokens])).toEqual([
      ["openai/gpt-4o", "15"],
      ["openai/undated", "4"],
      ["anthropic/claude-opus-5.5-20260921:batch", "3"],
    ]);
    const text = fs.readFileSync(target, "utf8");
    expect(text).toContain("anthropic/claude-opus-5.5-20260921");
    expect(text).not.toContain("openai/old");

    let again = 0;
    const second = await refreshOpenRouterRankings({
      filePath: target,
      now: () => now + 1_000,
      fetchImpl: async () => {
        again += 1;
        return jsonResponse({}, 500);
      },
    });
    expect(second?.fetchedAt).toBe(saved?.fetchedAt);
    expect(again).toBe(0);
  });

  test("keeps the previous file when a chart fails or the disk rejects the write", async () => {
    const target = filePath();
    const saved = snapshot("2020-01-01T00:00:00.000Z");
    writeSnapshot(target, saved);
    const failures: Array<(input: string, init?: RequestInit) => Response | Promise<Response>> = [
      () => jsonResponse({}, 503),
      () => {
        const response = jsonResponse({});
        response.json = () => Promise.reject(new Error("bad json"));
        return response;
      },
      () => jsonResponse(null),
      () => jsonResponse({ data: {} }),
      () => jsonResponse({ data: { dimensions: [{ dimension: "domain", categories: "nope" }] } }),
      () => jsonResponse({ data: { dimensions: [{ dimension: "domain", categories: [{ value: "all" }] }] } }),
      () => jsonResponse({ data: { dimensions: [{ dimension: "language", categories: [] }] } }),
      (input, init) => {
        if (String(input) === OPENROUTER_DOMAIN_OPTIONS_URL) return jsonResponse(optionsBody());
        if (String(input).startsWith(OPENROUTER_DOMAIN_SHARE_URL)) return jsonResponse({ data: null });
        return chartFetch()(input, init);
      },
      (input) => {
        if (String(input) === OPENROUTER_DOMAIN_OPTIONS_URL) return jsonResponse(optionsBody());
        return jsonResponse({}, 503);
      },
      (input, init) => {
        if (String(input) === OPENROUTER_DOMAIN_OPTIONS_URL) return jsonResponse(optionsBody());
        if (String(input).startsWith(OPENROUTER_DOMAIN_SHARE_URL)) {
          return jsonResponse({ data: { marketShareData: [] } });
        }
        return chartFetch()(input, init);
      },
      (input, init) => {
        if (String(input) === OPENROUTER_WEEKLY_MODELS_URL) return jsonResponse({ data: [] });
        return chartFetch()(input, init);
      },
      () => {
        throw new Error("offline");
      },
    ];
    for (const fetchImpl of failures) {
      const served = await refreshOpenRouterRankings({
        filePath: target,
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
        fetchImpl: async () => jsonResponse({}, 503),
      }),
    ).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);

    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV");
    });
    const kept = await refreshOpenRouterRankings({
      filePath: target,
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: chartFetch(),
    });
    expect(kept).toEqual(saved);
    expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp"))).toBe(false);
    rename.mockRestore();

    const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const still = await refreshOpenRouterRankings({
      filePath: target,
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: chartFetch(),
    });
    expect(still).toEqual(saved);
    write.mockRestore();
    expect(fs.readFileSync(target, "utf8")).toBe(JSON.stringify(saved));
  });

  test("refetches an unreadable file and shares one pull", async () => {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{");
    expect(
      await refreshOpenRouterRankings({ filePath: target, fetchImpl: async () => jsonResponse({}, 503) }),
    ).toBeNull();
    writeSnapshot(`${target}.shape`, {
      version: 1,
      fetchedAt: "2026-11-03T00:00:00.000Z",
      citation: "x",
      categories: [{ category: "finance", asOf: "", models: [{ id: "openai/gpt-4o", totalTokens: "1" }] }],
    });
    expect(
      await refreshOpenRouterRankings({ filePath: `${target}.shape`, fetchImpl: async () => jsonResponse({}, 503) }),
    ).toBeNull();
    expect(
      await refreshOpenRouterRankings({ filePath: path.dirname(target), fetchImpl: async () => jsonResponse({}, 503) }),
    ).toBeNull();

    const blank = filePath();
    writeSnapshot(blank, {
      version: RANKINGS_FORMAT,
      fetchedAt: "2026-11-03T00:00:00.000Z",
      citation: "",
      categories: [
        { category: " ", label: "Blank", asOf: "", models: [{ id: "openai/gpt-4o", totalTokens: "1" }] },
        { category: "finance", label: " ", asOf: "", models: [{ id: " ", totalTokens: "1" }] },
        { category: "legal", label: "Legal", asOf: "", models: [] },
      ],
    });
    expect(
      await refreshOpenRouterRankings({ filePath: blank, fetchImpl: async () => jsonResponse({}, 503) }),
    ).toBeNull();

    const boundary = filePath();
    const fetchedAt = new Date(Date.parse("2026-11-03T00:00:00.000Z") - RANKINGS_MAX_AGE_MS).toISOString();
    writeSnapshot(boundary, snapshot(fetchedAt));
    let calls = 0;
    const cited = await refreshOpenRouterRankings({
      filePath: boundary,
      now: () => Date.parse("2026-11-03T00:00:00.000Z"),
      fetchImpl: (input, init) => {
        calls += 1;
        if (String(input) === OPENROUTER_WEEKLY_MODELS_URL) {
          return jsonResponse({ data: [{ model_permaslug: "openai/gpt-4o", rankingMetricValue: 2 }] });
        }
        return chartFetch()(input, init);
      },
    });
    expect(calls).toBe(5);
    expect(cited?.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-02.");
    expect(cited?.categories[0]?.asOf).toBe("");

    writeSnapshot(target, snapshot("not-a-date"));
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      started += 1;
      await gate;
      return chartFetch()(input, init);
    };
    const first = refreshOpenRouterRankings({ filePath: target, fetchImpl });
    const second = refreshOpenRouterRankings({
      filePath: target,
      fetchImpl: async () => {
        started += 100;
        return jsonResponse({}, 500);
      },
    });
    expect(started).toBe(1);
    release?.();
    const [saved, shared] = await Promise.all([first, second]);
    expect(saved?.categories.find((category) => category.category === "finance")?.models[0]?.id).toBe(
      "anthropic/claude-opus-5.5-20260921",
    );
    expect(shared).toEqual(saved);
    expect(started).toBe(5);
  });
});
