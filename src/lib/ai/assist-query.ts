/**
 * Runs one statement the AI Assist page already accepted as read-only.
 */

import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { embeddingModelFor } from "@/lib/embeddings/settings";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

interface JsonResponse {
  readonly ok: boolean;
  json: () => Promise<unknown>;
}

type Post = (path: string, init?: RequestInit) => Promise<JsonResponse>;

function errorText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
    const text = body.error.trim();
    if (text !== "") return text;
  }
  return fallback;
}

function resultOf(body: unknown): QueryResult | null {
  if (body === null || typeof body !== "object") return null;
  if (!("rows" in body) || !Array.isArray(body.rows) || !("fields" in body) || !Array.isArray(body.fields)) return null;
  if (body.fields.some((field) => typeof field !== "string" || field === "")) return null;
  const rowCount = "rowCount" in body && typeof body.rowCount === "number" ? body.rowCount : body.rows.length;
  const executionTime = "executionTime" in body && typeof body.executionTime === "number" ? body.executionTime : 0;
  return {
    rows: body.rows as Record<string, unknown>[],
    fields: body.fields as string[],
    rowCount,
    executionTime,
  };
}

const TABLE_REFERENCE = /\b(?:from|join)\s+([^\s,;()]+)/gi;

function schemaObjectNames(schemaContext: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaContext);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const names = new Set<string>();
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") continue;
    const name = item.name.trim().toLowerCase();
    if (name === "") continue;
    names.add(name);
  }
  return names;
}

function referencedTables(sql: string): readonly string[] {
  const found: string[] = [];
  for (const match of sql.matchAll(TABLE_REFERENCE)) {
    const token = match[1] ?? "";
    const piece = token.split(".").pop() ?? token;
    const bare = piece.replace(/["`[\]]/g, "").toLowerCase();
    if (bare !== "") found.push(bare);
  }
  return found;
}

/**
 * The connection whose schema contains a table the statement names.
 * Zero hits or several hits are not a guess.
 */
function connectionByTables<T extends { readonly id: string }>(
  connections: readonly T[],
  sql: string,
  schemas: Readonly<Record<string, string>>,
): T | null {
  const tables = referencedTables(sql);
  if (tables.length === 0) return null;
  const hits = connections.filter((item) => {
    const names = schemaObjectNames(schemas[item.id] ?? "");
    return tables.some((table) => names.has(table));
  });
  const hit = hits.length === 1 ? hits[0] : undefined;
  return hit ?? null;
}

function missingConnection<T extends { readonly name: string }>(connections: readonly T[], name: string): string {
  const listed = connections.map((item) => item.name).join(", ");
  return `No connected database is named ${name}. The connected databases are ${listed}.`;
}

/**
 * The saved connection a planned statement should run on.
 *
 * An empty name uses the only connection. A name or id must match exactly one
 * saved connection. A name that no longer matches, after a connection was renamed
 * or replaced, uses the only connection left, or the one connection whose tables
 * the statement names. The match is the connection the studio already stored.
 */
export function connectionForAssistQuery<T extends { readonly id: string; readonly name: string }>(
  connections: readonly T[],
  requested: string,
  hint?: { readonly sql: string; readonly schemas: Readonly<Record<string, string>> },
): { ok: true; connection: T } | { ok: false; error: string } {
  const only = connections[0];
  if (only === undefined) {
    return { ok: false, error: "Connect a database in Traditional mode to run this query." };
  }
  const name = requested.trim();
  if (name === "") {
    if (connections.length === 1) return { ok: true, connection: only };
    return { ok: false, error: "Name the connected database this query should use." };
  }
  const lower = name.toLowerCase();
  const matches = connections.filter((item) => item.id.toLowerCase() === lower || item.name.toLowerCase() === lower);
  const match = matches[0];
  if (match !== undefined && matches.length === 1) return { ok: true, connection: match };
  if (matches.length > 1) return { ok: false, error: `More than one connected database is named ${name}.` };
  if (hint !== undefined) {
    const byTable = connectionByTables(connections, hint.sql, hint.schemas);
    if (byTable !== null) return { ok: true, connection: byTable };
  }
  if (connections.length === 1) return { ok: true, connection: only };
  return { ok: false, error: missingConnection(connections, name) };
}

/** A chart saved against a connection that was removed or renamed. */
export interface AssistConnectionCard {
  readonly connectionId: string | null;
  readonly connectionName: string;
  readonly error: string | null;
}

const STALE_CONNECTION = /^(?:No connected database is named |Connect a database in Traditional mode)/;

/**
 * Points a saved chart at a connection that still exists.
 * The stored id wins. A missing id uses the stored name, then the only connection left.
 */
export function rebindAssistCard<
  T extends { readonly id: string; readonly name: string },
  C extends AssistConnectionCard,
>(connections: readonly T[], card: C): C {
  if (card.connectionId !== null) {
    const current = connections.find((item) => item.id === card.connectionId);
    if (current !== undefined) {
      if (current.name === card.connectionName) return card;
      return { ...card, connectionName: current.name };
    }
  }
  const resolved = connectionForAssistQuery(connections, card.connectionName);
  if (!resolved.ok) {
    if (card.connectionId === null) return card;
    return { ...card, connectionId: null, error: resolved.error };
  }
  const stale = card.error !== null && STALE_CONNECTION.test(card.error);
  return {
    ...card,
    connectionId: resolved.connection.id,
    connectionName: resolved.connection.name,
    error: stale ? null : card.error,
  };
}

/** The editor query route's answer, or the message to show on the chart card. */
export async function runAssistQuery(
  connection: DatabaseConnection,
  sql: string,
  post: Post,
): Promise<{ ok: true; result: QueryResult } | { ok: false; error: string }> {
  let response: JsonResponse;
  try {
    response = await post("/api/db/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...buildConnectionPayload(connection),
        sql,
        embeddingModel: embeddingModelFor(connection.id),
      }),
    });
  } catch {
    return { ok: false, error: "The query could not be sent." };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "The query returned a result this page cannot read." };
  }
  if (!response.ok) return { ok: false, error: errorText(body, "The query failed.") };
  const result = resultOf(body);
  if (result === null) return { ok: false, error: "The query returned a result this page cannot chart." };
  return { ok: true, result };
}
