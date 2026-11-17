import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDataDir } from "@/lib/data-dir";

/** The directory that holds one DuckDB file per user. It is not a connection a caller may open. */
export function queryCacheDir(): string {
  return path.resolve(getDataDir(), "query-cache");
}

/**
 * This user's cache file.
 *
 * The hash is the identity. The readable prefix is only so a directory listing is
 * recognizable, and two names that sanitize to the same text still get different files.
 */
export function queryCacheFile(username: string): string {
  const hash = createHash("sha256").update(username).digest("hex").slice(0, 16);
  const safe = username.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return path.join(queryCacheDir(), `${safe.length > 0 ? safe : "user"}-${hash}.duckdb`);
}

function canonical(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(candidate);
    return path.join(canonical(parent), path.basename(candidate));
  }
}

/**
 * Whether `candidate` is the cache directory or a file inside it.
 *
 * A caller-supplied DuckDB or SQLite path that lands here would open someone else's
 * cached rows. The query-cache connection never takes that path from the request.
 */
export function isInsideQueryCache(candidate: string): boolean {
  if (candidate.includes("\0")) return false;
  let resolved: string;
  try {
    resolved = canonical(path.resolve(candidate));
  } catch {
    return false;
  }
  const root = canonical(queryCacheDir());
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
