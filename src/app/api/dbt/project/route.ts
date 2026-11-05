import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { guardRoute } from "@/lib/api/require-session";
import { openDbtProject, readDbtRequest } from "@/lib/dbt/open";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { DatabaseConnection } from "@/lib/types";

/** POST /api/dbt/project — the models and metrics in a GitHub dbt project. */
export async function POST(req: Request) {
  const guard = await guardRoute({ route: "POST /api/dbt/project", bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    const request = readDbtRequest(body, false);
    if (typeof request === "string") return NextResponse.json({ error: request }, { status: 400 });
    const connection = await connectionFor(request.connectionId, guard.session);
    const opened = await openDbtProject(request, globalThis.fetch, connection);
    if (typeof opened === "string") return NextResponse.json({ error: opened }, { status: 400 });
    return NextResponse.json(opened);
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/dbt/project" });
  }
}

async function connectionFor(
  connectionId: string | null,
  session: Parameters<typeof resolveConnection>[1],
): Promise<DatabaseConnection | null> {
  if (connectionId === null) return null;
  return resolveConnection({ connectionId }, session);
}
