/**
 * The DuckDB type a cached column is stored as, chosen from the values already loaded.
 *
 * JSON has already crossed the wire, so a date is a string and a bigint is a number or
 * a string. A column that mixes kinds is text, which still round-trips.
 */

export type CacheColumnType = "BOOLEAN" | "BIGINT" | "DOUBLE" | "VARCHAR";

export function columnType(values: readonly unknown[]): CacheColumnType {
  let chosen: CacheColumnType | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const next = valueType(value);
    if (chosen === null) {
      chosen = next;
      continue;
    }
    if (chosen === next) continue;
    if ((chosen === "BIGINT" && next === "DOUBLE") || (chosen === "DOUBLE" && next === "BIGINT")) {
      chosen = "DOUBLE";
      continue;
    }
    return "VARCHAR";
  }
  return chosen ?? "VARCHAR";
}

function valueType(value: unknown): CacheColumnType {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return "BIGINT";
    return "DOUBLE";
  }
  return "VARCHAR";
}

/** A value bound to a column of `type`. Anything that does not fit that type is NULL. */
export function bindValue(value: unknown, type: CacheColumnType): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (type === "BOOLEAN") return value === true;
  if (type === "BIGINT" || type === "DOUBLE") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    return type === "BIGINT" ? Math.trunc(numeric) : numeric;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
