/**
 * OpenRouter and Fireworks, the two model accounts AI Assist calls.
 *
 * Both speak the OpenAI chat-completions shape. The browser may send its own key.
 * When it does not, OpenRouter can use the server's OPENROUTER_API_KEY. A Fireworks
 * key is always the user's: a fine-tuned model lives on their account.
 */

import { LLMAuthError, LLMError, LLMRateLimitError } from "@/lib/llm/types";
import type { AssistSource } from "@/lib/ai/assist-plan";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const FIREWORKS_CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

const MODEL_CAP = 400;

export interface AssistModelOption {
  readonly id: string;
  readonly name: string;
}

export interface AssistChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function messageText(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || !("choices" in payload)) return "";
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (first === null || typeof first !== "object" || !("message" in first)) return "";
  const message = first.message;
  if (message === null || typeof message !== "object" || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string")
        return part.text;
      return "";
    })
    .join("");
}

function chatUrl(source: AssistSource): string {
  return source === "fireworks" ? FIREWORKS_CHAT_URL : OPENROUTER_CHAT_URL;
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
    headers["X-Title"] = "Midst";
  }
  const response = await fetchImpl(chatUrl(input.source), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      temperature: 0.2,
      stream: false,
    }),
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

/** The public OpenRouter catalog, capped and sorted by the name a person reads. */
export async function listOpenRouterModels(fetchImpl: typeof fetch = fetch): Promise<AssistModelOption[]> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!response.ok) throw new LLMError("OpenRouter's model list could not be read.", undefined, 502);
  const payload: unknown = await response.json().catch(() => null);
  const data = payload !== null && typeof payload === "object" && "data" in payload ? payload.data : null;
  if (!Array.isArray(data)) return [];
  const byId = new Map<string, AssistModelOption>();
  for (const item of data) {
    if (item === null || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id === "" || byId.has(id)) continue;
    const name = "name" in item && typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id;
    byId.set(id, { id, name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MODEL_CAP);
}
