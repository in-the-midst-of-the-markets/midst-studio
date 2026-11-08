/**
 * The AI Assist conversations kept in this browser.
 *
 * A refresh used to drop the chat and its charts. This keeps the last seven
 * days, including the chart each answer drew, and drops anything older.
 * Each conversation has a name so one purpose stays separate from the next.
 * The open conversation's messages stay in the transcript. The others stay here.
 */

import type { AssistChartChoice } from "@/lib/ai/assist-chart";
import { assistChartColor, ASSIST_CHART_TYPES, type AssistChart, type AssistChartType } from "@/lib/ai/assist-plan";
import { slotsFor, type SlotSelection } from "@/lib/charts/echarts-catalog";
import type { QueryResult } from "@/lib/types";

export const ASSIST_TRANSCRIPT_KEY = "libredb_ai_assist_transcript";
export const ASSIST_CONVERSATIONS_KEY = "libredb_ai_assist_conversations";
export const ASSIST_CONVERSATION_CAP = 12;
export const ASSIST_CONVERSATION_NAME_CAP = 60;
export const DEFAULT_ASSIST_CONVERSATION_NAME = "New conversation";
export const ASSIST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Chart JSON kept with a card. Longer text is dropped rather than stored cut in half. */
export const ASSIST_CHART_CODE_CAP = 100_000;

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
  /** The type the user left open, so a later visit does not reseed a basic bar. */
  readonly view: AssistChartChoice | null;
  /** Chart JSON the user edited. Null keeps the generated chart. */
  readonly code: string | null;
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

function viewOf(value: unknown): AssistChartChoice | null {
  if (value === null || typeof value !== "object") return null;
  const typeId = "typeId" in value && typeof value.typeId === "string" ? value.typeId : "";
  const variationId = "variationId" in value && typeof value.variationId === "string" ? value.variationId : "";
  if (slotsFor(typeId, variationId) === null) return null;
  const selection = "selection" in value ? value.selection : null;
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return null;
  const slots: SlotSelection = {};
  for (const [key, item] of Object.entries(selection)) {
    if (!Array.isArray(item)) return null;
    const names = item.filter((entry): entry is string => typeof entry === "string");
    if (names.length !== item.length) return null;
    slots[key] = names;
  }
  return { typeId, variationId, selection: slots };
}

function codeOf(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > ASSIST_CHART_CODE_CAP) return null;
  return value;
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
    view: viewOf("view" in value ? value.view : undefined),
    code: codeOf("code" in value ? value.code : undefined),
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
    return { ...card, result };
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

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,40}$/;

export interface AssistConversation {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly turns: readonly AssistTranscriptTurn[];
}

export interface AssistConversationBook {
  readonly activeId: string;
  readonly conversations: readonly AssistConversation[];
}

export interface AssistConversationChange {
  readonly book: AssistConversationBook;
  /** The messages the open conversation should show. Null leaves them as they are. */
  readonly turns: readonly AssistTranscriptTurn[] | null;
}

function conversationName(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim().slice(0, ASSIST_CONVERSATION_NAME_CAP);
  return clean === "" ? DEFAULT_ASSIST_CONVERSATION_NAME : clean;
}

function freshName(names: readonly string[]): string {
  const taken = new Set(names);
  if (!taken.has(DEFAULT_ASSIST_CONVERSATION_NAME)) return DEFAULT_ASSIST_CONVERSATION_NAME;
  let count = 2;
  let candidate = `${DEFAULT_ASSIST_CONVERSATION_NAME} ${count}`;
  while (taken.has(candidate)) {
    count += 1;
    candidate = `${DEFAULT_ASSIST_CONVERSATION_NAME} ${count}`;
    if (count > ASSIST_CONVERSATION_CAP + 1) return DEFAULT_ASSIST_CONVERSATION_NAME;
  }
  return candidate;
}

function blankBook(now: number): AssistConversationBook {
  return {
    activeId: "conv-1",
    conversations: [
      {
        id: "conv-1",
        name: DEFAULT_ASSIST_CONVERSATION_NAME,
        updatedAt: new Date(now).toISOString(),
        turns: [],
      },
    ],
  };
}

function keptTurns(turns: readonly AssistTranscriptTurn[], now: number): AssistTranscriptTurn[] {
  return shrink(fresh(turns, now).map(limitTurn));
}

function conversationOf(value: unknown, now: number): AssistConversation | null {
  if (value === null || typeof value !== "object") return null;
  const id = "id" in value && typeof value.id === "string" && CONVERSATION_ID.test(value.id) ? value.id : null;
  const updatedAt = text("updatedAt" in value ? value.updatedAt : undefined);
  const savedAt = Date.parse(updatedAt);
  if (id === null || !Number.isFinite(savedAt)) return null;
  const turns =
    "turns" in value && Array.isArray(value.turns)
      ? value.turns.flatMap((item) => {
          const turn = turnOf(item, now);
          return turn === null ? [] : [turn];
        })
      : [];
  return {
    id,
    name: conversationName(text("name" in value ? value.name : undefined)),
    updatedAt: new Date(savedAt).toISOString(),
    turns: keptTurns(turns, now),
  };
}

function dedupe(conversations: readonly AssistConversation[]): AssistConversation[] {
  const seen = new Set<string>();
  const unique: AssistConversation[] = [];
  for (const item of conversations) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function retain(book: AssistConversationBook, now: number): AssistConversationBook {
  const alive = dedupe(book.conversations).filter((item) => {
    if (item.id === book.activeId) return true;
    if (item.turns.length > 0) return true;
    const updated = Date.parse(item.updatedAt);
    return Number.isFinite(updated) && now - updated <= ASSIST_RETENTION_MS;
  });
  const active = alive.filter((item) => item.id === book.activeId);
  const idle = alive
    .filter((item) => item.id !== book.activeId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const conversations = [...active, ...idle.slice(0, ASSIST_CONVERSATION_CAP - active.length)];
  const first = conversations[0];
  if (first === undefined) return blankBook(now);
  return { activeId: active.length > 0 ? book.activeId : first.id, conversations };
}

/** The named conversations in this browser. A missing list is one empty conversation. */
export function readAssistConversations(now: number, store: TranscriptStore = localStorage): AssistConversationBook {
  const raw = store.getItem(ASSIST_CONVERSATIONS_KEY);
  if (raw === null || raw === "") return blankBook(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blankBook(now);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("conversations" in parsed) ||
    !Array.isArray(parsed.conversations)
  ) {
    return blankBook(now);
  }
  const conversations = parsed.conversations.flatMap((item) => {
    const conversation = conversationOf(item, now);
    return conversation === null ? [] : [conversation];
  });
  if (conversations.length === 0) return blankBook(now);
  const requested =
    "activeId" in parsed && typeof parsed.activeId === "string" && CONVERSATION_ID.test(parsed.activeId)
      ? parsed.activeId
      : "";
  return retain({ activeId: requested, conversations }, now);
}

/** Remembers the list. The open conversation's messages stay in the transcript, so they are not copied here. */
export function writeAssistConversations(
  book: AssistConversationBook,
  now: number,
  store: TranscriptStore = localStorage,
): void {
  let kept = retain(book, now);
  kept = {
    activeId: kept.activeId,
    conversations: kept.conversations.map((item) => (item.id === kept.activeId ? { ...item, turns: [] } : item)),
  };
  while (true) {
    try {
      store.setItem(ASSIST_CONVERSATIONS_KEY, JSON.stringify(kept));
      return;
    } catch {
      const idle = kept.conversations.filter((item) => item.id !== kept.activeId);
      const oldest = idle.reduce<AssistConversation | null>((left, right) => {
        if (left === null) return right;
        return Date.parse(left.updatedAt) <= Date.parse(right.updatedAt) ? left : right;
      }, null);
      if (oldest === null) return;
      kept = { ...kept, conversations: kept.conversations.filter((item) => item.id !== oldest.id) };
    }
  }
}

/** Moves the clock forward on the open conversation when a message is saved. */
export function touchAssistConversation(book: AssistConversationBook, now: number): AssistConversationBook {
  const updatedAt = new Date(now).toISOString();
  let found = false;
  const conversations = book.conversations.map((item) => {
    if (item.id !== book.activeId) return item;
    found = true;
    return { ...item, updatedAt };
  });
  return found ? { activeId: book.activeId, conversations } : book;
}

/** Gives one conversation a name. A blank name stays "New conversation". */
export function renameAssistConversation(
  book: AssistConversationBook,
  id: string,
  name: string,
  now: number,
): AssistConversationBook {
  const clean = conversationName(name);
  const current = book.conversations.find((item) => item.id === id);
  if (current === undefined || current.name === clean) return book;
  return {
    activeId: book.activeId,
    conversations: book.conversations.map((item) =>
      item.id === id ? { ...item, name: clean, updatedAt: new Date(now).toISOString() } : item,
    ),
  };
}

/**
 * Opens a different conversation. The messages passed in are parked on the one
 * that was open. Null means the id is already open, or it is not in the list.
 */
export function selectAssistConversation(
  book: AssistConversationBook,
  id: string,
  activeTurns: readonly AssistTranscriptTurn[],
  now: number,
): AssistConversationChange | null {
  if (id === book.activeId) return null;
  const target = book.conversations.find((item) => item.id === id);
  if (target === undefined) return null;
  const parked = keptTurns(activeTurns, now);
  return {
    book: {
      activeId: id,
      conversations: book.conversations.map((item) => {
        if (item.id === book.activeId) return { ...item, turns: parked };
        if (item.id === id) return { ...item, turns: [] };
        return item;
      }),
    },
    turns: target.turns,
  };
}

/** Starts an empty conversation and parks the one that was open. */
export function createAssistConversation(
  book: AssistConversationBook,
  activeTurns: readonly AssistTranscriptTurn[],
  now: number,
  id: string,
): AssistConversationChange | null {
  if (!CONVERSATION_ID.test(id) || book.conversations.some((item) => item.id === id)) return null;
  const parked = keptTurns(activeTurns, now);
  const stamped = book.conversations.map((item) => (item.id === book.activeId ? { ...item, turns: parked } : item));
  const created: AssistConversation = {
    id,
    name: freshName(stamped.map((item) => item.name)),
    updatedAt: new Date(now).toISOString(),
    turns: [],
  };
  return { book: retain({ activeId: id, conversations: [...stamped, created] }, now), turns: [] };
}

/**
 * Removes one conversation. The last one is emptied and renamed instead, so
 * there is always a place to ask. Removing the open one shows the newest other.
 */
export function removeAssistConversation(
  book: AssistConversationBook,
  id: string,
  now: number,
): AssistConversationChange | null {
  if (!book.conversations.some((item) => item.id === id)) return null;
  if (book.conversations.length === 1) {
    return {
      book: {
        activeId: book.activeId,
        conversations: [
          {
            id: book.activeId,
            name: DEFAULT_ASSIST_CONVERSATION_NAME,
            updatedAt: new Date(now).toISOString(),
            turns: [],
          },
        ],
      },
      turns: [],
    };
  }
  const remaining = book.conversations.filter((item) => item.id !== id);
  if (id !== book.activeId) {
    return { book: { activeId: book.activeId, conversations: remaining }, turns: null };
  }
  const next = remaining.reduce((left, right) =>
    Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left : right,
  );
  return {
    book: {
      activeId: next.id,
      conversations: remaining.map((item) => {
        if (item.id !== next.id) return item;
        return { id: item.id, name: item.name, updatedAt: item.updatedAt, turns: [] };
      }),
    },
    turns: next.turns,
  };
}
