import { pageOptionError } from "@/lib/api/page-probe";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { savedQueryTableIdError } from "@/lib/saved-query-id";
import { SAVED_JOIN_MAX_SQL_CHARS } from "./limits";
import type { SavedJoinPage } from "./run";
import type { SavedJoinSource } from "./run";

export interface SavedJoinBody {
  sql: string;
  saved: SavedJoinSource[];
  page: SavedJoinPage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConnection(value: unknown): DatabaseConnection | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (typeof value.type !== "string" || value.type === "") return null;
  return value as unknown as DatabaseConnection;
}

/**
 * The join request, or the sentence that refuses it.
 *
 * `saved` is the editor's catalog. A missing connection stays on the entry as null so the
 * runner can say which saved query needs to be saved again, instead of pretending it
 * was never saved.
 */
export function readSavedJoinBody(body: Record<string, unknown>): SavedJoinBody | string {
  const { sql, saved, options } = body;
  if (typeof sql !== "string" || sql.trim() === "") return "sql must be a non-empty string";
  if (sql.length > SAVED_JOIN_MAX_SQL_CHARS) {
    return `The statement is longer than ${SAVED_JOIN_MAX_SQL_CHARS.toLocaleString("en-US")} characters.`;
  }
  if (!Array.isArray(saved)) return "saved must be an array of saved queries";
  if (saved.length > 50) return "A join can use at most 50 saved queries.";

  const sources: SavedJoinSource[] = [];
  for (const entry of saved) {
    if (!isRecord(entry)) return "Each saved query needs a name and a query.";
    if (typeof entry.name !== "string" || entry.name === "") return "Each saved query needs an ID.";
    const idError = savedQueryTableIdError(entry.name);
    if (idError !== null) return idError;
    if (typeof entry.query !== "string") return `Saved query "${entry.name}" needs its query text.`;
    const connection = readConnection(entry.connection);
    const connectionId =
      typeof entry.connectionId === "string" && entry.connectionId !== "" ? entry.connectionId : undefined;
    sources.push({ name: entry.name, query: entry.query, connection, connectionId });
  }

  const pageOptions = options === undefined ? { limit: DEFAULT_QUERY_LIMIT, offset: 0 } : options;
  if (!isRecord(pageOptions)) return "options must be an object";
  const optionError = pageOptionError(pageOptions);
  if (optionError !== null) return optionError;
  if (pageOptions.unlimited !== undefined && typeof pageOptions.unlimited !== "boolean") {
    return "options.unlimited must be a boolean";
  }
  return {
    sql,
    saved: sources,
    page: {
      limit: typeof pageOptions.limit === "number" ? pageOptions.limit : DEFAULT_QUERY_LIMIT,
      offset: typeof pageOptions.offset === "number" ? pageOptions.offset : 0,
      unlimited: pageOptions.unlimited === true,
    },
  };
}
