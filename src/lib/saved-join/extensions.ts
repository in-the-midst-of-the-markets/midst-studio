/**
 * The two DuckDB extensions a saved join loads: signed `vss`, and community `duckpgq`.
 *
 * They are fetched once, for the engine's own version and platform, and cached as files.
 * The saved-join handle loads those files and then turns external access off. Nothing here
 * turns auto-install on, and a statement never chooses the URL.
 */

import { gunzipSync } from "node:zlib";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDBClient } from "@/lib/db/providers/sql/duckdb/client";

export interface JoinExtensionFiles {
  readonly signed: readonly string[];
  readonly community: readonly string[];
}

export interface ExtensionFetch {
  (
    url: string,
    init?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
}

export interface ExtensionRequest {
  readonly version: string;
  readonly platform: string;
  readonly fetch: ExtensionFetch;
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
}

const VERSION = /^v\d+\.\d+\.\d+$/u;
const PLATFORM = /^[a-z0-9_]+$/u;

const CACHE_ROOT = join(tmpdir(), "knowsql-duckdb-extensions");

let pending: Promise<JoinExtensionFiles> | null = null;

/** Drop the cached lookup. Tests use this so one file does not keep another's download. */
export function resetJoinExtensionFiles(): void {
  pending = null;
}

/**
 * The extension files for this process's DuckDB, downloaded on the first call.
 * A missing build is an empty list for that extension, and the join still runs.
 */
export function joinExtensionFiles(
  signal?: AbortSignal,
  locate: (signal?: AbortSignal) => Promise<JoinExtensionFiles> = locateJoinExtensions,
): Promise<JoinExtensionFiles> {
  if (pending === null) {
    pending = locate(signal).catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

async function locateJoinExtensions(signal?: AbortSignal): Promise<JoinExtensionFiles> {
  // v1.5.6 refuses a read-only in-memory database, so the probe is a writable handle with
  // external access already off. It only reads version() and pragma_platform().
  const client = await openDuckDBClient(":memory:", { readOnly: false, denyExternalAccess: true });
  try {
    const versionRow = await client.run("SELECT version() AS version");
    const platformRow = await client.run("SELECT * FROM pragma_platform()");
    const version = String(versionRow.rows[0]?.version ?? "");
    const platform = String(Object.values(platformRow.rows[0] ?? {})[0] ?? "");
    return await extensionsFor({
      version,
      platform,
      fetch: (url, init) => fetch(url, init),
      cacheRoot: CACHE_ROOT,
      signal,
    });
  } finally {
    client.close();
  }
}

function extensionUrl(kind: "vss" | "duckpgq", version: string, platform: string): string {
  const host = kind === "vss" ? "https://extensions.duckdb.org" : "https://community-extensions.duckdb.org";
  return `${host}/${version}/${platform}/${kind}.duckdb_extension.gz`;
}

async function cachedFile(request: ExtensionRequest, kind: "vss" | "duckpgq"): Promise<string | null> {
  const directory = join(request.cacheRoot, request.version, request.platform);
  const file = join(directory, `${kind}.duckdb_extension`);
  try {
    const info = await stat(file);
    if (info.size > 0) return file;
  } catch {
    // Not cached yet.
  }
  if (request.signal?.aborted) return null;
  let response: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> };
  try {
    response = await request.fetch(extensionUrl(kind, request.version, request.platform), {
      signal: request.signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let bytes: Buffer;
  try {
    bytes = gunzipSync(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  await mkdir(directory, { recursive: true });
  // A pid in the temporary name keeps two joins downloading the same build from deleting
  // each other's file before the rename.
  const temporary = `${file}.${process.pid}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
  return file;
}

/** Resolve both extension files from the version and platform the caller measured. */
export async function extensionsFor(request: ExtensionRequest): Promise<JoinExtensionFiles> {
  if (!VERSION.test(request.version) || !PLATFORM.test(request.platform)) {
    return { signed: [], community: [] };
  }
  const signed = await cachedFile(request, "vss");
  const community = await cachedFile(request, "duckpgq");
  return {
    signed: signed === null ? [] : [signed],
    community: community === null ? [] : [community],
  };
}
