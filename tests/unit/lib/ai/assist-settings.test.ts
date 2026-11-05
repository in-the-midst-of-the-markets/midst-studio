import "../../../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assistModelSearches,
  DEFAULT_ASSIST_SETTINGS,
  normalizeModels,
  readAssistSettings,
  subscribeAssistSettings,
  writeAssistSettings,
} from "@/lib/ai/assist-settings";

afterEach(() => {
  localStorage.clear();
});

describe("normalizeModels", () => {
  test("keeps entries that have an id and fills a missing name", () => {
    expect(
      normalizeModels([
        { id: " openai/gpt-4o ", name: " GPT-4o " },
        { id: "plain" },
        { id: "   " },
        { id: 1 },
        null,
        { name: "no id" },
        { id: "named-blank", name: "  " },
        { id: "anthropic/claude-opus-5.5", name: "Opus", canonicalSlug: " anthropic/claude-opus-5.5-20260921 " },
        { id: "openai/same", name: "Same", canonicalSlug: "openai/same" },
        { id: "openai/blank", name: "Blank", canonicalSlug: "  " },
        { id: "openai/num", name: "Num", canonicalSlug: 4 },
      ]),
    ).toEqual([
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "plain", name: "plain" },
      { id: "named-blank", name: "named-blank" },
      { id: "anthropic/claude-opus-5.5", name: "Opus", canonicalSlug: "anthropic/claude-opus-5.5-20260921" },
      { id: "openai/same", name: "Same" },
      { id: "openai/blank", name: "Blank" },
      { id: "openai/num", name: "Num" },
    ]);
    expect(normalizeModels("no")).toEqual([]);
    expect(normalizeModels([{ id: "openai/gpt-4o", name: "GPT-4o", webSearch: true }])).toEqual([
      { id: "openai/gpt-4o", name: "GPT-4o", webSearch: true },
    ]);
    expect(normalizeModels([{ id: "plain", webSearch: false }])).toEqual([{ id: "plain", name: "plain" }]);
  });
});

describe("assistModelSearches", () => {
  const searchable = { id: "openai/gpt-4o", name: "GPT-4o", webSearch: true as const };
  const plain = { id: "local/small", name: "Small" };

  test("uses the catalog for the source that was chosen", () => {
    expect(assistModelSearches("openrouter", "openai/gpt-4o", [searchable], [])).toBe(true);
    expect(assistModelSearches("openrouter", "local/small", [plain], [searchable])).toBe(false);
    expect(assistModelSearches("gateway", "openai/gpt-4o", [], [searchable])).toBe(true);
    expect(assistModelSearches("gateway", "openai/gpt-4o", [searchable], [plain])).toBe(false);
    expect(assistModelSearches("fireworks", "openai/gpt-4o", [searchable], [searchable])).toBe(false);
  });
});

describe("assist settings storage", () => {
  test("returns the default when nothing is stored", () => {
    expect(readAssistSettings()).toEqual(DEFAULT_ASSIST_SETTINGS);
    expect(DEFAULT_ASSIST_SETTINGS.openRouterModel).toBe("deepseek/deepseek-v4.1-flash-1017");
  });

  test("moves a browser that saved the previous default onto DeepSeek V4.1 Flash", () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({ source: "openrouter", openRouterModel: "z-ai/glm-5.3", openRouterKey: "ork" }),
    );
    expect(readAssistSettings()).toMatchObject({
      openRouterModel: "deepseek/deepseek-v4.1-flash-1017",
      openRouterKey: "ork",
    });
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({ source: "openrouter", openRouterModel: "openai/gpt-4o" }),
    );
    expect(readAssistSettings().openRouterModel).toBe("openai/gpt-4o");
  });

  test("reads a saved Fireworks choice and ignores a bad record", () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({
        source: "fireworks",
        openRouterModel: "",
        fireworksModel: "accounts/acme/models/tuned",
        openRouterKey: "ork",
        fireworksKey: "fwk",
      }),
    );
    expect(readAssistSettings()).toMatchObject({
      source: "fireworks",
      openRouterModel: DEFAULT_ASSIST_SETTINGS.openRouterModel,
      fireworksModel: "accounts/acme/models/tuned",
      openRouterKey: "ork",
      fireworksKey: "fwk",
    });

    localStorage.setItem("libredb_ai_assist", "not json");
    expect(readAssistSettings()).toEqual(DEFAULT_ASSIST_SETTINGS);
    localStorage.setItem("libredb_ai_assist", "null");
    expect(readAssistSettings()).toEqual(DEFAULT_ASSIST_SETTINGS);
    localStorage.setItem("libredb_ai_assist", "[]");
    expect(readAssistSettings()).toEqual(DEFAULT_ASSIST_SETTINGS);
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ source: "elsewhere", openRouterModel: 4 }));
    expect(readAssistSettings().source).toBe("openrouter");
    expect(readAssistSettings().openRouterModel).toBe(DEFAULT_ASSIST_SETTINGS.openRouterModel);

    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({ source: "gateway", gatewayModel: "alibaba/qwen-3-14b", gatewayKey: "gw" }),
    );
    expect(readAssistSettings()).toMatchObject({
      source: "gateway",
      gatewayModel: "alibaba/qwen-3-14b",
      gatewayKey: "gw",
    });
  });

  test("caps oversized strings", () => {
    localStorage.setItem(
      "libredb_ai_assist",
      JSON.stringify({
        openRouterModel: "m".repeat(250),
        fireworksKey: "k".repeat(600),
        gatewayModel: "g".repeat(250),
        gatewayKey: "k".repeat(600),
      }),
    );
    const settings = readAssistSettings();
    expect(settings.openRouterModel).toHaveLength(200);
    expect(settings.fireworksKey).toHaveLength(500);
    expect(settings.gatewayModel).toHaveLength(200);
    expect(settings.gatewayKey).toHaveLength(500);
    expect(settings.historyMessages).toBe(DEFAULT_ASSIST_SETTINGS.historyMessages);
  });

  test("keeps a chosen number of earlier messages and replaces one outside 0 to 10", () => {
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ historyMessages: 0 }));
    expect(readAssistSettings().historyMessages).toBe(0);
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ historyMessages: 10 }));
    expect(readAssistSettings().historyMessages).toBe(10);
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ historyMessages: 11 }));
    expect(readAssistSettings().historyMessages).toBe(5);
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ historyMessages: -1 }));
    expect(readAssistSettings().historyMessages).toBe(5);
    localStorage.setItem("libredb_ai_assist", JSON.stringify({ historyMessages: 1.5 }));
    expect(readAssistSettings().historyMessages).toBe(5);
  });

  test("writes the choice and ignores a storage failure", () => {
    writeAssistSettings({ ...DEFAULT_ASSIST_SETTINGS, fireworksModel: "accounts/acme/models/tuned" });
    expect(readAssistSettings().fireworksModel).toBe("accounts/acme/models/tuned");

    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("full");
    };
    expect(() => writeAssistSettings(DEFAULT_ASSIST_SETTINGS)).not.toThrow();
    localStorage.setItem = original;
  });

  test("keeps one snapshot and tells a subscriber when the choice changes", () => {
    let calls = 0;
    const stop = subscribeAssistSettings(() => {
      calls += 1;
    });
    writeAssistSettings({ ...DEFAULT_ASSIST_SETTINGS, fireworksModel: "accounts/acme/models/tuned" });
    expect(calls).toBe(1);
    expect(readAssistSettings()).toBe(readAssistSettings());
    stop();
    writeAssistSettings(DEFAULT_ASSIST_SETTINGS);
    expect(calls).toBe(1);
  });
});
