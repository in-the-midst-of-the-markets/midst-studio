/**
 * The model choice AI Assist keeps in this browser.
 *
 * The API keys stay in localStorage on this machine. They are not a workspace
 * collection, so the storage sync does not copy them to the server.
 */

import { ASSIST_HISTORY_DEFAULT, ASSIST_HISTORY_MAX, ASSIST_SOURCES, type AssistSource } from "@/lib/ai/assist-plan";

export interface AssistModelOption {
  readonly id: string;
  readonly name: string;
  /** The dated slug OpenRouter ranks, when it is not the same as `id`. */
  readonly canonicalSlug?: string;
  /** The catalog said this model can call a web search tool. */
  readonly webSearch?: boolean;
}

export interface AssistSettings {
  readonly source: AssistSource;
  readonly openRouterModel: string;
  readonly fireworksModel: string;
  readonly gatewayModel: string;
  readonly openRouterKey: string;
  readonly fireworksKey: string;
  readonly gatewayKey: string;
  /** How many earlier questions the next message sends with it. */
  readonly historyMessages: number;
}

export const COMMON_OPENROUTER_MODELS: readonly AssistModelOption[] = [
  { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
  { id: "z-ai/glm-5.3", name: "GLM 5.3" },
  { id: "openai/gpt-4o", name: "GPT-4o" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek" },
];

export const DEFAULT_ASSIST_SETTINGS: AssistSettings = {
  source: "openrouter",
  openRouterModel: COMMON_OPENROUTER_MODELS[0].id,
  fireworksModel: "",
  gatewayModel: "",
  openRouterKey: "",
  fireworksKey: "",
  gatewayKey: "",
  historyMessages: ASSIST_HISTORY_DEFAULT,
};

const STORAGE_KEY = "libredb_ai_assist";
/** The OpenRouter model this browser used before DeepSeek V4.1 Flash became the default. */
const PREVIOUS_OPENROUTER_MODEL = "z-ai/glm-5.3";

function chosenOpenRouterModel(value: string): string {
  if (value === "" || value === PREVIOUS_OPENROUTER_MODEL) return DEFAULT_ASSIST_SETTINGS.openRouterModel;
  return value;
}

let cachedRaw: string | null | undefined;
let cachedSettings: AssistSettings = DEFAULT_ASSIST_SETTINGS;
const listeners = new Set<() => void>();

/** Notifies the page when this browser's choice changes. */
export function subscribeAssistSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function remember(raw: string | null, settings: AssistSettings): AssistSettings {
  cachedRaw = raw;
  cachedSettings = settings;
  return settings;
}

function historyMessagesOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ASSIST_HISTORY_MAX) {
    return ASSIST_HISTORY_DEFAULT;
  }
  return value;
}

function text(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

/** A catalog entry the select can show. Items without an id are dropped. */
export function normalizeModels(value: unknown): AssistModelOption[] {
  if (!Array.isArray(value)) return [];
  const options: AssistModelOption[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id === "") continue;
    const name = "name" in item && typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id;
    const slug = "canonicalSlug" in item && typeof item.canonicalSlug === "string" ? item.canonicalSlug.trim() : "";
    const webSearch = "webSearch" in item && item.webSearch === true;
    const option = slug !== "" && slug !== id ? { id, name, canonicalSlug: slug } : { id, name };
    options.push(webSearch ? { ...option, webSearch: true } : option);
  }
  return options;
}

/** Whether the chosen model was listed as able to search the web. Fireworks has no search tool. */
export function assistModelSearches(
  source: AssistSource,
  modelId: string,
  models: readonly AssistModelOption[],
  gatewayModels: readonly AssistModelOption[],
): boolean {
  if (source === "fireworks") return false;
  const list = source === "gateway" ? gatewayModels : models;
  return list.some((item) => item.id === modelId && item.webSearch === true);
}

function settingsFrom(raw: string | null): AssistSettings {
  if (raw === null) return DEFAULT_ASSIST_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return DEFAULT_ASSIST_SETTINGS;
    const named = "source" in parsed ? parsed.source : undefined;
    const source = ASSIST_SOURCES.find((item) => item === named) ?? "openrouter";
    const openRouterModel = text("openRouterModel" in parsed ? parsed.openRouterModel : undefined, 200);
    const fireworksModel = text("fireworksModel" in parsed ? parsed.fireworksModel : undefined, 200);
    const gatewayModel = text("gatewayModel" in parsed ? parsed.gatewayModel : undefined, 200);
    return {
      source,
      openRouterModel: chosenOpenRouterModel(openRouterModel),
      fireworksModel,
      gatewayModel,
      openRouterKey: text("openRouterKey" in parsed ? parsed.openRouterKey : undefined, 500),
      fireworksKey: text("fireworksKey" in parsed ? parsed.fireworksKey : undefined, 500),
      gatewayKey: text("gatewayKey" in parsed ? parsed.gatewayKey : undefined, 500),
      historyMessages: historyMessagesOf("historyMessages" in parsed ? parsed.historyMessages : undefined),
    };
  } catch {
    return DEFAULT_ASSIST_SETTINGS;
  }
}

/** The saved choice, or the default when nothing usable is stored. */
export function readAssistSettings(): AssistSettings {
  if (typeof localStorage === "undefined") return DEFAULT_ASSIST_SETTINGS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedSettings;
  return remember(raw, settingsFrom(raw));
}

/** Writes the choice. A full disk or a locked browser leaves the previous value. */
export function writeAssistSettings(settings: AssistSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = JSON.stringify(settings);
    localStorage.setItem(STORAGE_KEY, raw);
    remember(raw, settings);
    for (const listener of listeners) listener();
  } catch {
    // The previous choice stays in place when the browser refuses the write.
  }
}
