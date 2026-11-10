import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { guardRoute } from "@/lib/api/require-session";
import { queryEventRequest } from "@/lib/query-events/route-events";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { storageOwnerKey } from "@/lib/storage/owner-key";
import type { DatabaseConnection } from "@/lib/types";
import {
  sourceForFields,
  planDashboardShare,
  shareRefreshSeconds,
  withSnapshotQueries,
} from "@/lib/dashboards/share-plan";
import { readSharePublish } from "@/lib/dashboards/share-request";
import { newShareId, readShare, writeShare, type ShareRecord } from "@/lib/dashboards/share-record";
import { writeShareTables, type ShareSheet } from "@/lib/dashboards/share-file";
import { runShareSource } from "@/lib/dashboards/share-source";
import { shareErrorResponse } from "@/lib/dashboards/share-http";
import { SHARE_TIMEOUT_MS, ShareNotFoundError } from "@/lib/dashboards/share-limits";

/**
 * POST /api/share
 *
 * Copy the dashboard's queries into one DuckDB file and return the id of the link.
 * Sending an id replaces a snapshot this session already published. The visitor's
 * link never receives a source connection.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/share", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    // The same gate as every other database route: a connection on the request is resolved
    // before the snapshot is built. The charts' own connections are resolved below.
    if (body.connection !== undefined || body.connectionId !== undefined) {
      await resolveConnection(body as { connection?: DatabaseConnection; connectionId?: string }, guard.session);
    }
    const parsed = readSharePublish(body);
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

    const plan = planDashboardShare(parsed.dashboard, parsed.charts, parsed.connections);
    if (typeof plan === "string") return NextResponse.json({ error: plan }, { status: 400 });

    const ownerKey = storageOwnerKey(guard.session);
    const existing = parsed.id === undefined ? null : readShare(parsed.id);
    if (parsed.id !== undefined && (existing === null || existing.ownerKey !== ownerKey)) {
      throw new ShareNotFoundError();
    }

    const events = queryEventRequest("editor", guard.session, req);
    const signal = AbortSignal.timeout(SHARE_TIMEOUT_MS);
    const columns = new Map<string, string[]>();
    const sheets: ShareSheet[] = [];
    for (const source of plan.sources) {
      const supplied = parsed.connections.find((item) => item.id === source.connectionId);
      if (supplied === undefined) throw new ShareNotFoundError();
      // oxlint-disable-next-line no-await-in-loop -- each chart runs after the previous one, under the one snapshot budget.
      const connection = await resolveConnection({ connection: supplied }, guard.session);
      // oxlint-disable-next-line no-await-in-loop -- each chart runs after the previous one, under the one snapshot budget.
      let rows = await runShareSource(guard.session, connection, source.openedSql, source.label, signal, events);
      const picked = sourceForFields(source, rows.fields);
      if (picked.sql !== source.openedSql) {
        // oxlint-disable-next-line no-await-in-loop -- the baked query runs only when the opened rows cannot answer a filter.
        rows = await runShareSource(guard.session, connection, picked.sql, source.label, signal, events);
      }
      columns.set(source.table, rows.fields);
      sheets.push({ table: source.table, fields: rows.fields, rows: rows.rows });
    }

    const finished = withSnapshotQueries(plan, columns);
    const id = parsed.id ?? newShareId();
    const now = new Date().toISOString();
    const session = guard.session;
    const refreshSeconds = shareRefreshSeconds(
      parsed.charts,
      plan.dashboard.charts.map((frame) => frame.chartId),
    );
    const record: ShareRecord = {
      id,
      name: plan.dashboard.name.trim() || "Dashboard",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      refreshedAt: now,
      ownerKey,
      owner: {
        username: session.username,
        role: session.role,
        ...(session.idpSubject !== undefined ? { idpSubject: session.idpSubject } : {}),
        ...(session.idpIssuer !== undefined ? { idpIssuer: session.idpIssuer } : {}),
      },
      dashboard: { ...plan.dashboard, id, name: plan.dashboard.name.trim() || "Dashboard" },
      charts: finished.charts,
      sources: finished.sources,
      tables: finished.sources.map((source) => source.table),
      ...(refreshSeconds === undefined ? {} : { refreshSeconds }),
    };
    await writeShareTables(id, sheets);
    writeShare(record);
    return NextResponse.json({ id, refreshedAt: now, frozen: finished.frozen });
  } catch (error) {
    return shareErrorResponse(error, "POST /api/share");
  }
}
