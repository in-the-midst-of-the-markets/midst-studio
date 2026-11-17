import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { readCacheBody } from "@/lib/query-cache/body";
import { cacheQueryResult, listCachedQueries, withQueryCache } from "@/lib/query-cache/store";

/**
 * GET /api/db/query-cache
 *
 * The tables in this user's query cache: the name, the source query, and when the
 * rows were written. The file is chosen from the session, never from the request.
 */
export async function GET(req: NextRequest) {
  const guard = await guardRoute({ route: "GET /api/db/query-cache", bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const tables = await withQueryCache(guard.session.username, (runner) => listCachedQueries(runner));
    return NextResponse.json({ tables });
  } catch (error) {
    return createErrorResponse(error, { route: "GET /api/db/query-cache" });
  }
}

/**
 * POST /api/db/query-cache
 *
 * Write the rows of a query into a DuckDB table in this user's cache. The same table
 * name replaces the rows already there, which is the refresh: the source is run again
 * by the editor, and this route stores the new result over the old one.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/query-cache", bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    const parsed = readCacheBody(body);
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });
    const result = await withQueryCache(guard.session.username, (runner) => cacheQueryResult(runner, parsed));
    return NextResponse.json(result);
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/db/query-cache" });
  }
}
