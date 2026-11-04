/**
 * Where each OpenRouter model sits in the chat's model list.
 *
 * The person picks a domain. The models that domain ranks come first, in the
 * latest week's order, and the rest of the catalog follows so a model can
 * still be chosen. All is overall use. A ranking id may be the dated slug, so
 * a catalog model matches on its id, that slug, or the undated id the slug
 * belongs to.
 */

import type { AssistModelOption } from "@/lib/ai/assist-settings";

export interface AssistRankedModel {
  readonly id: string;
  readonly totalTokens: string;
}

export interface AssistRankingCategory {
  readonly category: string;
  readonly label?: string;
  readonly models: readonly AssistRankedModel[];
}

export interface AssistRankings {
  readonly citation: string;
  readonly categories: readonly AssistRankingCategory[];
}

/** The domain filter's first choice: overall use, not one subject. */
export const ASSIST_RANK_ALL = "all";

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
  health_wellness: "Health & wellness",
  trivia: "Trivia",
  academia: "Academia",
  software_technology: "Software & technology",
  arts_entertainment: "Arts & entertainment",
  business_operations: "Business operations",
  science_engineering: "Science & engineering",
  customer_service: "Customer service",
  marketing_advertising: "Marketing & advertising",
  sales_commerce: "Sales & commerce",
  government_politics: "Government & politics",
  travel_hospitality: "Travel & hospitality",
};

function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known !== undefined) return known;
  const words = category
    .split(/[/_]/)
    .filter((part) => part !== "")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1));
  return words.length === 0 ? category : words.join(" ");
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
  const label = "label" in value && typeof value.label === "string" ? value.label.trim() : "";
  return label === "" ? { category, models } : { category, label, models };
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

export interface RankingDomain {
  readonly id: string;
  readonly label: string;
}

/** The domains a person can filter by, in label order. Overall use is not one of them. */
export function rankingDomains(rankings: AssistRankings | null): RankingDomain[] {
  if (rankings === null) return [];
  const domains: RankingDomain[] = [];
  for (const category of rankings.categories) {
    if (category.category === ASSIST_RANK_ALL || category.models.length === 0) continue;
    const label =
      category.label !== undefined && category.label !== "" ? category.label : categoryLabel(category.category);
    domains.push({ id: category.category, label });
  }
  domains.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return domains;
}

function modelKeys(model: AssistModelOption): Set<string> {
  const keys = new Set<string>([model.id]);
  if (model.canonicalSlug !== undefined && model.canonicalSlug !== "") keys.add(model.canonicalSlug);
  return keys;
}

/** `anthropic/claude-opus-5.5-20260921` and its `:batch` form both belong to `anthropic/claude-opus-5.5`. */
function familyKey(slug: string): string {
  const colon = slug.indexOf(":");
  const bare = colon === -1 ? slug : slug.slice(0, colon);
  return bare.replace(/-\d{8}$/, "");
}

function tokensFor(category: AssistRankingCategory | undefined, model: AssistModelOption): bigint | null {
  if (category === undefined) return null;
  const keys = modelKeys(model);
  const modelFamily = familyKey(model.id);
  let exact: bigint | null = null;
  let family: bigint | null = null;
  for (const row of category.models) {
    const tokens = BigInt(row.totalTokens);
    if (keys.has(row.id)) {
      if (exact === null || tokens > exact) exact = tokens;
      continue;
    }
    const rowFamily = familyKey(row.id);
    const sameFamily = rowFamily === model.id || (model.id.includes(":") && rowFamily === modelFamily);
    if (!sameFamily) continue;
    if (family === null || tokens > family) family = tokens;
  }
  return exact ?? family;
}

/**
 * The catalog ordered for one domain.
 * Ranked models come first. The rest keep the catalog's order. The citation is
 * OpenRouter's line, or null when there is none.
 */
export function rankAssistModels(
  models: readonly AssistModelOption[],
  rankings: AssistRankings | null,
  domain = ASSIST_RANK_ALL,
): { readonly models: readonly AssistModelOption[]; readonly citation: string | null } {
  const citation = rankings !== null && rankings.citation !== "" ? rankings.citation : null;
  const seen = new Set<string>();
  const unique: AssistModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }
  const chosen = domain.trim() === "" ? ASSIST_RANK_ALL : domain.trim();
  const category = rankings?.categories.find((item) => item.category === chosen);
  if (category === undefined) return { models: unique, citation };
  const ranked: { model: AssistModelOption; tokens: bigint }[] = [];
  const rest: AssistModelOption[] = [];
  for (const model of unique) {
    const tokens = tokensFor(category, model);
    if (tokens === null) rest.push(model);
    else ranked.push({ model, tokens });
  }
  if (ranked.length === 0) return { models: unique, citation };
  ranked.sort((left, right) => {
    if (left.tokens === right.tokens) {
      const byName = left.model.name.localeCompare(right.model.name);
      return byName !== 0 ? byName : left.model.id.localeCompare(right.model.id);
    }
    return left.tokens > right.tokens ? -1 : 1;
  });
  return { models: [...ranked.map((row) => row.model), ...rest], citation };
}
