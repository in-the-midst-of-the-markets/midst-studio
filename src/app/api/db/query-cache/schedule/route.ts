import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { readScheduleBody } from "@/lib/query-cache/schedule";
import { setCachePaused, setCacheRefresh, withQueryCache } from "@/lib/query-cache/store";
import type { CachePause, CacheSchedule } from "@/lib/query-cache/schedule";

/** A pause request carries `paused` and no refresh fields, so the schedule fields stay typed. */
function isCachePause(value: CacheSchedule | CachePause): value is CachePause {
  return "paused" in value && !("refreshSeconds" in value);
}

/**
 * POST /api/db/query-cache/schedule
 *
 * Set how often one cached table reruns its source, or clear that interval.
 * The file is chosen from the session. The rows stay as they are.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/query-cache/schedule", bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    const parsed = readScheduleBody(body);
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
    if (isCachePause(parsed)) {
      const saved = await withQueryCache(guard.session.username, (runner) =>
        setCachePaused(runner, parsed.tableName, parsed.paused),
      );
      if (!saved) {
        return NextResponse.json({ error: "Cache the table before scheduling a refresh." }, { status: 404 });
      }
      return NextResponse.json({ tableName: parsed.tableName, paused: parsed.paused });
    }
    const saved = await withQueryCache(guard.session.username, (runner) =>
      setCacheRefresh(runner, parsed.tableName, parsed.refreshSeconds, parsed.refreshMinute, parsed.refreshStartsOn),
    );
    if (!saved) {
      return NextResponse.json({ error: "Cache the table before scheduling a refresh." }, { status: 404 });
    }
    return NextResponse.json({
      tableName: parsed.tableName,
      refreshSeconds: parsed.refreshSeconds,
      ...(parsed.refreshMinute === null ? {} : { refreshMinute: parsed.refreshMinute }),
      ...(parsed.refreshStartsOn === null ? {} : { refreshStartsOn: parsed.refreshStartsOn }),
    });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/db/query-cache/schedule" });
  }
}
