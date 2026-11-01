/**
 * The model choice AI Assist keeps in this browser.
 *
 * The API keys stay in localStorage on this machine. They are not a workspace
 * collection, so the storage sync does not copy them to the server.
 */

export interface AssistModelOption {
  readonly id: string;
  readonly name: string;
}

export interface AssistSettings {
  readonly source: "openrouter" | "fireworks";
  readonly openRouterModel: string;
  readonly fireworksModel: string;
  readonly openRouterKey: string;
  readonly fireworksKey: string;
}

export const COMMON_OPENROUTER_MODELS: readonly AssistModelOption[] = [
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
  openRouterKey: "",
  fireworksKey: "",
};

const STORAGE_KEY = "libredb_ai_assist";

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
    options.push({ id, name });
  }
  return options;
}

function settingsFrom(raw: string | null): AssistSettings {
  if (raw === null) return DEFAULT_ASSIST_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return DEFAULT_ASSIST_SETTINGS;
    const source = "source" in parsed && parsed.source === "fireworks" ? "fireworks" : "openrouter";
    const openRouterModel = text("openRouterModel" in parsed ? parsed.openRouterModel : undefined, 200);
    const fireworksModel = text("fireworksModel" in parsed ? parsed.fireworksModel : undefined, 200);
    return {
      source,
      openRouterModel: openRouterModel === "" ? DEFAULT_ASSIST_SETTINGS.openRouterModel : openRouterModel,
      fireworksModel,
      openRouterKey: text("openRouterKey" in parsed ? parsed.openRouterKey : undefined, 500),
      fireworksKey: text("fireworksKey" in parsed ? parsed.fireworksKey : undefined, 500),
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
