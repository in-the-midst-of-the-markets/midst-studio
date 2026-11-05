import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { runEditorQuery } from "@/lib/api/editor-query";
import { editorProvider } from "@/lib/api/editor-provider";
import { SeedConnectionError, resolveConnection } from "@/lib/seed/resolve-connection";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { queryEventStart } from "@/lib/query-events/build";
import { queryEventRequest, recordExecutedUnit, recordRefusedRequest } from "@/lib/query-events/route-events";
import type { UserPayload } from "@/lib/auth";
import type { DatabaseConnection } from "@/lib/types";
import { readSavedJoinBody } from "@/lib/saved-join/body";
import {
  SAVED_JOIN_LIMITS,
  SAVED_JOIN_TIMEOUT_MS,
  SavedJoinError,
  sourceRowLimitMessage,
} from "@/lib/saved-join/limits";
import { runSavedJoin, type SavedJoinSource } from "@/lib/saved-join/run";
import { sourceReadRefusal } from "@/lib/saved-join/source-guard";
import type { QueryEventRequest } from "@/lib/query-events/route-events";

/**
 * POST /api/db/saved-join
 *
 * The statement is DuckDB. Each `saved.<id>` table is a saved query, run first on the
 * connection it was saved from, under that connection's own limits. Only the finished rows
 * are loaded into a private in-memory DuckDB, which then runs the statement.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/saved-join", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  const events = queryEventRequest("editor", guard.session, req);
  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    // The same gate as every other database route: a connection on the request is resolved before
    // anything is built. The join's own targets are the saved entries below; this is the connection
    // the request itself names, which is what a probe of this route sends.
    if (body.connection !== undefined || body.connectionId !== undefined) {
      await resolveConnection(body as { connection?: DatabaseConnection; connectionId?: string }, guard.session);
    }
    const parsed = readSavedJoinBody(body);
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(SAVED_JOIN_TIMEOUT_MS)]);
    const result = await runSavedJoin({
      sql: parsed.sql,
      saved: parsed.saved,
      page: parsed.page,
      signal,
      limits: SAVED_JOIN_LIMITS,
      runSource: (source, sourceSignal) => runSavedSource(source, sourceSignal, guard.session, events),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SavedJoinError) return NextResponse.json({ error: error.message }, { status: 400 });
    return createErrorResponse(error, { route: "POST /api/db/saved-join" });
  }
}

async function runSavedSource(
  source: SavedJoinSource,
  signal: AbortSignal,
  session: UserPayload,
  events: QueryEventRequest,
): Promise<{ fields: string[]; rows: Record<string, unknown>[] }> {
  const started = queryEventStart();
  let connection: DatabaseConnection | undefined;
  try {
    connection = await resolveConnection(
      source.connectionId !== undefined
        ? { connectionId: source.connectionId }
        : { connection: source.connection ?? undefined },
      session,
    );
    const refusal = sourceReadRefusal(connection.type, source.query);
    if (refusal !== null) throw new SavedJoinError(`Saved query "${source.name}": ${refusal}`);

    admitQueryExecution();
    const provider = await editorProvider(session, connection, undefined);
    const answered = await runEditorQuery(provider, {
      statement: source.query,
      options: { limit: SAVED_JOIN_LIMITS.maxSourceRows },
      signal,
      route: "api/db/saved-join",
    });
    recordExecutedUnit(events, {
      connection,
      statement: source.query,
      started,
      ended: { rowCount: answered.body.rowCount },
    });
    if (answered.body.pagination.hasMore || answered.body.rows.length > SAVED_JOIN_LIMITS.maxSourceRows) {
      throw new SavedJoinError(sourceRowLimitMessage(source.name, SAVED_JOIN_LIMITS.maxSourceRows));
    }
    return { fields: answered.body.fields, rows: answered.body.rows };
  } catch (error) {
    if (error instanceof SeedConnectionError) {
      recordRefusedRequest(events, {
        requestedId: source.connectionId ?? source.connection?.id,
        connection,
        statement: source.query,
        started,
        error,
      });
    } else if (connection !== undefined && !(error instanceof SavedJoinError)) {
      recordExecutedUnit(events, { connection, statement: source.query, started, ended: { error } });
    }
    throw error;
  }
}
