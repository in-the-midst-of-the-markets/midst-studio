import { NextRequest, NextResponse } from "next/server";
import { clientAddress } from "@/lib/api/client-address";
import { RateLimitError, consumeRateLimit } from "@/lib/api/rate-limit";
import { guardRoute } from "@/lib/api/require-session";
import { deleteShare, publicShare, readShare } from "@/lib/dashboards/share-record";
import { shareErrorResponse } from "@/lib/dashboards/share-http";
import { ShareNotFoundError } from "@/lib/dashboards/share-limits";
import { storageOwnerKey } from "@/lib/storage/owner-key";

/**
 * GET /api/share/[id]
 *
 * The public board. It names no source connection and no source statement.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const notice = consumeRateLimit("anon", clientAddress(request));
    if (!notice.allowed) throw new RateLimitError(notice.retryAfterSeconds);
    const record = readShare(id);
    if (record === null) throw new ShareNotFoundError();
    return NextResponse.json(publicShare(record));
  } catch (error) {
    return shareErrorResponse(error, "GET /api/share/[id]");
  }
}

/** DELETE /api/share/[id] — the owner removes the snapshot and the link stops answering. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardRoute({ route: "DELETE /api/share/[id]", bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    const { id } = await params;
    const record = readShare(id);
    if (record === null || record.ownerKey !== storageOwnerKey(guard.session)) throw new ShareNotFoundError();
    deleteShare(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return shareErrorResponse(error, "DELETE /api/share/[id]");
  }
}
