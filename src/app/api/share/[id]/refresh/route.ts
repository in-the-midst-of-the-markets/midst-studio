import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { guardRoute } from "@/lib/api/require-session";
import { queryEventRequest } from "@/lib/query-events/route-events";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { storageOwnerKey } from "@/lib/storage/owner-key";
import type { DatabaseConnection } from "@/lib/types";
import { shareErrorResponse } from "@/lib/dashboards/share-http";
import { SHARE_TIMEOUT_MS, ShareNotFoundError } from "@/lib/dashboards/share-limits";
import { readShare } from "@/lib/dashboards/share-record";
import { loadShareOwnerConnections, refreshShareIfDue } from "@/lib/dashboards/share-refresh";
import { runShareSource } from "@/lib/dashboards/share-source";

/**
 * POST /api/share/[id]/refresh
 *
 * The owner reruns the snapshot's stored queries. Connections in the body are
 * the ones the open app already holds. Without them, the server uses the owner's
 * stored connections. A visitor cannot call this.
 */
export async function POST(request: NextRequest, context?: { params: Promise<{ id: string }> }) {
  const guard = await guardRoute({ route: "POST /api/share/[id]/refresh", bucket: "query", request });
  if ("response" in guard) return guard.response;

  try {
    const body = await readJsonObject(request);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    if (body.connection !== undefined || body.connectionId !== undefined) {
      await resolveConnection(body as { connection?: DatabaseConnection; connectionId?: string }, guard.session);
    }
    const id = context === undefined ? "" : (await context.params).id;
    const record = readShare(id);
    if (record === null || record.ownerKey !== storageOwnerKey(guard.session)) throw new ShareNotFoundError();
    const supplied = Array.isArray(body.connections)
      ? body.connections.filter(
          (item): item is DatabaseConnection =>
            typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
        )
      : null;
    const events = queryEventRequest("editor", guard.session, request);
    const signal = AbortSignal.timeout(SHARE_TIMEOUT_MS);
    const next = await refreshShareIfDue(
      record,
      {
        now: () => Date.now(),
        loadConnections: async () => (supplied === null ? loadShareOwnerConnections(record.ownerKey) : supplied),
        resolve: (connection, session) => resolveConnection({ connection }, session),
        run: (connection, sql, label, session) => runShareSource(session, connection, sql, label, signal, events),
      },
      body.force === true,
    );
    return NextResponse.json({ refreshedAt: next.refreshedAt });
  } catch (error) {
    return shareErrorResponse(error, "POST /api/share/[id]/refresh");
  }
}
