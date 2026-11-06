/**
 * The embedding model this browser uses, per connection.
 *
 * The choice stays in localStorage. It is not a workspace collection, so storage
 * sync does not copy it, and the API key is never stored here.
 */

import { DEFAULT_EMBEDDING_MODEL, normalizeEmbeddingModel } from "@/lib/embeddings/models";

export interface EmbeddingSettings {
  readonly defaultModel: string;
  readonly byConnection: Readonly<Record<string, string>>;
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  defaultModel: DEFAULT_EMBEDDING_MODEL,
  byConnection: {},
};

const STORAGE_KEY = "libredb_embedding";
const CONNECTION_CAP = 200;
const CONNECTION_KEY_MAX = 200;

let cachedRaw: string | null | undefined;
let cachedSettings: EmbeddingSettings = DEFAULT_EMBEDDING_SETTINGS;
const listeners = new Set<() => void>();
/** A test storage. `null` is a browser with no localStorage. Unset, the page uses `localStorage`. */
let storageOverride: Storage | null | undefined;

/** Installs the storage the next read uses, and forgets the previous cache. */
export function setEmbeddingStorage(storage: Storage | null | undefined): void {
  storageOverride = storage;
  cachedRaw = undefined;
  cachedSettings = DEFAULT_EMBEDDING_SETTINGS;
}

function browserStorage(): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  return localStorage;
}

function remember(raw: string | null, settings: EmbeddingSettings): EmbeddingSettings {
  cachedRaw = raw;
  cachedSettings = settings;
  return settings;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function connectionsFrom(value: unknown): Record<string, string> {
  const source = recordOf(value);
  if (source === null) return {};
  const keys = Object.keys(source);
  const kept = keys.length > CONNECTION_CAP ? keys.slice(keys.length - CONNECTION_CAP) : keys;
  const byConnection: Record<string, string> = {};
  for (const key of kept) {
    if (key.trim() === "" || key.length > CONNECTION_KEY_MAX) continue;
    const model = normalizeEmbeddingModel(source[key]);
    if (model !== source[key]) continue;
    byConnection[key] = model;
  }
  return byConnection;
}

function settingsFrom(raw: string | null): EmbeddingSettings {
  if (raw === null) return DEFAULT_EMBEDDING_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = recordOf(parsed);
    if (record === null) return DEFAULT_EMBEDDING_SETTINGS;
    return {
      defaultModel: normalizeEmbeddingModel(record.defaultModel),
      byConnection: connectionsFrom(record.byConnection),
    };
  } catch {
    return DEFAULT_EMBEDDING_SETTINGS;
  }
}

/** Notifies the page when this browser's model changes. */
export function subscribeEmbeddingSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The saved choice, or Voyage 4 when nothing usable is stored. */
export function readEmbeddingSettings(): EmbeddingSettings {
  const storage = browserStorage();
  if (storage === null) return DEFAULT_EMBEDDING_SETTINGS;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_EMBEDDING_SETTINGS;
  }
  if (raw === cachedRaw) return cachedSettings;
  return remember(raw, settingsFrom(raw));
}

function publish(raw: string, settings: EmbeddingSettings): void {
  remember(raw, settings);
  for (const listener of listeners) listener();
}

function withConnection(map: Readonly<Record<string, string>>, id: string, model: string): Record<string, string> {
  const next: Record<string, string> = { ...map, [id]: model };
  const keys = Object.keys(next);
  if (keys.length <= CONNECTION_CAP) return next;
  const oldest = keys[0];
  if (oldest !== undefined) delete next[oldest];
  return next;
}

/** Writes the model for one connection, or the browser default when no connection is named. */
export function writeEmbeddingModel(connectionId: string | undefined, model: string): void {
  const storage = browserStorage();
  if (storage === null) return;
  const settings = readEmbeddingSettings();
  const id = connectionId?.trim() ?? "";
  let next: EmbeddingSettings;
  if (id === "") {
    next = { defaultModel: normalizeEmbeddingModel(model), byConnection: settings.byConnection };
  } else if (model.trim() === "") {
    if (!(id in settings.byConnection)) return;
    const byConnection = { ...settings.byConnection };
    delete byConnection[id];
    next = { defaultModel: settings.defaultModel, byConnection };
  } else {
    next = {
      defaultModel: settings.defaultModel,
      byConnection: withConnection(settings.byConnection, id, normalizeEmbeddingModel(model)),
    };
  }
  try {
    const raw = JSON.stringify(next);
    storage.setItem(STORAGE_KEY, raw);
    publish(raw, next);
  } catch {
    // The previous choice stays when the browser refuses the write.
  }
}

/** The model a connection runs with: its own choice, or the browser default. */
export function embeddingModelFor(connectionId: string | undefined): string {
  const settings = readEmbeddingSettings();
  const id = connectionId?.trim() ?? "";
  if (id !== "") {
    const chosen = settings.byConnection[id];
    if (chosen !== undefined) return chosen;
  }
  return settings.defaultModel;
}
