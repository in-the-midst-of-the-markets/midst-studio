/**
 * Saves the connection a completed Checkout returned.
 * The browser holds the account's copy of connections, including when server storage is off.
 */

import { storage } from "@/lib/storage";
import type { DatabaseConnection, SSLMode } from "@/lib/types";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sslMode(value: unknown): SSLMode | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mode = (value as { mode?: unknown }).mode;
  if (
    mode !== "disable" &&
    mode !== "require" &&
    mode !== "verify-ca" &&
    mode !== "verify-full" &&
    mode !== "verify-system"
  ) {
    return undefined;
  }
  return mode;
}

/** The connection in a Checkout confirmation, or null when the body does not carry one. */
export function subscribedConnection(value: unknown): DatabaseConnection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const name = text(row.name);
  const type = text(row.type);
  if (id === undefined || name === undefined || type === undefined || typeof row.createdAt !== "string") return null;
  const createdAt = new Date(row.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  const host = text(row.host);
  const user = text(row.user);
  const password = text(row.password);
  const database = text(row.database);
  const schema = text(row.schema);
  const connectionString = text(row.connectionString);
  const port = typeof row.port === "number" && Number.isInteger(row.port) ? row.port : undefined;
  const mode = sslMode(row.ssl);
  return {
    id,
    name,
    type: type as DatabaseConnection["type"],
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(password === undefined ? {} : { password }),
    ...(database === undefined ? {} : { database }),
    ...(schema === undefined ? {} : { schema }),
    ...(connectionString === undefined ? {} : { connectionString }),
    ...(mode === undefined ? {} : { ssl: { mode } }),
    createdAt,
  };
}

/** Saves the subscribed database and selects it. A second confirmation updates the same connection. */
export function acceptSubscribedConnection(value: unknown): boolean {
  const connection = subscribedConnection(value);
  if (connection === null) return false;
  const existing = storage.getConnections().find((item) => item.id === connection.id);
  storage.saveConnection(existing === undefined ? connection : { ...connection, createdAt: existing.createdAt });
  storage.setActiveConnectionId(connection.id);
  return true;
}
