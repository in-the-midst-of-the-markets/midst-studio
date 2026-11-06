/**
 * The cross-join size this browser asks for.
 *
 * The choice stays in localStorage. The server still maps the name to a budget, so a
 * stored value this catalog does not know falls back to the included size.
 */

import { DEFAULT_JOIN_SIZE_ID, JOIN_SIZES } from "@/lib/saved-join/size";

const STORAGE_KEY = "libredb_join_size";

let cachedRaw: string | null | undefined;
let cachedId: string = DEFAULT_JOIN_SIZE_ID;
const listeners = new Set<() => void>();
/** A test storage. `null` is a browser with no localStorage. Unset, the page uses `localStorage`. */
let storageOverride: Storage | null | undefined;

/** Installs the storage the next read uses, and forgets the previous cache. */
export function setJoinSizeStorage(storage: Storage | null | undefined): void {
  storageOverride = storage;
  cachedRaw = undefined;
  cachedId = DEFAULT_JOIN_SIZE_ID;
}

function browserStorage(): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  return localStorage;
}

function knownSize(raw: string | null): string {
  const found = JOIN_SIZES.find((size) => size.id === raw);
  return found?.id ?? DEFAULT_JOIN_SIZE_ID;
}

/** The included size. A server render has no stored choice yet. */
export function includedJoinSize(): string {
  return DEFAULT_JOIN_SIZE_ID;
}

/** The size the next cross join should ask for. */
export function readJoinSizeChoice(): string {
  const storage = browserStorage();
  if (storage === null) return DEFAULT_JOIN_SIZE_ID;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_JOIN_SIZE_ID;
  }
  if (raw === cachedRaw) return cachedId;
  const id = knownSize(raw);
  cachedRaw = raw;
  cachedId = id;
  return id;
}

/** Notifies the page when this browser's size changes. */
export function subscribeJoinSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Remembers a size this server offers. Anything else is left as it was. */
export function writeJoinSizeChoice(value: string): void {
  const found = JOIN_SIZES.find((size) => size.id === value);
  if (found === undefined) return;
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, found.id);
  } catch {
    return;
  }
  cachedRaw = found.id;
  cachedId = found.id;
  for (const listener of listeners) listener();
}
