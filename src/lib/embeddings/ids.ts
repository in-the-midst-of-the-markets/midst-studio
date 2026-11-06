/**
 * An embed id the IDE hands the user.
 *
 * The text stays in this browser. The statement keeps `{{embed e1}}`. When the
 * query runs, the id's text is sent beside it and the server turns that text
 * into a vector. The vector itself is never stored here.
 */

import { embeddingModelFor } from "@/lib/embeddings/settings";
import { embedTokens, type EmbedNameValue } from "@/lib/embeddings/placeholder";

const STORAGE_KEY = "libredb_embedding_ids";
const CONNECTION_CAP = 200;
const CONNECTION_KEY_MAX = 200;
const ID_CAP = 64;
const TEXT_CAP = 4000;
const ID_PATTERN = /^e[1-9][0-9]{0,8}$/;
const ID_MAX = 999_999_999;

export const EMBED_ID_EMPTY = "Enter the text to embed.";
export const EMBED_ID_LONG = "Embed text is limited to 4000 characters.";
export const EMBED_ID_CONNECTION = "Choose a connection before embedding text.";
export const EMBED_ID_FULL = "This connection has no embed ids left.";
export const EMBED_ID_UNSAVED = "This browser could not save the embed id.";

interface EmbedEntry {
  readonly id: string;
  readonly text: string;
}

interface EmbedIdStore {
  readonly byConnection: Readonly<Record<string, readonly EmbedEntry[]>>;
}

const EMPTY: EmbedIdStore = { byConnection: {} };

let cachedRaw: string | null | undefined;
let cachedStore: EmbedIdStore = EMPTY;
/** A test storage. `null` is a browser with no localStorage. Unset, the page uses `localStorage`. */
let storageOverride: Storage | null | undefined;

/** Installs the storage the next read uses, and forgets the previous cache. */
export function setEmbeddingIdStorage(storage: Storage | null | undefined): void {
  storageOverride = storage;
  cachedRaw = undefined;
  cachedStore = EMPTY;
}

function browserStorage(): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  return localStorage;
}

function remember(raw: string | null, store: EmbedIdStore): EmbedIdStore {
  cachedRaw = raw;
  cachedStore = store;
  return store;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function entriesFrom(value: unknown): EmbedEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: EmbedEntry[] = [];
  for (const item of value) {
    const record = recordOf(item);
    if (record === null) continue;
    const id = record.id;
    const text = record.text;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) continue;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.length > TEXT_CAP) continue;
    entries.push({ id, text: trimmed });
  }
  return entries.length > ID_CAP ? entries.slice(entries.length - ID_CAP) : entries;
}

function storeFrom(raw: string | null): EmbedIdStore {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = recordOf(parsed);
    if (record === null) return EMPTY;
    const source = recordOf(record.byConnection);
    if (source === null) return EMPTY;
    const keys = Object.keys(source);
    const kept = keys.length > CONNECTION_CAP ? keys.slice(keys.length - CONNECTION_CAP) : keys;
    const byConnection: Record<string, readonly EmbedEntry[]> = {};
    for (const key of kept) {
      if (key.trim() === "" || key.length > CONNECTION_KEY_MAX) continue;
      const entries = entriesFrom(source[key]);
      if (entries.length === 0) continue;
      byConnection[key] = entries;
    }
    return { byConnection };
  } catch {
    return EMPTY;
  }
}

function readStore(): EmbedIdStore {
  const storage = browserStorage();
  if (storage === null) return EMPTY;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cachedRaw) return cachedStore;
  return remember(raw, storeFrom(raw));
}

function nextNumber(entries: readonly EmbedEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    const value = Number(entry.id.slice(1));
    if (value > max) max = value;
  }
  return max + 1;
}

function withConnection(
  map: Readonly<Record<string, readonly EmbedEntry[]>>,
  id: string,
  entries: readonly EmbedEntry[],
): Record<string, readonly EmbedEntry[]> {
  const next: Record<string, readonly EmbedEntry[]> = { ...map, [id]: entries };
  const keys = Object.keys(next);
  if (keys.length <= CONNECTION_CAP) return next;
  const oldest = keys[0];
  if (oldest !== undefined) delete next[oldest];
  return next;
}

/** The id a person pastes into a WHERE clause, `{{embed e1}}`. */
export function embedIdToken(id: string): string {
  return `{{embed ${id}}}`;
}

/**
 * Remembers text for one connection and returns the next id.
 * The same text entered twice gets a new id. An earlier id keeps its own text.
 */
export function createEmbeddingId(
  connectionId: string | undefined,
  text: string,
): { ok: true; id: string; token: string } | { ok: false; error: string } {
  const id = connectionId?.trim() ?? "";
  if (id === "" || id.length > CONNECTION_KEY_MAX) return { ok: false, error: EMBED_ID_CONNECTION };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: EMBED_ID_EMPTY };
  if (trimmed.length > TEXT_CAP) return { ok: false, error: EMBED_ID_LONG };
  const storage = browserStorage();
  if (storage === null) return { ok: false, error: EMBED_ID_UNSAVED };
  const store = readStore();
  const current = store.byConnection[id] ?? [];
  const number = nextNumber(current);
  if (number > ID_MAX) return { ok: false, error: EMBED_ID_FULL };
  const embedId = `e${number}`;
  const entries = [...current, { id: embedId, text: trimmed }];
  const kept = entries.length > ID_CAP ? entries.slice(entries.length - ID_CAP) : entries;
  const next: EmbedIdStore = { byConnection: withConnection(store.byConnection, id, kept) };
  try {
    const raw = JSON.stringify(next);
    storage.setItem(STORAGE_KEY, raw);
    remember(raw, next);
  } catch {
    return { ok: false, error: EMBED_ID_UNSAVED };
  }
  return { ok: true, id: embedId, token: embedIdToken(embedId) };
}

/** The text behind each `{{embed name}}` this connection still remembers. */
export function embeddingBindsFor(connectionId: string | undefined, sql: string): EmbedNameValue[] {
  const id = connectionId?.trim() ?? "";
  if (id === "") return [];
  const entries = readStore().byConnection[id];
  if (entries === undefined) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry.text]));
  const binds: EmbedNameValue[] = [];
  const seen = new Set<string>();
  for (const token of embedTokens(sql)) {
    if (token.kind !== "name" || seen.has(token.value)) continue;
    const text = byId.get(token.value);
    if (text === undefined) continue;
    seen.add(token.value);
    binds.push({ name: token.value, value: text });
  }
  return binds;
}

/** The model and, when the statement names a saved id, the text behind it. */
export function embeddingRequestFields(
  connectionId: string | undefined,
  sql: string,
): { embeddingModel: string; embeddingBinds?: EmbedNameValue[] } {
  const embeddingBinds = embeddingBindsFor(connectionId, sql);
  return {
    embeddingModel: embeddingModelFor(connectionId),
    ...(embeddingBinds.length > 0 ? { embeddingBinds } : {}),
  };
}
