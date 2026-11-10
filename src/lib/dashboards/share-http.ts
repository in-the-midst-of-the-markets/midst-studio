import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { ShareError, ShareNotFoundError } from "./share-limits";

/** The HTTP answer for a snapshot failure. Anything else uses the shared error mapping. */
export function shareErrorResponse(error: unknown, route: string): NextResponse {
  if (error instanceof ShareNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ShareError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return createErrorResponse(error, { route });
}
