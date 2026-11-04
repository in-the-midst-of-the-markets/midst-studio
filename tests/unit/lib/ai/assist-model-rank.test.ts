import { describe, expect, test } from "bun:test";
import { rankAssistModels, rankingDomains, readAssistRankings } from "@/lib/ai/assist-model-rank";
import type { AssistModelOption } from "@/lib/ai/assist-settings";

const catalog: AssistModelOption[] = [
  { id: "openai/gpt-4o", name: "GPT-4o" },
  { id: "anthropic/claude", name: "Claude" },
  { id: "anthropic/claude", name: "Claude again" },
  { id: "mistral/small", name: "Mistral" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek" },
  { id: "z-ai/same", name: "Same" },
  { id: "z-ai/same-b", name: "Same" },
  { id: "extra/big", name: "Big" },
  { id: "local/widget", name: "Widget" },
];

describe("readAssistRankings", () => {
  test("keeps a citation and the rows that name a model", () => {
    const read = readAssistRankings({
      citation: "  Source: OpenRouter.  ",
      categories: [
        null,
        { category: "  ", models: [{ id: "openai/gpt-4o", totalTokens: "1" }] },
        { category: 4, models: [] },
        { note: "missing" },
        { category: "programming", models: "nope" },
        {
          category: "programming",
          models: [
            null,
            { id: "  ", totalTokens: "1" },
            { id: "openai/gpt-4o", totalTokens: "nope" },
            { totalTokens: "1" },
            { id: "openai/gpt-4o", totalTokens: "80" },
          ],
        },
        { category: "empty", models: [{ id: "x", totalTokens: "" }] },
      ],
    });
    expect(read).toEqual({
      citation: "Source: OpenRouter.",
      categories: [{ category: "programming", models: [{ id: "openai/gpt-4o", totalTokens: "80" }] }],
    });
  });

  test("drops a payload that is not a ranking", () => {
    expect(readAssistRankings(null)).toBeNull();
    expect(readAssistRankings("rankings")).toBeNull();
    expect(readAssistRankings({ citation: "Source." })).toBeNull();
    expect(readAssistRankings({ categories: {} })).toBeNull();
    expect(readAssistRankings({ citation: 4, categories: [] })).toBeNull();
    expect(readAssistRankings({ citation: "Source.", categories: [null] })).toEqual({
      citation: "Source.",
      categories: [],
    });
    expect(
      readAssistRankings({ categories: [{ category: "widgets", models: [{ id: "a", totalTokens: "1" }] }] }),
    ).toEqual({
      citation: "",
      categories: [{ category: "widgets", models: [{ id: "a", totalTokens: "1" }] }],
    });
  });
});

describe("rankingDomains", () => {
  test("lists subjects by label and skips overall use", () => {
    expect(rankingDomains(null)).toEqual([]);
    const rankings = readAssistRankings({
      citation: "",
      categories: [
        { category: "science", models: [{ id: "openai/gpt-4o", totalTokens: "1" }] },
        { category: "all", models: [{ id: "openai/gpt-4o", totalTokens: "9" }] },
        { category: "legal", models: [{ id: "anthropic/claude", totalTokens: "1" }] },
        { category: "widgets", models: [{ id: "local/widget", totalTokens: "1" }] },
      ],
    });
    expect(rankingDomains(rankings)).toEqual([
      { id: "legal", label: "Legal" },
      { id: "science", label: "Science" },
      { id: "widgets", label: "Widgets" },
    ]);
    expect(
      rankingDomains(
        readAssistRankings({
          citation: "Source.",
          categories: [
            { category: "finance", label: "  Markets  ", models: [{ id: "a", totalTokens: "1" }] },
            { category: "health_wellness", label: "   ", models: [{ id: "a", totalTokens: "1" }] },
            { category: "customer_support", models: [{ id: "a", totalTokens: "1" }] },
            { category: "///", models: [{ id: "a", totalTokens: "1" }] },
          ],
        }),
      ),
    ).toEqual([
      { id: "///", label: "///" },
      { id: "customer_support", label: "Customer Support" },
      { id: "health_wellness", label: "Health & wellness" },
      { id: "finance", label: "Markets" },
    ]);
    expect(
      rankingDomains({
        citation: "",
        categories: [
          { category: "finance", models: [] },
          { category: "programming", models: [{ id: "a", totalTokens: "1" }] },
        ],
      }),
    ).toEqual([{ id: "programming", label: "Programming" }]);
  });
});

describe("rankAssistModels", () => {
  test("orders the chosen domain and keeps every other model", () => {
    const rankings = readAssistRankings({
      citation: "Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03.",
      categories: [
        {
          category: "all",
          models: [
            { id: "anthropic/claude-opus-5.5-20260921", totalTokens: "900" },
            { id: "openai/gpt-5", totalTokens: "3" },
            { id: "openai/gpt-5-20260101", totalTokens: "30" },
            { id: "deepseek/deepseek-chat", totalTokens: "20" },
          ],
        },
        {
          category: "finance",
          models: [
            { id: "openai/gpt-4o", totalTokens: "10" },
            { id: "mistral/small", totalTokens: "100" },
            { id: "mistral/small", totalTokens: "40" },
          ],
        },
        {
          category: "programming",
          models: [
            { id: "anthropic/claude", totalTokens: "50" },
            { id: "openai/gpt-4o", totalTokens: "80" },
            { id: "z-ai/same", totalTokens: "7" },
            { id: "z-ai/same-b", totalTokens: "7" },
            { id: "z-ai/named", totalTokens: "7" },
            { id: "extra/big", totalTokens: "90" },
          ],
        },
        {
          category: "academia",
          models: [{ id: "missing/model", totalTokens: "1000" }],
        },
        {
          category: "widgets",
          models: [
            { id: "local/widget", totalTokens: "5" },
            { id: "openai/gpt-4o", totalTokens: "80" },
          ],
        },
      ],
    });
    const withSlug: AssistModelOption[] = [
      ...catalog,
      { id: "z-ai/named", name: "Named" },
      { id: "anthropic/claude-opus-5.5", name: "Opus", canonicalSlug: "anthropic/claude-opus-5.5-20260921" },
      { id: "openai/gpt-5", name: "GPT-5", canonicalSlug: "openai/gpt-5-20260101" },
      { id: "openai/blank", name: "Blank", canonicalSlug: "" },
    ];
    const ranked = rankAssistModels(withSlug, rankings);
    expect(ranked.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03.");
    expect(ranked.models.map((model) => model.name)).toEqual([
      "Opus",
      "GPT-5",
      "DeepSeek",
      "GPT-4o",
      "Claude",
      "Mistral",
      "Same",
      "Same",
      "Big",
      "Widget",
      "Named",
      "Blank",
    ]);
    expect(ranked.models.filter((model) => model.id === "anthropic/claude")).toEqual([
      { id: "anthropic/claude", name: "Claude" },
    ]);

    expect(rankAssistModels(withSlug, rankings, " programming ").models.map((model) => model.id)).toEqual([
      "extra/big",
      "openai/gpt-4o",
      "anthropic/claude",
      "z-ai/named",
      "z-ai/same",
      "z-ai/same-b",
      "mistral/small",
      "deepseek/deepseek-chat",
      "local/widget",
      "anthropic/claude-opus-5.5",
      "openai/gpt-5",
      "openai/blank",
    ]);
    expect(rankAssistModels(withSlug, rankings, "finance").models.map((model) => model.name)).toEqual([
      "Mistral",
      "GPT-4o",
      "Claude",
      "DeepSeek",
      "Same",
      "Same",
      "Big",
      "Widget",
      "Named",
      "Opus",
      "GPT-5",
      "Blank",
    ]);
    expect(rankAssistModels(withSlug, rankings, "academia").models.map((model) => model.id)).toEqual(
      rankAssistModels(withSlug, null).models.map((model) => model.id),
    );
    expect(rankAssistModels(withSlug, rankings, "   ").models.map((model) => model.id)).toEqual(
      ranked.models.map((model) => model.id),
    );
  });

  test("leaves the catalog in place when the chosen domain has no match", () => {
    const tied = readAssistRankings({
      citation: "",
      categories: [
        {
          category: "science",
          models: [{ id: "openai/gpt-4o", totalTokens: `9${"0".repeat(20)}` }],
        },
        {
          category: "legal",
          models: [{ id: "anthropic/claude", totalTokens: `9${"0".repeat(20)}` }],
        },
      ],
    });
    const unique = catalog.filter((model, index) => catalog.findIndex((item) => item.id === model.id) === index);
    expect(rankAssistModels(catalog, tied).models).toEqual(unique);
    expect(rankAssistModels(catalog, tied).citation).toBeNull();
    expect(rankAssistModels(catalog, tied, "science").models[0]?.id).toBe("openai/gpt-4o");
    expect(rankAssistModels(catalog, null)).toEqual({ models: unique, citation: null });
    expect(rankAssistModels(catalog, { citation: "Source.", categories: [] })).toEqual({
      models: unique,
      citation: "Source.",
    });
    expect(
      rankAssistModels([{ id: "local/model", name: "Local" }], {
        citation: "",
        categories: [{ category: "finance", models: [{ id: "openai/gpt-4o", totalTokens: "3" }] }],
      }),
    ).toEqual({ models: [{ id: "local/model", name: "Local" }], citation: null });
    expect(
      rankAssistModels(
        [{ id: "local/model", name: "Local" }],
        {
          citation: "",
          categories: [{ category: "finance", models: [{ id: "openai/gpt-4o", totalTokens: "3" }] }],
        },
        "finance",
      ).models.map((model) => model.id),
    ).toEqual(["local/model"]);
  });

  test("follows the latest finance week, including a dated slug and its batch model", () => {
    const rankings = readAssistRankings({
      citation: "Source.",
      categories: [
        {
          category: "finance",
          label: "Finance",
          models: [
            { id: "anthropic/claude-opus-5.5-20260921", totalTokens: "152200" },
            { id: "anthropic/claude-opus-5.5-20260101", totalTokens: "999999" },
            { id: "anthropic/claude-sonnet-5.5-20260928", totalTokens: "91900" },
            { id: "anthropic/claude-fable-5.1-20260831", totalTokens: "62000" },
            { id: "moonshotai/kimi-k3-20260715", totalTokens: "50300" },
            { id: "openai/gpt-5.6-sol-20260709", totalTokens: "44500" },
            { id: "z-ai/glm-5.3-flash-20260826", totalTokens: "29600" },
            { id: "openai/gpt-6-astra-20260903", totalTokens: "200000" },
          ],
        },
      ],
    });
    const models: AssistModelOption[] = [
      { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash" },
      {
        id: "z-ai/glm-5.3-flash",
        name: "Z.ai: GLM 5.3 Flash",
        canonicalSlug: "z-ai/glm-5.3-flash-20260826",
      },
      {
        id: "z-ai/glm-5.3-flash:batch",
        name: "Z.ai: GLM 5.3 Flash (batch)",
        canonicalSlug: "z-ai/glm-5.3-flash-20260826",
      },
      { id: "openai/gpt-6-astra-pro:batch", name: "OpenAI: GPT-6 Astra Pro (batch)" },
      {
        id: "openai/gpt-6-astra",
        name: "OpenAI: GPT-6 Astra",
        canonicalSlug: "openai/gpt-6-astra-20260903",
      },
      { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5" },
      {
        id: "anthropic/claude-opus-5.5",
        name: "Anthropic: Claude Opus 5.5",
        canonicalSlug: "anthropic/claude-opus-5.5-20260921",
      },
      {
        id: "anthropic/claude-opus-5.5:batch",
        name: "Anthropic: Claude Opus 5.5 (batch)",
        canonicalSlug: "anthropic/claude-opus-5.5-20260921",
      },
      {
        id: "anthropic/claude-sonnet-5.5",
        name: "Anthropic: Claude Sonnet 5.5",
        canonicalSlug: "anthropic/claude-sonnet-5.5-20260928",
      },
      { id: "anthropic/claude-fable-5.1", name: "Anthropic: Claude Fable 5.1" },
      { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" },
      { id: "openai/gpt-5.6-sol:batch", name: "OpenAI: GPT-5.6 Sol (batch)" },
    ];
    expect(rankAssistModels(models, rankings, "finance").models.map((model) => model.name)).toEqual([
      "OpenAI: GPT-6 Astra",
      "Anthropic: Claude Opus 5.5",
      "Anthropic: Claude Opus 5.5 (batch)",
      "Anthropic: Claude Sonnet 5.5",
      "Anthropic: Claude Fable 5.1",
      "MoonshotAI: Kimi K3",
      "OpenAI: GPT-5.6 Sol (batch)",
      "Z.ai: GLM 5.3 Flash",
      "Z.ai: GLM 5.3 Flash (batch)",
      "DeepSeek: DeepSeek V4.1 Flash",
      "OpenAI: GPT-6 Astra Pro (batch)",
      "Anthropic: Claude Opus 5",
    ]);
    const undated = rankAssistModels(
      [
        { id: "anthropic/claude-opus-5.5", name: "Opus" },
        { id: "openai/other", name: "Other" },
      ],
      rankings,
      "finance",
    );
    expect(undated.models.map((model) => model.name)).toEqual(["Opus", "Other"]);
  });
});
