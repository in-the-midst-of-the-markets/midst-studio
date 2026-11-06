/**
 * Replaces quoted `{{embed "text"}}` tokens with a JSON array of numbers before
 * a statement is sent. The text the user wrote stays in the query event.
 */

import { embedTexts, type EmbeddingFetch } from "@/lib/embeddings/client";
import { normalizeEmbeddingModel } from "@/lib/embeddings/models";
import { embedTokens, spliceEmbeddingVectors } from "@/lib/embeddings/placeholder";

export const EMBED_TEXT_CAP = 4000;
export const EMBED_PLACEHOLDER_CAP = 32;

export const EMBED_EMPTY_ERROR = "The embed text is empty. The query was not sent.";
export const EMBED_LONG_ERROR = "Embed text is limited to 4000 characters. The query was not sent.";
export const EMBED_TOO_MANY_ERROR = "A query can embed at most 32 texts. The query was not sent.";

export function embedNameError(name: string): string {
  return `The dashboard filter "${name}" has no text to embed. The query was not sent.`;
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
  const embedded = await embedTexts(unique, normalizeEmbeddingModel(model), fetchImpl);
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
