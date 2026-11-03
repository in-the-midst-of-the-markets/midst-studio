import { describe, expect, test } from "bun:test";
import { rankAssistModels, readAssistRankings } from "@/lib/ai/assist-model-rank";
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

describe("rankAssistModels", () => {
  test("files each model under the domain where it has the most tokens", () => {
    const rankings = readAssistRankings({
      citation: "Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03.",
      categories: [
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
    const ranked = rankAssistModels(catalog, rankings);
    expect(ranked.citation).toBe("Source: OpenRouter (openrouter.ai/rankings), as of 2026-11-03.");
    expect(ranked.groups?.map((group) => [group.label, group.models.map((model) => model.name)])).toEqual([
      ["Finance", ["Mistral"]],
      ["Programming", ["Big", "GPT-4o", "Claude", "Same", "Same"]],
      ["Widgets", ["Widget"]],
      ["Other", ["DeepSeek"]],
    ]);
    expect(ranked.groups?.[1]?.models.map((model) => model.id)).toEqual([
      "extra/big",
      "openai/gpt-4o",
      "anthropic/claude",
      "z-ai/same",
      "z-ai/same-b",
    ]);
  });

  test("orders domains that share a top figure by name and leaves an unranked catalog flat", () => {
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
    const ranked = rankAssistModels(catalog, tied);
    expect(ranked.citation).toBeNull();
    expect(ranked.groups?.map((group) => group.label)).toEqual(["Legal", "Science", "Other"]);
    expect(rankAssistModels(catalog, null)).toEqual({ groups: null, citation: null });
    expect(rankAssistModels(catalog, { citation: "Source.", categories: [] })).toEqual({
      groups: null,
      citation: "Source.",
    });
    expect(
      rankAssistModels([{ id: "local/model", name: "Local" }], {
        citation: "",
        categories: [{ category: "finance", models: [{ id: "openai/gpt-4o", totalTokens: "3" }] }],
      }),
    ).toEqual({ groups: null, citation: null });
  });
});
