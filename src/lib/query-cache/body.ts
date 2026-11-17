import { savedQueryTableIdError } from "@/lib/saved-query-id";
import {
  QUERY_CACHE_MAX_FIELD_NAME,
  QUERY_CACHE_MAX_FIELDS,
  QUERY_CACHE_MAX_NAME,
  QUERY_CACHE_MAX_ROWS,
  QUERY_CACHE_MAX_SQL,
  tooManyRowsMessage,
} from "@/lib/query-cache/limits";

/** One cache write, after the request body has been checked. */
export interface CacheWrite {
  tableName: string;
  fields: string[];
  rows: Record<string, unknown>[];
  sourceName: string;
  sourceSql: string;
  sourceConnectionId: string;
}

/** Why `value` cannot be a cached table name, or null when it can. */
export function cacheTableNameError(value: string): string | null {
  const problem = savedQueryTableIdError(value);
  if (problem === null) return null;
  if (value === "") return "Enter a table name. Query cache lists it as a table.";
  return problem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, max: number): string | null {
  if (typeof value !== "string") return `${label} must be text.`;
  if (value.length > max) return `${label} can be at most ${max.toLocaleString("en-US")} characters.`;
  return null;
}

/**
 * Read a cache write from a request body.
 *
 * Returns the sentence to answer with when the body cannot be stored. The table name
 * is one identifier, the rows are the result already loaded, and the source text is
 * what a later refresh runs again.
 */
export function readCacheBody(body: Record<string, unknown>): CacheWrite | string {
  if (typeof body.tableName !== "string") return "Enter a table name. Query cache lists it as a table.";
  const tableName = cacheTableNameError(body.tableName);
  if (tableName !== null) return tableName;

  const sourceName = boundedText(body.sourceName, "The source name", QUERY_CACHE_MAX_NAME);
  if (sourceName !== null) return sourceName;
  const sourceSql = boundedText(body.sourceSql, "The source query", QUERY_CACHE_MAX_SQL);
  if (sourceSql !== null) return sourceSql;
  const sourceConnectionId = boundedText(body.sourceConnectionId, "The source connection", QUERY_CACHE_MAX_NAME);
  if (sourceConnectionId !== null) return sourceConnectionId;

  if (!Array.isArray(body.fields) || body.fields.length === 0) return "This result has no columns to cache.";
  if (body.fields.length > QUERY_CACHE_MAX_FIELDS) {
    return `A cached table can have at most ${QUERY_CACHE_MAX_FIELDS.toLocaleString("en-US")} columns.`;
  }
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const field of body.fields) {
    if (typeof field !== "string" || field === "" || field.includes("\0")) return "A result column needs a name.";
    if (field.length > QUERY_CACHE_MAX_FIELD_NAME) return "A result column name is too long.";
    if (seen.has(field)) return `The result has two columns named ${field}.`;
    seen.add(field);
    fields.push(field);
  }

  if (!Array.isArray(body.rows)) return "The cached rows have to be a list.";
  if (body.rows.length > QUERY_CACHE_MAX_ROWS) return tooManyRowsMessage();
  const rows: Record<string, unknown>[] = [];
  for (const row of body.rows) {
    if (!isRecord(row)) return "Each cached row has to be an object.";
    rows.push(row);
  }

  return {
    tableName: body.tableName,
    fields,
    rows,
    sourceName: body.sourceName as string,
    sourceSql: body.sourceSql as string,
    sourceConnectionId: body.sourceConnectionId as string,
  };
}
