/**
 * The database a completed marketplace subscription opens.
 *
 * The connection string stays off the public catalog. This module reads it only after Stripe
 * reports the Checkout session complete, and stores the resulting connection for that account.
 * It parses the string. It does not open the database.
 */

import type { UserPayload } from "@/lib/auth";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { connectionStringForOffering, type MarketplaceOffering } from "@/lib/marketplace/catalog";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "@/lib/storage/factory";
import { storageOwnerKey } from "@/lib/storage/owner-key";
import type { DatabaseConnection } from "@/lib/types";

export function marketplaceConnectionId(offeringId: string): string {
  return `marketplace-${offeringId}`;
}

/** The connection to save for this offering, or null when no usable string is configured. */
export function connectionForSubscription(
  offering: MarketplaceOffering,
  env: NodeJS.ProcessEnv = process.env,
  createdAt: Date = new Date(),
): DatabaseConnection | null {
  const raw = connectionStringForOffering(offering, env);
  if (raw === null) return null;
  const parsed = parseConnectionString(raw);
  if (parsed === null || parsed.refusal !== undefined) return null;
  const port = Number(parsed.port);
  return {
    id: marketplaceConnectionId(offering.id),
    name: offering.name,
    type: parsed.type,
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
    ...(parsed.user === undefined ? {} : { user: parsed.user }),
    ...(parsed.password === undefined ? {} : { password: parsed.password }),
    ...(parsed.database === undefined ? {} : { database: parsed.database }),
    ...(parsed.schema === undefined ? {} : { schema: parsed.schema }),
    ...(parsed.connectionString === undefined ? {} : { connectionString: parsed.connectionString }),
    ...(parsed.sslMode === undefined ? {} : { ssl: { mode: parsed.sslMode } }),
    createdAt,
  };
}

/**
 * Writes the subscribed connection into this account's server storage, and selects it.
 * Local storage has no server provider: the browser saves the connection the response carries.
 */
export async function rememberMarketplaceConnection(
  session: UserPayload,
  connection: DatabaseConnection,
): Promise<void> {
  try {
    const provider = await getStorageProvider();
    if (provider === null) return;
    const owner = storageOwnerKey(session);
    const stored = await provider.getCollection(owner, "connections");
    const current = stored ?? [];
    const prior = current.find((item) => item.id === connection.id);
    const next =
      prior === undefined
        ? [...current, connection]
        : current.map((item) => (item.id === connection.id ? { ...connection, createdAt: prior.createdAt } : item));
    await provider.setCollection(owner, "connections", next);
    await provider.setCollection(owner, "active_connection_id", connection.id);
  } catch (error) {
    logger.warn("The subscribed database could not be stored for this account", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
