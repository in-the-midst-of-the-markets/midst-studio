import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { guardRoute } from "@/lib/api/require-session";
import { dbtProfile } from "@/lib/dbt/profile";
import { readDbtRequest } from "@/lib/dbt/open";
import { compileProject } from "@/lib/dbt/runner";
import { readGitHubProject } from "@/lib/git/github";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/** POST /api/dbt/compile — `dbt compile` for a GitHub project, using the saved connection. */
export async function POST(req: Request) {
  const guard = await guardRoute({ route: "POST /api/dbt/compile", bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readJsonObject(req);
    if (body === null) return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    const request = readDbtRequest(body, true);
    if (typeof request === "string") return NextResponse.json({ error: request }, { status: 400 });
    const connection = await resolveConnection({ connectionId: request.connectionId ?? "" }, guard.session);
    const profile = dbtProfile(connection);
    if ("error" in profile) return NextResponse.json({ error: profile.error }, { status: 400 });
    const project = await readGitHubProject(request.repo, {
      ref: request.ref,
      directory: request.directory,
      token: request.token,
      fetch: globalThis.fetch,
    });
    if (typeof project === "string") return NextResponse.json({ error: project }, { status: 400 });
    const compiled = await compileProject(project.files, profile.yaml);
    if ("error" in compiled) return NextResponse.json({ error: compiled.error }, { status: 400 });
    return NextResponse.json({ ref: project.ref, files: compiled.files });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/dbt/compile" });
  }
}
