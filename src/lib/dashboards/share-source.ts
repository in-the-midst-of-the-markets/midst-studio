import { runEditorQuery } from "@/lib/api/editor-query";
import { editorProvider } from "@/lib/api/editor-provider";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { queryEventStart } from "@/lib/query-events/build";
import { recordExecutedUnit, recordRefusedRequest, type QueryEventRequest } from "@/lib/query-events/route-events";
import { sourceReadRefusal } from "@/lib/saved-join/source-guard";
import type { UserPayload } from "@/lib/auth";
import type { DatabaseConnection } from "@/lib/types";
import { SHARE_MAX_SOURCE_ROWS, ShareError, shareRowLimitMessage } from "./share-limits";

export interface ShareSheetRows {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
}

/**
 * Run one dashboard query on the connection it was saved with.
 * The statement has to be a single read. A result past the row cap is refused
 * rather than copied in part.
 */
export async function runShareSource(
  session: UserPayload,
  connection: DatabaseConnection,
  sql: string,
  label: string,
  signal: AbortSignal,
  events: QueryEventRequest,
): Promise<ShareSheetRows> {
  const refused = sourceReadRefusal(connection.type, sql);
  if (refused !== null) throw new ShareError(`${label}: ${refused}`);
  const started = queryEventStart();
  try {
    admitQueryExecution();
    const provider = await editorProvider(session, connection, undefined);
    const answered = await runEditorQuery(provider, {
      statement: sql,
      options: { limit: SHARE_MAX_SOURCE_ROWS },
      signal,
      route: "api/share",
    });
    recordExecutedUnit(events, {
      connection,
      statement: sql,
      started,
      ended: { rowCount: answered.body.rowCount },
    });
    if (answered.body.pagination?.hasMore || answered.body.rows.length > SHARE_MAX_SOURCE_ROWS) {
      throw new ShareError(shareRowLimitMessage(label));
    }
    if (answered.body.fields.length === 0) throw new ShareError(`${label} returned no columns.`);
    return { fields: answered.body.fields, rows: answered.body.rows };
  } catch (error) {
    if (error instanceof ShareError) throw error;
    if (error instanceof SeedConnectionError) {
      recordRefusedRequest(events, { requestedId: connection.id, connection, statement: sql, started, error });
      throw error;
    }
    recordExecutedUnit(events, { connection, statement: sql, started, ended: { error } });
    const message = error instanceof Error ? error.message : "The query failed.";
    throw new ShareError(`${label}: ${message}`);
  }
}
