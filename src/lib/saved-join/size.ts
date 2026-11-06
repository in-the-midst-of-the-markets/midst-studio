/**
 * How much memory, time, and rows one cross join may use.
 *
 * The request names a size. This catalog is the only place that turns that name into
 * DuckDB limits, so a later charge can refuse a size above the included one without
 * trusting a memory or thread number from the browser. Every size here runs.
 */

import { SAVED_JOIN_LIMITS, type SavedJoinLimits } from "./limits";

export interface JoinSize {
  readonly id: "small" | "medium" | "large";
  readonly name: string;
  readonly detail: string;
  readonly limits: SavedJoinLimits;
}

/** Small is the included size. Medium and large are the sizes a later charge can gate. */
export const JOIN_SIZES: readonly JoinSize[] = [
  { id: "small", name: "Small", detail: "256 MB, 1 thread", limits: SAVED_JOIN_LIMITS },
  {
    id: "medium",
    name: "Medium",
    detail: "1 GB, 2 threads",
    limits: {
      maxSourceRows: 50_000,
      maxResultRows: 50_000,
      memoryLimit: "1GB",
      threads: 2,
      timeoutMs: 30_000,
    },
  },
  {
    id: "large",
    name: "Large",
    detail: "4 GB, 4 threads",
    limits: {
      maxSourceRows: 200_000,
      maxResultRows: 200_000,
      memoryLimit: "4GB",
      threads: 4,
      timeoutMs: 60_000,
    },
  },
];

export const DEFAULT_JOIN_SIZE_ID = "small";

export const JOIN_SIZE_ERROR = "size must be small, medium, or large.";

/** The engine budget for a request. An omitted size is the included one. Anything else is refused. */
export function limitsForJoinSize(value: unknown): SavedJoinLimits | string {
  if (value === undefined) return SAVED_JOIN_LIMITS;
  if (typeof value !== "string") return JOIN_SIZE_ERROR;
  const found = JOIN_SIZES.find((size) => size.id === value);
  if (found === undefined) return JOIN_SIZE_ERROR;
  return found.limits;
}
