import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { removeProvider } from "@/lib/db/factory";
import { readCacheBody, type CacheWrite } from "@/lib/query-cache/body";
import { QUERY_CACHE_ID } from "@/lib/query-cache/connection";
import { readCacheRefresh } from "@/lib/query-cache/schedule";
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
    let write: CacheWrite = parsed;
    if ("refreshSeconds" in body) {
      const refreshSeconds = readCacheRefresh(body.refreshSeconds);
      if (typeof refreshSeconds === "string") return NextResponse.json({ error: refreshSeconds }, { status: 400 });
      write = { ...parsed, refreshSeconds };
    }
    // DuckDB keeps one writable handle per file. The editor's Query cache provider
    // is that handle, and this write opens the file itself, so the editor handle
    // is closed first. A second one would checkpoint its own catalog over the file.
    // Every open Query cache handle shares this connection id, so they all close;
    // the next read opens the file again.
    await removeProvider(QUERY_CACHE_ID);
    const result = await withQueryCache(guard.session.username, (runner) => cacheQueryResult(runner, write));
    return NextResponse.json(result);
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/db/query-cache" });
  }
}
