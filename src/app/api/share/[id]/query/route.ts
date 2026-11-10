import { NextRequest, NextResponse } from "next/server";
import { clientAddress } from "@/lib/api/client-address";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { RateLimitError, consumeRateLimit } from "@/lib/api/rate-limit";
import { queryEventRequest } from "@/lib/query-events/route-events";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { queryShareFile } from "@/lib/dashboards/share-file";
import { shareErrorResponse } from "@/lib/dashboards/share-http";
import { SHARE_MAX_SQL_CHARS, SHARE_TIMEOUT_MS, ShareNotFoundError } from "@/lib/dashboards/share-limits";
import { ownerSession, readShare } from "@/lib/dashboards/share-record";
import { loadShareOwnerConnections, refreshShareIfDue } from "@/lib/dashboards/share-refresh";
import { readShareQuery } from "@/lib/dashboards/share-request";
import { runShareSource } from "@/lib/dashboards/share-source";
import { isShareId } from "@/lib/dashboards/share-access";

/**
 * POST /api/share/[id]/query
 *
 * Run one SELECT against the snapshot. The id is the only credential. When the
 * board's refresh interval has elapsed, the server reruns the owner's saved
 * queries first and the visitor still receives only the snapshot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isShareId(id)) throw new ShareNotFoundError();
    const notice = consumeRateLimit("query", `${clientAddress(request)}:${id}`);
    if (!notice.allowed) throw new RateLimitError(notice.retryAfterSeconds);
    const body = await readJsonObject(request);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    const sql = readShareQuery(body);
    if (sql === null || sql.trim() === "" || sql.length > SHARE_MAX_SQL_CHARS) {
      return NextResponse.json({ error: "A shared dashboard reads one statement." }, { status: 400 });
    }
    const record = readShare(id);
    if (record === null) throw new ShareNotFoundError();
    const owner = ownerSession(record);
    const events = queryEventRequest("editor", owner, request);
    const signal = AbortSignal.timeout(SHARE_TIMEOUT_MS);
    const current = await refreshShareIfDue(record, {
      now: () => Date.now(),
      loadConnections: loadShareOwnerConnections,
      resolve: (connection, session) => resolveConnection({ connection }, session),
      run: (connection, statement, label, session) =>
        runShareSource(session, connection, statement, label, signal, events),
    });
    const result = await queryShareFile(current.id, sql, current.tables);
    return NextResponse.json(result);
  } catch (error) {
    return shareErrorResponse(error, "POST /api/share/[id]/query");
  }
}
