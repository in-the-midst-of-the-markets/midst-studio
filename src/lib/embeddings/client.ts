/**
 * Turns text into vectors. Voyage 4 is the hosted default.
 *
 * The call uses the connector key sent with the query (OpenRouter, Fireworks, or
 * Vercel AI Gateway). OpenRouter falls back to the server's OPENROUTER_API_KEY.
 * VOYAGE_API_KEY still calls Voyage directly when neither of those is set.
 * EMBEDDING_API_URL, when set, replaces that choice.
 */

import { isVoyageModel, voyageModelId } from "@/lib/embeddings/models";

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
export const FIREWORKS_EMBEDDINGS_URL = "https://api.fireworks.ai/inference/v1/embeddings";
export const GATEWAY_EMBEDDINGS_URL = "https://ai-gateway.vercel.sh/v1/embeddings";

export const VOYAGE_KEY_ERROR =
  "No API key is available to embed text. Add a key under Connectors, or set OPENROUTER_API_KEY. The query was not sent.";
export const EMBEDDING_KEY_ERROR = "Set EMBEDDING_API_KEY to embed text. The query was not sent.";
export const EMBEDDING_URL_ERROR =
  "Set EMBEDDING_API_URL to embed with a model other than Voyage. The query was not sent.";
export const EMBED_UNREACHABLE_ERROR = "The embedding service could not be reached. The query was not sent.";
export const EMBED_UNREADABLE_ERROR =
  "The embedding service returned a response this app cannot read. The query was not sent.";
export const EMBED_VECTOR_ERROR =
  "The embedding service returned a vector this app cannot use. The query was not sent.";
export const EMBED_COUNT_ERROR =
  "The embedding service returned a different number of vectors than texts. The query was not sent.";
export const EMBED_LENGTH_ERROR =
  "The embedding service returned vectors of different lengths. The query was not sent.";

const VOYAGE_HOST = "api.voyageai.com";
const EMBEDDING_SOURCES = ["openrouter", "fireworks", "gateway"] as const;

type EmbeddingSource = (typeof EMBEDDING_SOURCES)[number];

const PROVIDER_URL: Record<EmbeddingSource, string> = {
  openrouter: OPENROUTER_EMBEDDINGS_URL,
  fireworks: FIREWORKS_EMBEDDINGS_URL,
  gateway: GATEWAY_EMBEDDINGS_URL,
};

export interface EmbeddingEnv {
  readonly VOYAGE_API_KEY?: string;
  readonly EMBEDDING_API_KEY?: string;
  readonly EMBEDDING_API_URL?: string;
  readonly OPENROUTER_API_KEY?: string;
  /** The connector key sent with this query. Empty means the server key. */
  readonly EMBEDDING_KEY?: string;
  readonly EMBEDDING_SOURCE?: string;
}

/**
 * Keys from this process, plus the key a query body sent.
 *
 * OPENROUTER_API_KEY is read through a computed name so a bundler cannot bake in
 * the value from image build time.
 */
export function serverEmbeddingEnv(request?: { readonly apiKey?: string; readonly source?: string }): EmbeddingEnv {
  const openRouter = "OPENROUTER_API_KEY";
  return {
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    EMBEDDING_API_URL: process.env.EMBEDDING_API_URL,
    OPENROUTER_API_KEY: process.env[openRouter],
    EMBEDDING_KEY: request?.apiKey,
    EMBEDDING_SOURCE: request?.source,
  };
}

function embeddingEnv(env?: EmbeddingEnv): EmbeddingEnv {
  if (env !== undefined) return env;
  return serverEmbeddingEnv();
}

/** The part of `fetch` this call uses. A test can pass a function of this shape. */
export type EmbeddingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EmbeddingEndpoint {
  readonly url: string;
  readonly key: string;
  /** Voyage's own API, which takes `input_type`. OpenRouter does not. */
  readonly voyage: boolean;
  /** The model id the provider expects. */
  readonly model: string;
}

function embeddingsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
}

function keyOf(env: EmbeddingEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name as keyof EmbeddingEnv];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function voyageHost(url: string): boolean {
  try {
    return new URL(url).hostname === VOYAGE_HOST;
  } catch {
    return false;
  }
}

function sourceOf(value: string | undefined): EmbeddingSource | undefined {
  if (value === undefined) return undefined;
  return EMBEDDING_SOURCES.find((item) => item === value);
}

/** Voyage on OpenRouter is `voyageai/voyage-4`. Voyage's own API wants the short id. */
function requestModel(model: string, provider: boolean): string {
  if (!provider) return voyageModelId(model);
  if (isVoyageModel(model)) return `voyageai/${voyageModelId(model)}`;
  return model;
}

function providerEndpoint(source: EmbeddingSource, key: string, model: string): EmbeddingEndpoint {
  return { url: PROVIDER_URL[source], key, voyage: false, model: requestModel(model, true) };
}

/** Where this model is embedded, and the key that call uses. */
export function embeddingEndpoint(model: string, env?: EmbeddingEnv): EmbeddingEndpoint | string {
  const source = embeddingEnv(env);
  const override = source.EMBEDDING_API_URL;
  const base = typeof override === "string" ? override.trim() : "";
  if (base !== "") {
    const key = keyOf(source, ["EMBEDDING_API_KEY", "EMBEDDING_KEY", "VOYAGE_API_KEY", "OPENROUTER_API_KEY"]);
    if (key === "") return EMBEDDING_KEY_ERROR;
    const url = embeddingsUrl(base);
    const voyage = isVoyageModel(model) && voyageHost(url);
    return { url, key, voyage, model: requestModel(model, false) };
  }
  const userKey = keyOf(source, ["EMBEDDING_KEY"]);
  if (userKey !== "") return providerEndpoint(sourceOf(source.EMBEDDING_SOURCE) ?? "openrouter", userKey, model);
  const openRouter = keyOf(source, ["OPENROUTER_API_KEY"]);
  if (openRouter !== "") return providerEndpoint("openrouter", openRouter, model);
  if (isVoyageModel(model)) {
    const key = keyOf(source, ["VOYAGE_API_KEY", "EMBEDDING_API_KEY"]);
    if (key === "") return VOYAGE_KEY_ERROR;
    return { url: VOYAGE_EMBEDDINGS_URL, key, voyage: true, model: requestModel(model, false) };
  }
  return EMBEDDING_URL_ERROR;
}

function refused(status: number): string {
  return `The embedding service refused the text (${status}). The query was not sent.`;
}

function readVectors(body: unknown, expected: number): number[][] | string {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    return EMBED_UNREADABLE_ERROR;
  }
  const data = (body as { data: unknown[] }).data;
  const ordered = data
    .map((item, position) => {
      const record =
        typeof item === "object" && item !== null ? (item as { index?: unknown; embedding?: unknown }) : null;
      const index = record !== null && typeof record.index === "number" ? record.index : position;
      return { record, position, index };
    })
    .sort((left, right) => left.index - right.index || left.position - right.position);
  if (ordered.length !== expected) return EMBED_COUNT_ERROR;
  const vectors: number[][] = [];
  let length: number | null = null;
  for (const entry of ordered) {
    const embedding = entry.record?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return EMBED_VECTOR_ERROR;
    const numbers: number[] = [];
    for (const value of embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) return EMBED_VECTOR_ERROR;
      numbers.push(value);
    }
    if (length === null) length = numbers.length;
    else if (numbers.length !== length) return EMBED_LENGTH_ERROR;
    vectors.push(numbers);
  }
  return vectors;
}

export async function embedTexts(
  texts: readonly string[],
  model: string,
  fetchImpl: EmbeddingFetch = fetch,
  env?: EmbeddingEnv,
): Promise<{ ok: true; vectors: number[][] } | { ok: false; error: string }> {
  const endpoint = embeddingEndpoint(model, env);
  if (typeof endpoint === "string") return { ok: false, error: endpoint };
  let response: Response;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${endpoint.key}`,
      "Content-Type": "application/json",
    };
    if (endpoint.url.startsWith("https://openrouter.ai/")) {
      headers["HTTP-Referer"] = "https://midst.market";
      headers["X-Title"] = "KnowSQL";
    }
    response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: [...texts],
        model: endpoint.model,
        ...(endpoint.voyage ? { input_type: "query" } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: EMBED_UNREACHABLE_ERROR };
  }
  if (!response.ok) return { ok: false, error: refused(response.status) };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, error: EMBED_UNREADABLE_ERROR };
  }
  const vectors = readVectors(parsed, texts.length);
  if (typeof vectors === "string") return { ok: false, error: vectors };
  return { ok: true, vectors };
}
