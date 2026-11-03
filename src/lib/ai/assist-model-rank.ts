/**
 * Where each OpenRouter model sits in the chat's model list.
 *
 * A model is filed under the domain where the saved rankings give it the most
 * tokens. Domains are ordered by that top figure, and the models inside a
 * domain follow the same order. A model the rankings do not name stays in the
 * order the catalog returned it.
 */

import type { AssistModelOption } from "@/lib/ai/assist-settings";

export interface AssistRankedModel {
  readonly id: string;
  readonly totalTokens: string;
}

export interface AssistRankingCategory {
  readonly category: string;
  readonly models: readonly AssistRankedModel[];
}

export interface AssistRankings {
  readonly citation: string;
  readonly categories: readonly AssistRankingCategory[];
}

export interface RankedModelGroup {
  readonly category: string;
  readonly label: string;
  readonly models: readonly AssistModelOption[];
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  programming: "Programming",
  roleplay: "Roleplay",
  marketing: "Marketing",
  "marketing/seo": "Marketing / SEO",
  technology: "Technology",
  science: "Science",
  translation: "Translation",
  legal: "Legal",
  finance: "Finance",
  health: "Health",
  trivia: "Trivia",
  academia: "Academia",
};

function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known !== undefined) return known;
  return category.slice(0, 1).toUpperCase() + category.slice(1);
}

function tokensOf(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return value;
}

function modelOf(value: unknown): AssistRankedModel | null {
  if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") return null;
  const id = value.id.trim();
  const totalTokens = tokensOf("totalTokens" in value ? value.totalTokens : undefined);
  if (id === "" || totalTokens === null) return null;
  return { id, totalTokens };
}

function categoryOf(value: unknown): AssistRankingCategory | null {
  if (value === null || typeof value !== "object" || !("category" in value) || typeof value.category !== "string") {
    return null;
  }
  const category = value.category.trim();
  if (category === "" || !("models" in value) || !Array.isArray(value.models)) return null;
  const models: AssistRankedModel[] = [];
  for (const item of value.models) {
    const model = modelOf(item);
    if (model !== null) models.push(model);
  }
  if (models.length === 0) return null;
  return { category, models };
}

/** The rankings a catalog response carried, or null when that field is not a ranking. */
export function readAssistRankings(value: unknown): AssistRankings | null {
  if (value === null || typeof value !== "object" || !("categories" in value) || !Array.isArray(value.categories)) {
    return null;
  }
  const citation = "citation" in value && typeof value.citation === "string" ? value.citation.trim() : "";
  const categories: AssistRankingCategory[] = [];
  for (const item of value.categories) {
    const category = categoryOf(item);
    if (category !== null) categories.push(category);
  }
  if (categories.length === 0 && citation === "") return null;
  return { citation, categories };
}

interface Placement {
  readonly category: string;
  readonly tokens: bigint;
}

function placementFor(rankings: AssistRankings): Map<string, Placement> {
  const placed = new Map<string, Placement>();
  for (const category of rankings.categories) {
    for (const model of category.models) {
      const tokens = BigInt(model.totalTokens);
      const current = placed.get(model.id);
      if (
        current === undefined ||
        tokens > current.tokens ||
        (tokens === current.tokens && category.category < current.category)
      ) {
        placed.set(model.id, { category: category.category, tokens });
      }
    }
  }
  return placed;
}

interface Bucket {
  readonly category: string;
  readonly label: string;
  readonly top: bigint;
  readonly rows: { readonly model: AssistModelOption; readonly tokens: bigint }[];
}

/**
 * The catalog grouped by the domain each model leads.
 * `groups` is null when nothing in the catalog is ranked, so the page keeps the
 * catalog order. The citation is OpenRouter's line, or null when there is none.
 */
export function rankAssistModels(
  models: readonly AssistModelOption[],
  rankings: AssistRankings | null,
): { readonly groups: readonly RankedModelGroup[] | null; readonly citation: string | null } {
  const citation = rankings !== null && rankings.citation !== "" ? rankings.citation : null;
  if (rankings === null || rankings.categories.length === 0) return { groups: null, citation };
  const placed = placementFor(rankings);
  const buckets = new Map<string, Bucket>();
  const other: AssistModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const rank = placed.get(model.id);
    if (rank === undefined) {
      other.push(model);
      continue;
    }
    const current = buckets.get(rank.category);
    if (current === undefined) {
      buckets.set(rank.category, {
        category: rank.category,
        label: categoryLabel(rank.category),
        top: rank.tokens,
        rows: [{ model, tokens: rank.tokens }],
      });
      continue;
    }
    current.rows.push({ model, tokens: rank.tokens });
    if (rank.tokens > current.top) {
      buckets.set(rank.category, { ...current, top: rank.tokens });
    }
  }
  if (buckets.size === 0) return { groups: null, citation };
  const groups = [...buckets.values()]
    .sort((left, right) => {
      if (left.top === right.top) return left.label.localeCompare(right.label);
      return left.top > right.top ? -1 : 1;
    })
    .map((bucket) => ({
      category: bucket.category,
      label: bucket.label,
      models: [...bucket.rows]
        .sort((left, right) => {
          if (left.tokens === right.tokens) {
            const byName = left.model.name.localeCompare(right.model.name);
            return byName !== 0 ? byName : left.model.id.localeCompare(right.model.id);
          }
          return left.tokens > right.tokens ? -1 : 1;
        })
        .map((row) => row.model),
    }));
  if (other.length > 0) groups.push({ category: "other", label: "Other", models: other });
  return { groups, citation };
}
