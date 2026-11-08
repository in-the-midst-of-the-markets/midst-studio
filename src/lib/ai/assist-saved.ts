/**
 * Saved queries a person attaches to an AI Assist question, and the catalog the
 * model checks when it chooses the one chart that question asks for.
 *
 * Attached queries are the ones the person added with the plus button. They run
 * first and are charted when the rows support a chart. The model then writes
 * the explanation from those rows. Any other question can read the catalog when
 * it needs a saved statement. Reading the catalog does not run those queries.
 */

import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import type { SavedQuery } from "@/lib/types";

export interface AssistSavedPick {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
  readonly connectionId: string | null;
  readonly connectionType: string;
}

/** How many saved queries one question may show the model. */
export const ASSIST_SAVED_LIST_CAP = 12;
const SAVED_NAME_CAP = 120;
const SAVED_SQL_CAP = 2_000;
const SAVED_CONNECTION_CAP = 200;

export interface AssistSavedListing {
  readonly name: string;
  readonly connection: string;
  readonly sql: string;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ASSIST_TEXT_CAP ? trimmed.slice(0, ASSIST_TEXT_CAP) : trimmed;
}

function clipField(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > cap ? text.slice(0, cap) : text;
}

function clipSql(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > SAVED_SQL_CAP ? text.slice(0, SAVED_SQL_CAP) : text;
}

function savedInstant(value: Date | undefined): number {
  if (!(value instanceof Date)) return Number.NaN;
  return value.getTime();
}

/** When the query was last saved. A missing stamp sorts as the oldest. */
function savedAt(query: SavedQuery): number {
  const updated = savedInstant(query.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = savedInstant(query.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * Saved queries the picker can offer. A blank statement is not one.
 * The most recently saved query is first, so the plus menu leads with it.
 */
export function assistSavedPicks(queries: readonly SavedQuery[]): AssistSavedPick[] {
  const ordered = queries.map((query, index) => ({ query, index, at: savedAt(query) }));
  ordered.sort((left, right) => right.at - left.at || left.index - right.index);
  const picks: AssistSavedPick[] = [];
  for (const { query } of ordered) {
    const sql = query.query.trim();
    if (sql === "") continue;
    const name = query.name.trim();
    picks.push({
      id: query.id,
      name: name === "" ? "Saved query" : name,
      sql,
      connectionId: query.connectionId ?? null,
      connectionType: query.connectionType,
    });
  }
  return picks;
}

export interface AssistSavedChart {
  readonly title: string;
  readonly sql: string;
  readonly connectionId: string | null;
  readonly chart: {
    readonly type: "bar" | "line" | "area" | "scatter" | "stacked-bar";
    readonly x: string;
    readonly y: readonly string[];
  };
}

function askedChart(question: string): AssistSavedChart["chart"]["type"] | null {
  if (/\bstacked[ -]?bars?\b/i.test(question)) return "stacked-bar";
  if (/\bline\s+charts?\b/i.test(question)) return "line";
  if (/\barea\s+charts?\b/i.test(question)) return "area";
  if (/\bscatter(?:\s+charts?|\s+plots?)?\b/i.test(question)) return "scatter";
  if (/\bbar\s+charts?\b/i.test(question)) return "bar";
  if (/\bcharts?\b/i.test(question)) return "bar";
  return null;
}

function namedPick(question: string, picks: readonly AssistSavedPick[]): AssistSavedPick | null {
  let found: AssistSavedPick | null = null;
  for (const pick of picks) {
    const name = pick.name.trim();
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i").test(question)) continue;
    if (found === null || name.length > found.name.length) found = pick;
  }
  return found;
}

function weaviateScore(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "distance" || lower === "$distance") return "$distance";
  if (lower === "certainty" || lower === "$certainty") return "$certainty";
  return null;
}

function askedMetric(question: string, engine: string, sql: string): string {
  const named = /\bthe\s+([A-Za-z_$][\w$]*)\s+column\s+as\s+the\s+values\b/i.exec(question)?.[1];
  if (named !== undefined) {
    if (engine === "weaviate") return weaviateScore(named) ?? named;
    return named;
  }
  if (engine === "weaviate" && (/"distance"/.test(sql) || sql.includes("$distance"))) return "$distance";
  if (engine === "weaviate" && (/"certainty"/.test(sql) || sql.includes("$certainty"))) return "$certainty";
  return "value";
}

function categoryColumn(sql: string): string {
  const named = /"returnProperties"\s*:\s*\[\s*"([^"\\]+)"/.exec(sql)?.[1]?.trim() ?? "";
  return named === "" ? "category" : named;
}

function searchTerm(sql: string): string {
  const plain = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/.exec(sql)?.[1];
  return plain === undefined || plain === "search" ? "query" : plain;
}

function replaceVectorValue(sql: string, token: string): string {
  const key = sql.search(/"vector"\s*:/);
  if (key < 0) return sql;
  const colon = sql.indexOf(":", key);
  let index = colon + 1;
  while (index < sql.length && /\s/.test(sql[index] ?? "")) index += 1;
  if (sql.startsWith("{{", index)) {
    const end = sql.indexOf("}}", index);
    if (end < 0) return sql;
    if (/^\{\{\s*search\s*:/.test(sql.slice(index, end + 2))) return sql;
    return `${sql.slice(0, index)}${token}${sql.slice(end + 2)}`;
  }
  if (sql[index] === "[") {
    let depth = 0;
    for (let cursor = index; cursor < sql.length; cursor += 1) {
      const char = sql[cursor];
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) return `${sql.slice(0, index)}${token}${sql.slice(cursor + 1)}`;
      }
    }
    return sql;
  }
  if (sql[index] === '"') {
    const end = sql.indexOf('"', index + 1);
    if (end < 0) return sql;
    return `${sql.slice(0, index)}${token}${sql.slice(end + 1)}`;
  }
  const number = /^[-\d.eE+]+/.exec(sql.slice(index));
  if (number !== null && number[0] !== "")
    return `${sql.slice(0, index)}${token}${sql.slice(index + number[0].length)}`;
  return sql;
}

function withDistance(sql: string): string {
  if (/"returnMetadata"\s*:\s*\[[^\]]*"distance"/.test(sql)) return sql;
  if (/"returnMetadata"\s*:/.test(sql)) {
    return sql.replace(/"returnMetadata"\s*:\s*\[([^\]]*)\]/, (_full, inner: string) => {
      const body = inner.trim();
      return `"returnMetadata": [${body === "" ? '"distance"' : `${body}, "distance"`}]`;
    });
  }
  const last = sql.lastIndexOf("}");
  if (last < 0) return sql;
  const prefix = sql.slice(0, last).trimEnd();
  const joiner = prefix.endsWith("{") || prefix.endsWith("[") ? "" : ", ";
  return `${prefix}${joiner}"returnMetadata": ["distance"]${sql.slice(last)}`;
}

/**
 * The chart a question asks for from a saved query it names.
 * Used when the model only describes that query. Null when the question does
 * not ask for a chart, or does not name one of these queries.
 */
export function assistSavedChart(question: string, picks: readonly AssistSavedPick[]): AssistSavedChart | null {
  const type = askedChart(question);
  const pick = namedPick(question, picks);
  if (type === null || pick === null) return null;
  const metric = askedMetric(question, pick.connectionType, pick.sql);
  let sql = pick.sql;
  if (pick.connectionType === "weaviate" && metric === "$distance") sql = withDistance(sql);
  if (/\bsearch box\b/i.test(question)) sql = replaceVectorValue(sql, `{{search:${searchTerm(pick.sql)}}}`);
  return {
    title: pick.name,
    sql,
    connectionId: pick.connectionId,
    chart: { type, x: categoryColumn(sql), y: [metric] },
  };
}

/**
 * The catalog a question sends so the model can check saved queries.
 * The list stops at the cap. A statement longer than the catalog allows is cut.
 */
export function assistSavedForPrompt(
  picks: readonly AssistSavedPick[],
  connections: readonly { readonly id: string; readonly name: string }[],
): AssistSavedListing[] {
  const listed: AssistSavedListing[] = [];
  for (const pick of picks) {
    if (listed.length === ASSIST_SAVED_LIST_CAP) break;
    const sql = clipSql(pick.sql);
    if (sql === "") continue;
    const named = connections.find((item) => item.id === pick.connectionId);
    const name = clipField(pick.name, SAVED_NAME_CAP);
    listed.push({
      name: name === "" ? "Saved query" : name,
      connection: named === undefined ? "" : clipField(named.name, SAVED_CONNECTION_CAP),
      sql,
    });
  }
  return listed;
}

/** The saved-query catalog posted with a question. Anything else is refused. */
export function readAssistSaved(
  value: unknown,
): { ok: true; value: AssistSavedListing[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "The saved queries are not valid." };
  if (value.length > ASSIST_SAVED_LIST_CAP) return { ok: false, error: "The saved queries are too long." };
  const listed: AssistSavedListing[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const sql = clipSql("sql" in item ? item.sql : undefined);
    if (sql === "") continue;
    const name = clipField("name" in item ? item.name : undefined, SAVED_NAME_CAP);
    listed.push({
      name: name === "" ? "Saved query" : name,
      connection: clipField("connection" in item ? item.connection : undefined, SAVED_CONNECTION_CAP),
      sql,
    });
  }
  return { ok: true, value: listed };
}

/** The catalog as text the prompt can fence. "(none)" when the person has saved nothing. */
export function formatAssistSaved(listings: readonly AssistSavedListing[]): string {
  if (listings.length === 0) return "(none)";
  return listings.map((item) => `${item.name} | ${item.connection}\n${item.sql}`).join("\n\n");
}

/** Adds the query, or removes it when it is already attached. */
export function toggleAssistSaved(selected: readonly AssistSavedPick[], pick: AssistSavedPick): AssistSavedPick[] {
  if (selected.some((item) => item.id === pick.id)) return selected.filter((item) => item.id !== pick.id);
  return [...selected, pick];
}

export interface AssistSavedAsk {
  /** What the person sees in the thread. */
  readonly display: string;
  /** What the model reads. */
  readonly question: string;
}

/**
 * The question that goes with the attached queries.
 * An empty draft still asks about those queries.
 */
export function assistSavedAsk(draft: string, saved: readonly { readonly name: string }[]): AssistSavedAsk {
  const typed = draft.trim();
  if (saved.length === 0) {
    const text = clip(typed);
    return { display: text, question: text };
  }
  const names = saved
    .map((item) => item.name.trim())
    .filter((name) => name !== "")
    .join(", ");
  const lead = typed === "" ? "Analyze these saved queries." : typed;
  const display = clip(names === "" ? lead : `${lead}\n\n${names}`);
  const question = clip(`${display}\n\nExplain what these saved queries show.`);
  return { display, question };
}
