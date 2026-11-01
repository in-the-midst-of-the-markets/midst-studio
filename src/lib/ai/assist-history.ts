/**
 * The AI Assist conversation kept in this browser.
 *
 * A refresh used to drop the chat and its charts. This keeps the last seven
 * days, including the chart each answer drew, and drops anything older.
 */

import { assistChartColor, ASSIST_CHART_TYPES, type AssistChart, type AssistChartType } from "@/lib/ai/assist-plan";
import type { QueryResult } from "@/lib/types";

export const ASSIST_TRANSCRIPT_KEY = "libredb_ai_assist_transcript";
export const ASSIST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TRANSCRIPT_CAP = 1_500_000;
const STORED_ROWS = 200;
const STORED_FIELDS = 40;
const CHART_TYPES = new Set<string>(ASSIST_CHART_TYPES);

export interface AssistTranscriptCard {
  readonly id: string;
  readonly title: string;
  readonly titledSql: string;
  readonly modelSql: string;
  readonly locked: boolean;
  readonly sql: string;
  readonly connectionId: string | null;
  readonly connectionName: string;
  readonly chart: AssistChart | null;
  readonly color: string | null;
  readonly result: QueryResult | null;
  readonly error: string | null;
}

export interface AssistTranscriptTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
  readonly cards: readonly AssistTranscriptCard[];
}

interface TranscriptStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resultOf(value: unknown): QueryResult | null {
  if (value === null || typeof value !== "object") return null;
  if (!("rows" in value) || !Array.isArray(value.rows) || !("fields" in value) || !Array.isArray(value.fields)) {
    return null;
  }
  const fields = value.fields
    .filter((field): field is string => typeof field === "string" && field !== "")
    .slice(0, STORED_FIELDS);
  if (fields.length === 0) return null;
  const rows = value.rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .slice(0, STORED_ROWS);
  const rowCount = "rowCount" in value && typeof value.rowCount === "number" ? value.rowCount : rows.length;
  const executionTime = "executionTime" in value && typeof value.executionTime === "number" ? value.executionTime : 0;
  return { fields, rows, rowCount, executionTime };
}

function chartOf(value: unknown): AssistChart | null {
  if (value === null || typeof value !== "object") return null;
  const type = "type" in value ? value.type : undefined;
  const x = "x" in value ? value.x : undefined;
  const y = "y" in value ? value.y : undefined;
  if (typeof type !== "string" || !CHART_TYPES.has(type)) return null;
  if (typeof x !== "string" || x.trim() === "") return null;
  if (!Array.isArray(y) || y.length === 0 || y.some((item) => typeof item !== "string" || item.trim() === ""))
    return null;
  const caption = "caption" in value && typeof value.caption === "string" ? value.caption : "";
  return {
    type: type as AssistChartType,
    x: x.trim(),
    y: y
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .slice(0, 4),
    caption,
    color: assistChartColor("color" in value ? value.color : undefined),
  };
}

function cardOf(value: unknown): AssistTranscriptCard | null {
  if (value === null || typeof value !== "object") return null;
  const id = text("id" in value ? value.id : undefined);
  const sql = text("sql" in value ? value.sql : undefined);
  if (id === "" || sql === "") return null;
  const chart = chartOf("chart" in value ? value.chart : undefined);
  const color = assistChartColor("color" in value ? value.color : undefined) ?? chart?.color ?? null;
  const connectionId = "connectionId" in value && typeof value.connectionId === "string" ? value.connectionId : null;
  return {
    id,
    title: text("title" in value ? value.title : undefined) || "Query",
    titledSql: text("titledSql" in value ? value.titledSql : undefined) || sql,
    modelSql: text("modelSql" in value ? value.modelSql : undefined) || sql,
    locked: "locked" in value && value.locked === true,
    sql,
    connectionId,
    connectionName: text("connectionName" in value ? value.connectionName : undefined),
    chart,
    color,
    result: resultOf("result" in value ? value.result : undefined),
    error: "error" in value && typeof value.error === "string" ? value.error : null,
  };
}

function turnOf(value: unknown, now: number): AssistTranscriptTurn | null {
  if (value === null || typeof value !== "object") return null;
  const id = text("id" in value ? value.id : undefined);
  const role = "role" in value ? value.role : undefined;
  const at = text("at" in value ? value.at : undefined);
  if (id === "" || (role !== "user" && role !== "assistant") || at === "") return null;
  const savedAt = Date.parse(at);
  if (!Number.isFinite(savedAt) || now - savedAt > ASSIST_RETENTION_MS) return null;
  const cards =
    "cards" in value && Array.isArray(value.cards)
      ? value.cards.flatMap((item) => {
          const card = cardOf(item);
          return card === null ? [] : [card];
        })
      : [];
  return { id, role, text: text("text" in value ? value.text : undefined), at, cards };
}

function fresh(turns: readonly AssistTranscriptTurn[], now: number): AssistTranscriptTurn[] {
  return turns.filter((turn) => {
    const savedAt = Date.parse(turn.at);
    return Number.isFinite(savedAt) && now - savedAt <= ASSIST_RETENTION_MS;
  });
}

function shrink(turns: readonly AssistTranscriptTurn[]): AssistTranscriptTurn[] {
  let kept = [...turns];
  while (kept.length > 0 && JSON.stringify(kept).length > TRANSCRIPT_CAP) kept = kept.slice(1);
  return kept;
}

function limitTurn(turn: AssistTranscriptTurn): AssistTranscriptTurn {
  const cards = turn.cards.map((card) => {
    const result = limitResult(card.result);
    if (result === card.result) return card;
    return {
      id: card.id,
      title: card.title,
      titledSql: card.titledSql,
      modelSql: card.modelSql,
      locked: card.locked,
      sql: card.sql,
      connectionId: card.connectionId,
      connectionName: card.connectionName,
      chart: card.chart,
      color: card.color,
      result,
      error: card.error,
    };
  });
  return { id: turn.id, role: turn.role, text: turn.text, at: turn.at, cards };
}

function limitResult(result: QueryResult | null): QueryResult | null {
  if (result === null) return null;
  return {
    fields: result.fields.slice(0, STORED_FIELDS),
    rows: result.rows.slice(0, STORED_ROWS),
    rowCount: result.rowCount,
    executionTime: result.executionTime,
  };
}

/** The conversation still inside the last seven days, oldest first. */
export function readAssistTranscript(now: number, store: TranscriptStore = localStorage): AssistTranscriptTurn[] {
  const raw = store.getItem(ASSIST_TRANSCRIPT_KEY);
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const turn = turnOf(item, now);
    return turn === null ? [] : [turn];
  });
}

/** Writes the turns that are still inside the last seven days. */
export function writeAssistTranscript(
  turns: readonly AssistTranscriptTurn[],
  now: number,
  store: TranscriptStore = localStorage,
): void {
  let kept = shrink(fresh(turns, now).map(limitTurn));
  while (true) {
    try {
      store.setItem(ASSIST_TRANSCRIPT_KEY, JSON.stringify(kept));
      return;
    } catch {
      if (kept.length === 0) return;
      kept = kept.slice(1);
    }
  }
}
