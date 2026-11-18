import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { readScheduleBody } from "@/lib/query-cache/schedule";
import { setCacheRefresh, withQueryCache } from "@/lib/query-cache/store";

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
    const saved = await withQueryCache(guard.session.username, (runner) =>
      setCacheRefresh(runner, parsed.tableName, parsed.refreshSeconds),
    );
    if (!saved) {
      return NextResponse.json({ error: "Cache the table before scheduling a refresh." }, { status: 404 });
    }
    return NextResponse.json({ tableName: parsed.tableName, refreshSeconds: parsed.refreshSeconds });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/db/query-cache/schedule" });
  }
}
