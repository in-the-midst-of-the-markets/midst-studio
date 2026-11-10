import type { DatabaseConnection } from "@/lib/types";
import type { UserPayload } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "@/lib/storage/factory";
import { writeShareTables, type ShareSheet } from "./share-file";
import { ownerSession, writeShare, type ShareRecord } from "./share-record";
import { ShareError } from "./share-limits";

/**
 * Rerun the stored source queries and replace the snapshot.
 *
 * A public view calls this when the newest refresh interval has elapsed. It uses
 * the owner's stored connections, never a connection the visitor sent. A failure
 * keeps the previous file and waits out the interval before trying again.
 */

export interface ShareRefreshDeps {
  readonly now: () => number;
  readonly loadConnections: (ownerKey: string) => Promise<readonly DatabaseConnection[] | null>;
  readonly resolve: (connection: DatabaseConnection, owner: UserPayload) => Promise<DatabaseConnection>;
  readonly run: (
    connection: DatabaseConnection,
    sql: string,
    label: string,
    owner: UserPayload,
  ) => Promise<{ fields: string[]; rows: Record<string, unknown>[] }>;
}

export function shareIsDue(record: ShareRecord, now: number, force: boolean): boolean {
  if (force) return record.sources.length > 0;
  if (record.refreshSeconds === undefined || record.sources.length === 0) return false;
  const refreshed = Date.parse(record.refreshedAt);
  if (!Number.isFinite(refreshed)) return true;
  return now - refreshed >= record.refreshSeconds * 1000;
}

export async function loadShareOwnerConnections(ownerKey: string): Promise<readonly DatabaseConnection[] | null> {
  const provider = await getStorageProvider();
  if (provider === null) return null;
  const stored = await provider.getCollection(ownerKey, "connections");
  return Array.isArray(stored) ? stored : null;
}

function findConnection(
  connections: readonly DatabaseConnection[],
  connectionId: string,
): DatabaseConnection | undefined {
  return connections.find((item) => item.id === connectionId);
}

/** The snapshot after a refresh, or the same record when it is not due or a connection is missing. */
export async function refreshShareIfDue(
  record: ShareRecord,
  deps: ShareRefreshDeps,
  force = false,
): Promise<ShareRecord> {
  const now = deps.now();
  if (!shareIsDue(record, now, force)) return record;
  const connections = await deps.loadConnections(record.ownerKey);
  if (connections === null) return record;
  const owner = ownerSession(record);
  const sheets: ShareSheet[] = [];
  try {
    for (const source of record.sources) {
      const found = findConnection(connections, source.connectionId);
      if (found === undefined) throw new ShareError("A connection on this dashboard is no longer saved.");
      const connection = await deps.resolve(found, owner);
      // oxlint-disable-next-line no-await-in-loop -- each source runs after the one before it.
      const sheet = await deps.run(connection, source.sql, source.table, owner);
      sheets.push({ table: source.table, fields: sheet.fields, rows: sheet.rows });
    }
  } catch (error) {
    if (force) throw error;
    logger.error("[share] refresh kept the previous snapshot", error);
    const waited: ShareRecord = { ...record, refreshedAt: new Date(now).toISOString() };
    writeShare(waited);
    return waited;
  }
  await writeShareTables(record.id, sheets);
  const next: ShareRecord = { ...record, refreshedAt: new Date(now).toISOString() };
  writeShare(next);
  return next;
}
