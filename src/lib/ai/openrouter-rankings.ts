/**
 * OpenRouter's domain rankings, copied once a day onto this server.
 *
 * The Data API counts tokens by the subject of the request. It is a dataset
 * read, so the copy is taken with the server's OPENROUTER_API_KEY and then
 * served to every chat. A failed day leaves the previous file in place.
 * Cite OpenRouter when showing the figures: the file's `citation` is the line
 * their license asks for.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveAssistKey } from "@/lib/ai/assist-transport";
import { getDataDir } from "@/lib/data-dir";

export const OPENROUTER_RANKINGS_URL = "https://openrouter.ai/api/v1/datasets/rankings-daily";

/** A stored copy older than this is fetched again. Younger copies are served as they are. */
export const RANKINGS_MAX_AGE_MS = 86_400_000;

/**
 * The subject areas OpenRouter ranks. `day` is rejected for these; the pull
 * asks for the latest week.
 */
export const RANKING_CATEGORIES = [
  "programming",
  "roleplay",
  "marketing",
  "marketing/seo",
  "technology",
  "science",
  "translation",
  "legal",
  "finance",
  "health",
  "trivia",
  "academia",
] as const;

export type RankingCategory = (typeof RANKING_CATEGORIES)[number];

export interface RankedModel {
  readonly id: string;
  readonly totalTokens: string;
}

export interface RankingCategorySnapshot {
  readonly category: RankingCategory;
  readonly asOf: string;
  readonly models: readonly RankedModel[];
}

export interface OpenRouterRankingsFile {
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
  /** Pass null to skip the pull. Omit it to use the server's OpenRouter key. */
  readonly key?: string | null;
}

let refreshInFlight: Promise<OpenRouterRankingsFile | null> | null = null;

/** Where the copy is written. Override the path when the data directory is not the right disk. */
export function rankingsFilePath(): string {
  const override = process.env.OPENROUTER_RANKINGS_PATH;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return path.join(getDataDir(), "openrouter-rankings.json");
}

function isRankingCategory(value: string): value is RankingCategory {
  return (RANKING_CATEGORIES as readonly string[]).includes(value);
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
    isRankingCategory(value.category) &&
    "asOf" in value &&
    typeof value.asOf === "string" &&
    "models" in value &&
    Array.isArray(value.models) &&
    value.models.every(isRankedModel)
  );
}

function isRankingsFile(value: unknown): value is OpenRouterRankingsFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "fetchedAt" in value &&
    typeof value.fetchedAt === "string" &&
    "citation" in value &&
    typeof value.citation === "string" &&
    "categories" in value &&
    Array.isArray(value.categories) &&
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

function rankingsUrl(category: RankingCategory): string {
  const params = new URLSearchParams({ period: "week", category });
  return `${OPENROUTER_RANKINGS_URL}?${params.toString()}`;
}

function compareTokens(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function rowOf(row: unknown): { date: string; id: string; tokens: string } | null {
  if (row === null || typeof row !== "object") return null;
  if (!("date" in row) || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (!("model_permaslug" in row) || typeof row.model_permaslug !== "string") return null;
  const id = row.model_permaslug.trim();
  if (id === "" || id === "other") return null;
  if (!("total_tokens" in row) || typeof row.total_tokens !== "string" || !/^\d+$/.test(row.total_tokens)) return null;
  return { date: row.date, id, tokens: row.total_tokens };
}

/** The latest week of one category, or null when the body is not a ranking. */
function categorySnapshot(category: RankingCategory, payload: unknown): RankingCategorySnapshot | null {
  if (payload === null || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    return null;
  }
  let latest = "";
  const byDate = new Map<string, RankedModel[]>();
  for (const row of payload.data) {
    const parsed = rowOf(row);
    if (parsed === null) continue;
    const list = byDate.get(parsed.date) ?? [];
    list.push({ id: parsed.id, totalTokens: parsed.tokens });
    byDate.set(parsed.date, list);
    if (parsed.date > latest) latest = parsed.date;
  }
  const models = byDate.get(latest);
  if (models === undefined || models.length === 0) return null;
  models.sort((a, b) => compareTokens(a.totalTokens, b.totalTokens) || a.id.localeCompare(b.id));
  let asOf = "";
  if ("meta" in payload && payload.meta !== null && typeof payload.meta === "object" && "as_of" in payload.meta) {
    if (typeof payload.meta.as_of === "string") asOf = payload.meta.as_of;
  }
  return { category, asOf, models };
}

function citationFor(categories: readonly RankingCategorySnapshot[]): string {
  let asOf = "";
  for (const category of categories) {
    if (category.asOf > asOf) asOf = category.asOf;
  }
  const when = asOf === "" ? "the latest weekly rankings" : asOf;
  return `Source: OpenRouter (openrouter.ai/rankings), as of ${when}.`;
}

async function pullCategory(
  category: RankingCategory,
  key: string,
  fetchImpl: RankingsFetch,
): Promise<RankingCategorySnapshot | null> {
  const response = await fetchImpl(rankingsUrl(category), {
    headers: {
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://midst.market",
      "X-Title": "Midst",
    },
  });
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  return categorySnapshot(category, payload);
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

function chosenKey(override: string | null | undefined): string | null {
  if (override === undefined) return resolveAssistKey("openrouter", "");
  const trimmed = override === null ? "" : override.trim();
  return trimmed === "" ? null : trimmed;
}

async function refreshOnce(options: RefreshRankingsOptions): Promise<OpenRouterRankingsFile | null> {
  const filePath = options.filePath ?? rankingsFilePath();
  const now = options.now ?? Date.now;
  const stored = readStored(filePath);
  if (stored !== null && fresh(stored, now())) return stored;
  const key = chosenKey(options.key);
  if (key === null) return stored;
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const pulled = await Promise.all(RANKING_CATEGORIES.map((category) => pullCategory(category, key, fetchImpl)));
    const categories: RankingCategorySnapshot[] = [];
    for (const snapshot of pulled) {
      if (snapshot === null) return stored;
      categories.push(snapshot);
    }
    const next: OpenRouterRankingsFile = {
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
 * The saved copy when it is younger than a day. Otherwise one pull of every
 * domain, written only after all of them succeed. Callers share one pull.
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
