/**
 * Replaces quoted `{{embed "text"}}` tokens with a JSON array of numbers before
 * a statement is sent. The text the user wrote stays in the query event.
 */

import { embedTexts, serverEmbeddingEnv, type EmbeddingEnv, type EmbeddingFetch } from "@/lib/embeddings/client";
import { embeddingModelOf, normalizeEmbeddingModel } from "@/lib/embeddings/models";
import {
  bindEmbedPlaceholders,
  embedTokens,
  spliceEmbeddingVectors,
  type EmbedNameValue,
} from "@/lib/embeddings/placeholder";

export const EMBED_TEXT_CAP = 4000;
export const EMBED_PLACEHOLDER_CAP = 32;

export const EMBED_EMPTY_ERROR = "The embed text is empty. The query was not sent.";
export const EMBED_LONG_ERROR = "Embed text is limited to 4000 characters. The query was not sent.";
export const EMBED_TOO_MANY_ERROR = "A query can embed at most 32 texts. The query was not sent.";

export function embedNameError(name: string): string {
  return `There is no text to embed for "${name}". The query was not sent.`;
}

export const EMBED_BINDS_ERROR = 'embeddingBinds must be a list of { "name", "value" } text pairs.';
export const EMBED_KEY_ERROR = "embeddingKey must be text of at most 500 characters. The query was not sent.";
export const EMBED_SOURCE_ERROR = "embeddingSource must be openrouter, fireworks, or gateway. The query was not sent.";

const EMBEDDING_KEY_MAX = 500;
const EMBEDDING_SOURCES = ["openrouter", "fireworks", "gateway"] as const;

/** The id-to-text pairs a query body sent. Absent means the statement carries its own text. */
export function readEmbeddingBinds(
  value: unknown,
): { ok: true; binds: EmbedNameValue[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, binds: [] };
  if (!Array.isArray(value)) return { ok: false, error: EMBED_BINDS_ERROR };
  if (value.length > EMBED_PLACEHOLDER_CAP) return { ok: false, error: EMBED_TOO_MANY_ERROR };
  const binds: EmbedNameValue[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: EMBED_BINDS_ERROR };
    }
    const name = (item as { name?: unknown }).name;
    const text = (item as { value?: unknown }).value;
    if (typeof name !== "string" || typeof text !== "string") return { ok: false, error: EMBED_BINDS_ERROR };
    binds.push({ name, value: text });
  }
  return { ok: true, binds };
}

/** The connector key a query body sent. Absent means the server's own key. */
export function readEmbeddingAuth(
  body: Record<string, unknown>,
): { ok: true; apiKey: string; source?: string } | { ok: false; error: string } {
  const rawKey = body.embeddingKey;
  if (rawKey !== undefined && typeof rawKey !== "string") return { ok: false, error: EMBED_KEY_ERROR };
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (apiKey.length > EMBEDDING_KEY_MAX) return { ok: false, error: EMBED_KEY_ERROR };
  const rawSource = body.embeddingSource;
  if (rawSource === undefined) return { ok: true, apiKey };
  if (typeof rawSource !== "string" || !EMBEDDING_SOURCES.some((item) => item === rawSource)) {
    return { ok: false, error: EMBED_SOURCE_ERROR };
  }
  return { ok: true, apiKey, source: rawSource };
}

/**
 * Fills `{{embed id}}` from the body, then replaces each quoted text with its vector.
 * The statement recorded for the query is still the one the caller passed in.
 */
export async function expandSubmittedEmbeddings(
  sql: string,
  body: Record<string, unknown>,
  fetchImpl: EmbeddingFetch = fetch,
): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const binds = readEmbeddingBinds(body.embeddingBinds);
  if (!binds.ok) return binds;
  const auth = readEmbeddingAuth(body);
  if (!auth.ok) return auth;
  return expandQueryEmbeddings(
    bindEmbedPlaceholders(sql, binds.binds),
    embeddingModelOf(body),
    fetchImpl,
    serverEmbeddingEnv({ apiKey: auth.apiKey, source: auth.source }),
  );
}

/**
 * The statement the user wrote, when one expanded unit still lines up with it.
 * A script whose split changed shape keeps the expanded text rather than a neighbour's.
 */
export function auditTextAt(written: readonly string[], index: number, fallback: string): string {
  return written[index] ?? fallback;
}

export async function expandQueryEmbeddings(
  sql: string,
  model: string,
  fetchImpl: EmbeddingFetch = fetch,
  env?: EmbeddingEnv,
): Promise<{ ok: true; sql: string } | { ok: false; error: string }> {
  const tokens = embedTokens(sql);
  if (tokens.length === 0) return { ok: true, sql };
  if (tokens.length > EMBED_PLACEHOLDER_CAP) return { ok: false, error: EMBED_TOO_MANY_ERROR };
  const texts: string[] = [];
  for (const token of tokens) {
    if (token.kind === "name") return { ok: false, error: embedNameError(token.value) };
    if (token.value.length > EMBED_TEXT_CAP) return { ok: false, error: EMBED_LONG_ERROR };
    if (token.value.trim() === "") return { ok: false, error: EMBED_EMPTY_ERROR };
    texts.push(token.value);
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  const embedded = await embedTexts(unique, normalizeEmbeddingModel(model), fetchImpl, env);
  if (!embedded.ok) return embedded;
  const byText = new Map(unique.map((text, index) => [text, embedded.vectors[index] ?? []]));
  return {
    ok: true,
    sql: spliceEmbeddingVectors(
      sql,
      texts.map((text) => byText.get(text) ?? []),
    ),
  };
}
