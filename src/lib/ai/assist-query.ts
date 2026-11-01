/**
 * Runs one statement the AI Assist page already accepted as read-only.
 */

import { buildConnectionPayload } from "@/hooks/use-connection-payload";
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
      body: JSON.stringify({ ...buildConnectionPayload(connection), sql }),
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
