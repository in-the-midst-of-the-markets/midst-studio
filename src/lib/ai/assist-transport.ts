/**
 * OpenRouter, Fireworks, and Vercel AI Gateway. Each speaks the OpenAI
 * chat-completions shape. The browser may send its own key. When it does not,
 * OpenRouter can use the server's OPENROUTER_API_KEY. Fireworks and Vercel AI
 * Gateway always use the key saved in the browser.
 */

import { LLMAuthError, LLMError, LLMRateLimitError } from "@/lib/llm/types";
import type { AssistSource } from "@/lib/ai/assist-plan";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const FIREWORKS_CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
export const GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const MODEL_CAP = 800;

export interface AssistModelOption {
  readonly id: string;
  readonly name: string;
  /** The dated slug OpenRouter ranks, when it is not the same as `id`. */
  readonly canonicalSlug?: string;
}

export interface AssistChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function joinedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string")
        return part.text;
      return "";
    })
    .join("");
}

/**
 * The answer text. A blank `content` falls through to the reasoning fields
 * some models fill instead. A real answer wins over the reasoning trace.
 */
function messageText(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || !("choices" in payload)) return "";
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (first === null || typeof first !== "object" || !("message" in first)) return "";
  const message = first.message;
  if (message === null || typeof message !== "object") return "";
  const fields = message as Record<string, unknown>;
  const content = joinedText(fields.content);
  if (content.trim() !== "") return content;
  const reasoning = joinedText(fields.reasoning);
  if (reasoning.trim() !== "") return reasoning;
  const reasoningContent = joinedText(fields.reasoning_content);
  if (reasoningContent.trim() !== "") return reasoningContent;
  const details = joinedText(fields.reasoning_details);
  if (details.trim() !== "") return details;
  return content;
}

function chatUrl(source: AssistSource): string {
  if (source === "fireworks") return FIREWORKS_CHAT_URL;
  if (source === "gateway") return GATEWAY_CHAT_URL;
  return OPENROUTER_CHAT_URL;
}

/**
 * The server's OpenRouter key, read when a request is handled.
 *
 * The name is computed so a bundler cannot replace it with whatever the image
 * build happened to have. DigitalOcean must set this variable for Run Time;
 * a build-time-only value is not in the running app.
 */
function openRouterServerKey(): string {
  const name = "OPENROUTER_API_KEY";
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** The key the route will send. OpenRouter falls back to the server environment. */
export function resolveAssistKey(source: AssistSource, apiKey: string): string | null {
  const trimmed = apiKey.trim();
  if (trimmed !== "") return trimmed;
  if (source !== "openrouter") return null;
  const configured = openRouterServerKey();
  return configured === "" ? null : configured;
}

/** Whether this process can call OpenRouter without a key from the browser. */
export function assistServerKeyConfigured(): boolean {
  return openRouterServerKey() !== "";
}

/** One non-streaming completion. The key is sent as a bearer token and not written here. */
export async function completeChat(input: {
  readonly source: AssistSource;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly AssistChatMessage[];
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.apiKey}`,
  };
  if (input.source === "openrouter") {
    headers["HTTP-Referer"] = "https://midst.market";
    headers["X-Title"] = "KnowSQL";
  }
  const body: {
    model: string;
    messages: readonly AssistChatMessage[];
    temperature: number;
    stream: false;
    reasoning?: { effort: "max" };
  } = {
    model: input.model,
    messages: input.messages,
    temperature: 0.2,
    stream: false,
  };
  // GLM 5.3's deepest effort is max. The output limit stays unset so the
  // reasoning and the answer share the model's own budget. OpenRouter ignores
  // this field on a model that does not reason.
  if (input.source === "openrouter") body.reasoning = { effort: "max" };
  const response = await fetchImpl(chatUrl(input.source), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LLMAuthError("The model rejected the API key.");
    if (response.status === 429) throw new LLMRateLimitError("The model rate limit was reached.");
    throw new LLMError(`The model request failed (${response.status}).`, undefined, 502);
  }
  const payload: unknown = await response.json().catch(() => null);
  const text = messageText(payload);
  if (text.trim() === "") throw new LLMError("The model returned an empty answer.", undefined, 502);
  return text;
}

function catalogModels(payload: unknown): AssistModelOption[] {
  const data = payload !== null && typeof payload === "object" && "data" in payload ? payload.data : null;
  if (!Array.isArray(data)) return [];
  const byId = new Map<string, AssistModelOption>();
  for (const item of data) {
    if (item === null || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id === "" || byId.has(id)) continue;
    const name = "name" in item && typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id;
    const slug = "canonical_slug" in item && typeof item.canonical_slug === "string" ? item.canonical_slug.trim() : "";
    byId.set(id, slug !== "" && slug !== id ? { id, name, canonicalSlug: slug } : { id, name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MODEL_CAP);
}

async function listModels(url: string, failure: string, fetchImpl: typeof fetch): Promise<AssistModelOption[]> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new LLMError(failure, undefined, 502);
  const payload: unknown = await response.json().catch(() => null);
  return catalogModels(payload);
}

/** The public OpenRouter catalog, capped and sorted by the name a person reads. */
export function listOpenRouterModels(fetchImpl: typeof fetch = fetch): Promise<AssistModelOption[]> {
  return listModels(OPENROUTER_MODELS_URL, "OpenRouter's model list could not be read.", fetchImpl);
}

/** The public Vercel AI Gateway catalog. Ids are the provider/model strings the gateway returns. */
export function listGatewayModels(fetchImpl: typeof fetch = fetch): Promise<AssistModelOption[]> {
  return listModels(GATEWAY_MODELS_URL, "The Vercel AI Gateway model list could not be read.", fetchImpl);
}
