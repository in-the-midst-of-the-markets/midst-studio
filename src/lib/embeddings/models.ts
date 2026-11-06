/**
 * The embedding model a query's `{{embed}}` placeholder uses.
 *
 * Voyage 4 is the default. A connection can name another model when its vectors
 * were built with something else. The key stays on the server.
 */

export const DEFAULT_EMBEDDING_MODEL = "voyage-4";

export const EMBEDDING_MODEL_OPTIONS: readonly { id: string; name: string }[] = [
  { id: "voyage-4", name: "Voyage 4" },
  { id: "voyage-4-large", name: "Voyage 4 large" },
  { id: "voyage-4-lite", name: "Voyage 4 lite" },
  { id: "voyage-code-4", name: "Voyage code 4" },
];

/** The select value that opens a free-text model id. It is not sent to an API. */
export const CUSTOM_EMBEDDING_CHOICE = "__custom__";

const MODEL_MAX = 128;
const MODEL_PATTERN = /^[A-Za-z0-9_.:@/-]+$/;
const VOYAGE_PREFIX = "voyageai/";

/** A model id the embedding request will accept, or the Voyage 4 default. */
export function normalizeEmbeddingModel(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_EMBEDDING_MODEL;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MODEL_MAX || !MODEL_PATTERN.test(trimmed)) return DEFAULT_EMBEDDING_MODEL;
  if (trimmed === CUSTOM_EMBEDDING_CHOICE) return DEFAULT_EMBEDDING_MODEL;
  return trimmed;
}

/** The id Voyage's API expects. A `voyageai/` prefix is the menu's long form of the same model. */
export function voyageModelId(model: string): string {
  return model.startsWith(VOYAGE_PREFIX) ? model.slice(VOYAGE_PREFIX.length) : model;
}

/** Whether this model is one Voyage hosts. Other models need `EMBEDDING_API_URL`. */
export function isVoyageModel(model: string): boolean {
  return voyageModelId(model).startsWith("voyage-");
}

export function isListedEmbeddingModel(model: string): boolean {
  return EMBEDDING_MODEL_OPTIONS.some((option) => option.id === model);
}

/** The model a query body named, or Voyage 4 when the field is absent or unusable. */
export function embeddingModelOf(body: Record<string, unknown>): string {
  return normalizeEmbeddingModel(body.embeddingModel);
}
