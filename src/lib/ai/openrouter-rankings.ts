/**
 * OpenRouter's domain rankings, copied once a day onto this server.
 *
 * The copy is the latest week of the public domain chart on
 * openrouter.ai/rankings. Each domain lists models by their share of that
 * week, which is the order the chart draws. All is the trailing week of token
 * volume. The chart is public, so the copy does not need an API key. A failed
 * day leaves the previous file in place. Cite OpenRouter when showing the
 * figures: the file's `citation` is the line their license asks for.
 */

import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "@/lib/data-dir";

/** The domain list on the rankings page. */
export const OPENROUTER_DOMAIN_OPTIONS_URL =
  "https://openrouter.ai/api/frontend/v1/rankings/modality-category-options?routeSegment=text";

/** One domain's weekly share series. `category` selects the domain. */
export const OPENROUTER_DOMAIN_SHARE_URL = "https://openrouter.ai/api/frontend/v1/rankings/modality-category-share";

/** Trailing week of token volume, used for All. */
export const OPENROUTER_WEEKLY_MODELS_URL =
  "https://openrouter.ai/api/frontend/v1/rankings/models?view=week&metric=tokens_excl_byok";

/** A stored copy older than this is fetched again. Younger copies are served as they are. */
export const RANKINGS_MAX_AGE_MS = 86_400_000;

/** Files from an earlier ranking are ignored, so a deploy picks up the chart's order. */
export const RANKINGS_FORMAT = 2;

/** Overall use, from the trailing week of token volume. */
export const OVERALL_RANKING = "all";

/** A share is stored as millionths so the menu can order it with integer comparison. */
const SHARE_MILLIONTHS = 1_000_000;

export interface RankedModel {
  readonly id: string;
  readonly totalTokens: string;
}

export interface RankingCategorySnapshot {
  readonly category: string;
  readonly label: string;
  readonly asOf: string;
  readonly models: readonly RankedModel[];
}

export interface OpenRouterRankingsFile {
  readonly version: typeof RANKINGS_FORMAT;
  readonly fetchedAt: string;
  readonly citation: string;
  readonly categories: readonly RankingCategorySnapshot[];
}

/** The rankings request. A test double does not have to carry the runtime's extra fetch methods. */
type RankingsFetch = (input: string, init?: RequestInit) => Promise<Response> | Response;

export interface RefreshRankingsOptions {
  readonly fetchImpl?: RankingsFetch;
  readonly now?: () => number;
  readonly filePath?: string;
}

interface DomainOption {
  readonly value: string;
  readonly label: string;
}

let refreshInFlight: Promise<OpenRouterRankingsFile | null> | null = null;

/** Where the copy is written. Override the path when the data directory is not the right disk. */
export function rankingsFilePath(): string {
  const override = process.env.OPENROUTER_RANKINGS_PATH;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return path.join(getDataDir(), "openrouter-rankings.json");
}

function isRankedModel(value: unknown): value is RankedModel {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.trim() !== "" &&
    "totalTokens" in value &&
    typeof value.totalTokens === "string" &&
    /^\d+$/.test(value.totalTokens)
  );
}

function isCategorySnapshot(value: unknown): value is RankingCategorySnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    "category" in value &&
    typeof value.category === "string" &&
    value.category.trim() !== "" &&
    "label" in value &&
    typeof value.label === "string" &&
    value.label.trim() !== "" &&
    "asOf" in value &&
    typeof value.asOf === "string" &&
    "models" in value &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    value.models.every(isRankedModel)
  );
}

function isRankingsFile(value: unknown): value is OpenRouterRankingsFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "version" in value &&
    value.version === RANKINGS_FORMAT &&
    "fetchedAt" in value &&
    typeof value.fetchedAt === "string" &&
    "citation" in value &&
    typeof value.citation === "string" &&
    "categories" in value &&
    Array.isArray(value.categories) &&
    value.categories.length > 0 &&
    value.categories.every(isCategorySnapshot)
  );
}

function readStored(filePath: string): OpenRouterRankingsFile | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRankingsFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fresh(snapshot: OpenRouterRankingsFile, now: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(fetchedAt)) return false;
  return now - fetchedAt < RANKINGS_MAX_AGE_MS;
}

function shareUrl(category: string): string {
  const params = new URLSearchParams({
    routeSegment: "text",
    dimension: "domain",
    category,
  });
  return `${OPENROUTER_DOMAIN_SHARE_URL}?${params.toString()}`;
}

function fallbackLabel(value: string): string {
  const words = value
    .split(/[/_]/)
    .filter((part) => part !== "")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1));
  return words.length === 0 ? value : words.join(" ");
}

function compareWeights(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function domainList(payload: unknown): DomainOption[] | null {
  if (payload === null || typeof payload !== "object" || !("data" in payload)) return null;
  const data = payload.data;
  if (data === null || typeof data !== "object" || !("dimensions" in data) || !Array.isArray(data.dimensions)) {
    return null;
  }
  for (const dimension of data.dimensions) {
    if (dimension === null || typeof dimension !== "object" || !("dimension" in dimension)) continue;
    if (dimension.dimension !== "domain") continue;
    if (!("categories" in dimension) || !Array.isArray(dimension.categories)) return null;
    const domains: DomainOption[] = [];
    const seen = new Set<string>();
    for (const category of dimension.categories) {
      if (category === null || typeof category !== "object" || !("value" in category)) continue;
      if (typeof category.value !== "string") continue;
      const value = category.value.trim();
      if (value === "" || value === OVERALL_RANKING || seen.has(value)) continue;
      seen.add(value);
      const given = "label" in category && typeof category.label === "string" ? category.label.trim() : "";
      domains.push({ value, label: given === "" ? fallbackLabel(value) : given });
    }
    return domains.length === 0 ? null : domains;
  }
  return null;
}

function shareWeight(share: number): string | null {
  if (!Number.isFinite(share) || share <= 0) return null;
  const weight = Math.round(share * SHARE_MILLIONTHS);
  if (weight <= 0) return null;
  return String(weight);
}

/** The newest week of one domain, or null when the body is not that chart. */
function latestWeek(payload: unknown): { asOf: string; models: RankedModel[] } | null {
  if (payload === null || typeof payload !== "object" || !("data" in payload)) return null;
  const data = payload.data;
  if (
    data === null ||
    typeof data !== "object" ||
    !("marketShareData" in data) ||
    !Array.isArray(data.marketShareData)
  ) {
    return null;
  }
  let asOf = "";
  let shares: Record<string, unknown> | null = null;
  for (const row of data.marketShareData) {
    if (row === null || typeof row !== "object") continue;
    if (!("x" in row) || typeof row.x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.x)) continue;
    if (!("ys" in row) || row.ys === null || typeof row.ys !== "object" || Array.isArray(row.ys)) continue;
    if (row.x < asOf) continue;
    asOf = row.x;
    shares = row.ys as Record<string, unknown>;
  }
  if (shares === null) return null;
  const models: RankedModel[] = [];
  for (const [id, share] of Object.entries(shares)) {
    const trimmed = id.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "others") continue;
    if (typeof share !== "number") continue;
    const weight = shareWeight(share);
    if (weight === null) continue;
    models.push({ id: trimmed, totalTokens: weight });
  }
  if (models.length === 0) return null;
  models.sort((left, right) => compareWeights(left.totalTokens, right.totalTokens) || left.id.localeCompare(right.id));
  return { asOf, models };
}

function metricOf(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") return BigInt(value);
  return null;
}

function dayOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function slugOf(row: object): string {
  if ("variant_permaslug" in row && typeof row.variant_permaslug === "string" && row.variant_permaslug.trim() !== "") {
    return row.variant_permaslug.trim();
  }
  if ("model_permaslug" in row && typeof row.model_permaslug === "string") return row.model_permaslug.trim();
  return "";
}

/** The trailing week of token volume, or null when the body is not that chart. */
function overallSnapshot(payload: unknown): RankingCategorySnapshot | null {
  if (payload === null || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    return null;
  }
  const totals = new Map<string, bigint>();
  let asOf = "";
  for (const row of payload.data) {
    if (row === null || typeof row !== "object") continue;
    const slug = slugOf(row);
    if (slug === "" || slug.toLowerCase() === "other" || slug.toLowerCase() === "others") continue;
    const metric = metricOf("rankingMetricValue" in row ? row.rankingMetricValue : undefined);
    if (metric === null) continue;
    totals.set(slug, (totals.get(slug) ?? BigInt(0)) + metric);
    const day = dayOf("date" in row ? row.date : undefined);
    if (day > asOf) asOf = day;
  }
  if (totals.size === 0) return null;
  const models = [...totals.entries()].map(([id, tokens]) => ({ id, totalTokens: tokens.toString() }));
  models.sort((left, right) => compareWeights(left.totalTokens, right.totalTokens) || left.id.localeCompare(right.id));
  return { category: OVERALL_RANKING, label: "All", asOf, models };
}

function citationFor(categories: readonly RankingCategorySnapshot[]): string {
  let asOf = "";
  for (const category of categories) {
    if (category.asOf > asOf) asOf = category.asOf;
  }
  const when = asOf === "" ? "the latest weekly rankings" : asOf;
  return `Source: OpenRouter (openrouter.ai/rankings), as of ${when}.`;
}

async function pullJson(url: string, fetchImpl: RankingsFetch): Promise<unknown | null> {
  const response = await fetchImpl(url, {
    headers: {
      "HTTP-Referer": "https://midst.market",
      "X-Title": "Midst",
    },
  });
  if (!response.ok) return null;
  return await response.json().catch(() => null);
}

function writeStored(filePath: string, snapshot: OpenRouterRankingsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot), { mode: 0o644 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

async function refreshOnce(options: RefreshRankingsOptions): Promise<OpenRouterRankingsFile | null> {
  const filePath = options.filePath ?? rankingsFilePath();
  const now = options.now ?? Date.now;
  const stored = readStored(filePath);
  if (stored !== null && fresh(stored, now())) return stored;
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const listed = domainList(await pullJson(OPENROUTER_DOMAIN_OPTIONS_URL, fetchImpl));
    if (listed === null) return stored;
    const shares = await Promise.all(listed.map((domain) => pullJson(shareUrl(domain.value), fetchImpl)));
    const overall = overallSnapshot(await pullJson(OPENROUTER_WEEKLY_MODELS_URL, fetchImpl));
    if (overall === null) return stored;
    const categories: RankingCategorySnapshot[] = [overall];
    for (let index = 0; index < listed.length; index += 1) {
      const week = latestWeek(shares[index]);
      const domain = listed[index];
      if (week === null || domain === undefined) return stored;
      categories.push({ category: domain.value, label: domain.label, asOf: week.asOf, models: week.models });
    }
    const next: OpenRouterRankingsFile = {
      version: RANKINGS_FORMAT,
      fetchedAt: new Date(now()).toISOString(),
      citation: citationFor(categories),
      categories,
    };
    writeStored(filePath, next);
    return next;
  } catch {
    return readStored(filePath);
  }
}

/**
 * The saved copy when it is younger than a day. Otherwise one pull of the
 * domain chart, written only after every domain succeeds. Callers share one pull.
 */
export function refreshOpenRouterRankings(
  options: RefreshRankingsOptions = {},
): Promise<OpenRouterRankingsFile | null> {
  if (refreshInFlight !== null) return refreshInFlight;
  refreshInFlight = refreshOnce(options).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
