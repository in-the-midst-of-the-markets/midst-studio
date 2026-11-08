"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Plus, Sparkles, Trash2 } from "lucide-react";
import { ChartWithEditor } from "@/components/ai-assist/ChartWithEditor";
import { HistoryLimitButton } from "@/components/ai-assist/HistoryLimitButton";
import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { MidstLockup } from "@/components/midst-logo";
import { AssistModelFields } from "@/components/ai-assist/AssistModelFields";
import { AssistPromptBox } from "@/components/ai-assist/AssistPromptBox";
import { renderProse } from "@/components/rich-text";
import { appFetch } from "@/lib/config/base-path";
import { assistDatabaseType, loadAssistCatalog } from "@/lib/ai/assist-catalog";
import {
  ASSIST_CONVERSATIONS_KEY,
  ASSIST_CONVERSATION_NAME_CAP,
  ASSIST_TRANSCRIPT_KEY,
  createAssistConversation,
  DEFAULT_ASSIST_CONVERSATION_NAME,
  readAssistConversations,
  readAssistTranscript,
  removeAssistConversation,
  renameAssistConversation,
  selectAssistConversation,
  touchAssistConversation,
  writeAssistConversations,
  writeAssistTranscript,
  type AssistConversationBook,
  type AssistTranscriptTurn,
} from "@/lib/ai/assist-history";
import {
  acceptAssistPlan,
  assistChartPatch,
  explanationWithCharts,
  explanationWithEdits,
  questionOnlyRecolors,
  recolorsFromQuestion,
  recentAssistHistory,
  reviseAssistCharts,
  splitAssistFollowUp,
  type AssistChart,
  type AssistChartRevision,
  type AssistEditableChart,
  type AssistHistoryTurn,
  type AssistPlan,
  type AssistQueryPlan,
  type AssistRecolor,
} from "@/lib/ai/assist-plan";
import { ASSIST_RESULT_CAP, explanationWithResults, readAssistResults } from "@/lib/ai/assist-reading";
import { assistRunnableStatement } from "@/lib/ai/assist-language";
import { suggestAssistChart, titleForQuery, type AssistChartChoice } from "@/lib/ai/assist-chart";
import {
  assistSavedAsk,
  assistSavedChart,
  assistSavedForPrompt,
  assistSavedPicks,
  toggleAssistSaved,
  type AssistSavedPick,
} from "@/lib/ai/assist-saved";
import {
  assistScheduleLabel,
  draftAssistSchedule,
  readAssistScheduleSnapshot,
  subscribeAssistSchedules,
  writeAssistSchedules,
  type AssistSchedule,
} from "@/lib/ai/assist-schedule";
import { readAssistRankings, type AssistRankings } from "@/lib/ai/assist-model-rank";
import { refreshDelayMs } from "@/lib/charts/chart-refresh";
import { queryFilterShape, queryIdentity } from "@/lib/charts/query-filters";
import { connectionForAssistQuery, rebindAssistCard, runAssistQuery } from "@/lib/ai/assist-query";
import { loadAssistSchema } from "@/lib/ai/assist-schema";
import {
  DEFAULT_ASSIST_SETTINGS,
  assistModelSearches,
  normalizeModels,
  readAssistSettings,
  subscribeAssistSettings,
  writeAssistSettings,
  type AssistModelOption,
  type AssistSettings,
} from "@/lib/ai/assist-settings";
import { storage } from "@/lib/storage";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

interface AssistCard {
  readonly id: string;
  readonly title: string;
  /** The statement the current title describes. Editing the editor updates `sql` before Run. */
  readonly titledSql: string;
  /** The statement the model wrote. A run of different SQL keeps the chart out of later answers. */
  readonly modelSql: string;
  readonly locked: boolean;
  readonly sql: string;
  readonly connectionId: string | null;
  readonly connectionName: string;
  readonly chart: AssistChart | null;
  /** A series colour from the model. Null keeps the palette. */
  readonly color: string | null;
  readonly result: QueryResult | null;
  readonly error: string | null;
  readonly view: AssistChartChoice | null;
  readonly code: string | null;
  readonly running: boolean;
}

interface Turn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
  readonly cards: readonly AssistCard[];
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `assist-${sequence}`;
}

function bump(id: string): void {
  const match = /^assist-(\d+)$/.exec(id);
  if (match === null) return;
  const value = Number(match[1]);
  if (value > sequence) sequence = value;
}

function noteIds(turns: readonly Turn[]): void {
  for (const turn of turns) {
    bump(turn.id);
    for (const card of turn.cards) bump(card.id);
  }
}

function fromStored(turn: AssistTranscriptTurn): Turn {
  return {
    id: turn.id,
    role: turn.role,
    text: turn.text,
    at: turn.at,
    cards: turn.cards.map((card) => ({ ...card, running: false })),
  };
}

function askedAt(): string {
  return new Date().toISOString();
}

const EMPTY_TURNS: readonly Turn[] = [];
let transcriptRaw = "\u0000";
let transcriptSnapshot: readonly Turn[] = EMPTY_TURNS;
const transcriptListeners = new Set<() => void>();

function subscribeTranscript(listener: () => void): () => void {
  transcriptListeners.add(listener);
  return () => {
    transcriptListeners.delete(listener);
  };
}

function readTranscriptSnapshot(): readonly Turn[] {
  const raw = localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "";
  if (raw === transcriptRaw) return transcriptSnapshot;
  transcriptRaw = raw;
  const loaded = readAssistTranscript(Date.now()).map(fromStored);
  noteIds(loaded);
  transcriptSnapshot = loaded;
  return transcriptSnapshot;
}

const EMPTY_BOOK: AssistConversationBook = {
  activeId: "conv-1",
  conversations: [{ id: "conv-1", name: DEFAULT_ASSIST_CONVERSATION_NAME, updatedAt: "", turns: [] }],
};
let conversationRaw = "\u0000";
let conversationSnapshot: AssistConversationBook = EMPTY_BOOK;

function readConversationSnapshot(): AssistConversationBook {
  const raw = localStorage.getItem(ASSIST_CONVERSATIONS_KEY) ?? "";
  if (raw === conversationRaw) return conversationSnapshot;
  conversationRaw = raw;
  conversationSnapshot = readAssistConversations(Date.now());
  for (const item of conversationSnapshot.conversations) bump(item.id);
  return conversationSnapshot;
}

function rememberBook(book: AssistConversationBook): void {
  writeAssistConversations(book, Date.now());
  conversationRaw = "\u0000";
  readConversationSnapshot();
}

function rememberTurns(turns: readonly Turn[]): readonly Turn[] {
  writeAssistTranscript(storedOf(turns), Date.now());
  const live = readAssistTranscript(Date.now()).map(fromStored);
  transcriptSnapshot = live;
  transcriptRaw = localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "";
  noteIds(live);
  return live;
}

function notifyTranscript(): void {
  for (const listener of transcriptListeners) listener();
}

function publishTranscript(turns: readonly Turn[]): void {
  writeAssistTranscript(storedOf(turns), Date.now());
  transcriptSnapshot = turns;
  transcriptRaw = localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "";
  noteIds(turns);
  const book = touchAssistConversation(readAssistConversations(Date.now()), Date.now());
  rememberBook(book);
  notifyTranscript();
}

function storedOf(turns: readonly Turn[]): AssistTranscriptTurn[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text,
    at: turn.at,
    cards: turn.cards.map((card) => ({
      id: card.id,
      title: card.title,
      titledSql: card.titledSql,
      modelSql: card.modelSql,
      locked: card.locked,
      sql: card.titledSql,
      connectionId: card.connectionId,
      connectionName: card.connectionName,
      chart: card.chart,
      color: card.color,
      result: card.result,
      error: card.error,
      view: card.view,
      code: card.code,
    })),
  }));
}

function sameChartView(left: AssistChartChoice | null, right: AssistChartChoice | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.typeId === right.typeId &&
    left.variationId === right.variationId &&
    JSON.stringify(left.selection) === JSON.stringify(right.selection)
  );
}

/** The latest chart with that statement takes the new colour. Its SQL, title, and type stay. */
function paint(turns: readonly Turn[], recolors: readonly AssistRecolor[]): readonly Turn[] {
  if (recolors.length === 0) return turns;
  const colors = new Map(recolors.map((item) => [queryIdentity(item.sql), item.color]));
  return turns.map((turn) => ({
    ...turn,
    cards: turn.cards.map((card) => {
      const color = colors.get(queryIdentity(card.titledSql));
      if (color === undefined) return card;
      return {
        ...card,
        color,
        chart: card.chart === null ? null : { ...card.chart, color },
      };
    }),
  }));
}

function rebindTurns(turns: readonly Turn[], connections: readonly DatabaseConnection[]): readonly Turn[] {
  let changed = false;
  const next = turns.map((turn) => {
    if (turn.cards.length === 0) return turn;
    let cardsChanged = false;
    const cards = turn.cards.map((card) => {
      const rebound = rebindAssistCard(connections, card);
      if (rebound !== card) cardsChanged = true;
      return rebound;
    });
    if (!cardsChanged) return turn;
    changed = true;
    return { ...turn, cards };
  });
  return changed ? next : turns;
}

function resultPayload(card: AssistCard): {
  title: string;
  sql: string;
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error: string | null;
} {
  return {
    title: card.title,
    sql: card.sql,
    fields: card.result?.fields ?? [],
    rows: card.result?.rows.slice(0, 12) ?? [],
    rowCount: card.result?.rowCount ?? 0,
    error: card.error,
  };
}

function historyOf(turns: readonly Turn[], limit: number): AssistHistoryTurn[] {
  const pairs: AssistHistoryTurn[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const next = turns[index + 1];
    if (turn?.role === "user" && next?.role === "assistant") {
      const edited = next.cards.filter((card) => card.locked).map((card) => card.sql);
      const results = readAssistResults(next.cards.slice(0, ASSIST_RESULT_CAP).map(resultPayload));
      const explanation = explanationWithResults(
        explanationWithCharts(
          explanationWithEdits(next.text, edited),
          next.cards.map((card) => ({
            title: card.title,
            sql: card.sql,
            chart: card.chart,
            code: card.code,
          })),
        ),
        results.ok ? results.value : [],
      );
      pairs.push({ question: turn.text, explanation });
    }
  }
  return recentAssistHistory(pairs, limit);
}

/** Charts a new question may change: the ones on the assistant turns inside the message window. */
function editableCharts(turns: readonly Turn[], limit: number): AssistEditableChart[] {
  const groups: AssistEditableChart[][] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const next = turns[index + 1];
    if (turn?.role === "user" && next?.role === "assistant") {
      groups.push(next.cards.map((card) => ({ id: card.id, title: card.title, locked: card.locked })));
    }
  }
  return recentAssistHistory(groups, limit).flat();
}

function reviseCard(
  card: AssistCard,
  query: AssistQueryPlan,
  connections: readonly DatabaseConnection[],
  schemas: Readonly<Record<string, string>>,
): AssistCard {
  const patch = assistChartPatch(card, query);
  const code = patch.code ?? (patch.sqlChanged || patch.planChanged ? null : card.code);
  if (!patch.sqlChanged) {
    return {
      ...card,
      chart: patch.chart,
      color: patch.color,
      view: patch.planChanged ? null : card.view,
      code,
    };
  }
  const resolved = connectionForAssistQuery(connections, query.connection || card.connectionName, {
    sql: patch.sql,
    schemas,
  });
  return {
    ...card,
    titledSql: patch.sql,
    modelSql: patch.sql,
    locked: false,
    sql: patch.sql,
    connectionId: resolved.ok ? resolved.connection.id : null,
    connectionName: resolved.ok ? resolved.connection.name : query.connection,
    chart: patch.chart,
    color: patch.color,
    result: null,
    error: resolved.ok ? null : resolved.error,
    view: null,
    code,
    running: resolved.ok,
  };
}

function applyChartRevisions(
  turns: readonly Turn[],
  revisions: readonly AssistChartRevision[],
  connections: readonly DatabaseConnection[],
  schemas: Readonly<Record<string, string>>,
): { turns: readonly Turn[]; rerun: AssistCard[] } {
  if (revisions.length === 0) return { turns, rerun: [] };
  const byId = new Map(revisions.map((item) => [item.id, item.query]));
  const rerun: AssistCard[] = [];
  const next = turns.map((turn) => {
    let changed = false;
    const cards = turn.cards.map((card) => {
      const query = byId.get(card.id);
      if (query === undefined) return card;
      changed = true;
      const updated = reviseCard(card, query, connections, schemas);
      if (updated.running) rerun.push(updated);
      return updated;
    });
    return changed ? { ...turn, cards } : turn;
  });
  return { turns: next, rerun };
}

function plannedCards(
  queries: readonly AssistQueryPlan[],
  connections: readonly DatabaseConnection[],
  schemas: Readonly<Record<string, string>>,
): AssistCard[] {
  return queries.map((query) => {
    const resolved = connectionForAssistQuery(connections, query.connection, {
      sql: query.sql,
      schemas,
    });
    return {
      id: nextId(),
      title: query.title,
      titledSql: query.sql,
      modelSql: query.sql,
      locked: false,
      sql: query.sql,
      connectionId: resolved.ok ? resolved.connection.id : null,
      connectionName: resolved.ok ? resolved.connection.name : query.connection,
      chart: query.chart,
      color: query.chart?.color ?? null,
      result: null,
      error: resolved.ok ? null : resolved.error,
      view: null,
      code: query.code,
      running: resolved.ok,
    };
  });
}

/** Cards for the saved queries attached to this question. A query that cannot run says why. */
function savedCards(picks: readonly AssistSavedPick[], connections: readonly DatabaseConnection[]): AssistCard[] {
  return picks.map((pick) => {
    const target =
      pick.connectionId === null ? null : (connections.find((item) => item.id === pick.connectionId) ?? null);
    const runnable = target === null ? null : assistRunnableStatement(pick.sql, target.type);
    const error =
      target === null
        ? "This saved query has no connected database."
        : runnable === null
          ? "AI Assist only runs read-only queries."
          : null;
    return {
      id: nextId(),
      title: pick.name,
      titledSql: pick.sql,
      modelSql: pick.sql,
      locked: true,
      sql: pick.sql,
      connectionId: target?.id ?? null,
      connectionName: target?.name ?? "",
      chart: null,
      color: null,
      result: null,
      error,
      view: null,
      code: null,
      running: error === null,
    };
  });
}

async function groundResults(input: {
  readonly source: AssistSettings["source"];
  readonly model: string;
  readonly apiKey: string;
  readonly question: string;
  readonly schemaContext: string;
  readonly databaseType: string;
  readonly history: readonly AssistHistoryTurn[];
  readonly results: ReturnType<typeof resultPayload>[];
  readonly pass: "final";
  readonly webSearch: boolean;
}): Promise<AssistPlan | null> {
  try {
    const response = await appFetch("/api/ai/assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return null;
    return acceptAssistPlan(body, input.databaseType, input.schemaContext);
  } catch {
    return null;
  }
}

function errorText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
    const text = body.error.trim();
    if (text !== "") return text;
  }
  return fallback;
}

const EMPTY_CONNECTIONS: readonly DatabaseConnection[] = [];
const EMPTY_SAVED: readonly AssistSavedPick[] = [];
const EMPTY_SCHEDULES: readonly AssistSchedule[] = [];

let savedRaw = "\u0000";
let savedSnapshot: readonly AssistSavedPick[] = EMPTY_SAVED;

function readSavedCatalog(): readonly AssistSavedPick[] {
  const next = assistSavedPicks(storage.getSavedQueries());
  const raw = JSON.stringify(next);
  if (raw === savedRaw) return savedSnapshot;
  savedRaw = raw;
  savedSnapshot = next;
  return savedSnapshot;
}

function subscribeSaved(): () => void {
  return () => {};
}

let connectionRaw = "\u0000";
let connectionSnapshot: readonly DatabaseConnection[] = EMPTY_CONNECTIONS;

function readConnections(): readonly DatabaseConnection[] {
  const next = storage.getConnections();
  const raw = JSON.stringify(next);
  if (raw === connectionRaw) return connectionSnapshot;
  connectionRaw = raw;
  connectionSnapshot = next;
  return connectionSnapshot;
}

function subscribeConnection(): () => void {
  return () => {};
}

function subscribeHydration(): () => void {
  return () => {};
}

function hydratedNow(): boolean {
  return typeof window !== "undefined";
}

function useHydrated(): boolean {
  return useSyncExternalStore(subscribeHydration, hydratedNow, hydratedNow);
}

function modelFor(settings: AssistSettings): string {
  if (settings.source === "fireworks") return settings.fireworksModel.trim();
  if (settings.source === "gateway") return settings.gatewayModel.trim();
  return settings.openRouterModel.trim();
}

function keyFor(settings: AssistSettings): string {
  if (settings.source === "fireworks") return settings.fireworksKey;
  if (settings.source === "gateway") return settings.gatewayKey;
  return settings.openRouterKey;
}

/** The AI Assist page: a chat that writes queries, draws charts, and explains them. Each chart keeps the SQL editor behind it. */
export function AiAssist() {
  const settings = useSyncExternalStore(subscribeAssistSettings, readAssistSettings, () => DEFAULT_ASSIST_SETTINGS);
  const updateSettings = (patch: Partial<AssistSettings>) => {
    writeAssistSettings({ ...settings, ...patch });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<readonly AssistModelOption[]>([]);
  const [gatewayModels, setGatewayModels] = useState<readonly AssistModelOption[]>([]);
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [gatewayStatus, setGatewayStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [rankings, setRankings] = useState<AssistRankings | null>(null);
  const [serverKey, setServerKey] = useState<boolean | null>(null);
  const hydrated = useHydrated();
  const connections = useSyncExternalStore(subscribeConnection, readConnections, () => EMPTY_CONNECTIONS);
  const [schemaAttempt, setSchemaAttempt] = useState(0);
  const schemaKey =
    connections.length === 0
      ? ""
      : `${connections.map((item) => `${item.id}:${item.name}:${item.type}`).join("|")}:${schemaAttempt}`;
  const [loadedSchema, setLoadedSchema] = useState<{
    key: string;
    context: string;
    notes: readonly string[];
    byConnection: Readonly<Record<string, string>>;
  } | null>(null);
  const schemaReady = loadedSchema !== null && loadedSchema.key === schemaKey;
  const schemaContext = schemaReady ? loadedSchema.context : "[]";
  const schemaNotes = schemaReady ? loadedSchema.notes : [];
  const schemas = schemaReady ? loadedSchema.byConnection : {};
  const storedTurns = useSyncExternalStore(subscribeTranscript, readTranscriptSnapshot, () => EMPTY_TURNS);
  const conversations = useSyncExternalStore(subscribeTranscript, readConversationSnapshot, () => EMPTY_BOOK);
  const [draftTurns, setDraftTurns] = useState<readonly Turn[] | null>(null);
  const turns = draftTurns ?? storedTurns;
  const threadRef = useRef<HTMLElement>(null);
  const chartsRef = useRef<HTMLElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<readonly AssistSavedPick[]>([]);
  const savedCatalog = useSyncExternalStore(subscribeSaved, readSavedCatalog, () => EMPTY_SAVED);
  const schedules = useSyncExternalStore(subscribeAssistSchedules, readAssistScheduleSnapshot, () => EMPTY_SCHEDULES);
  const attachedLive = attached.filter((item) => savedCatalog.some((pick) => pick.id === item.id));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [intervalText, setIntervalText] = useState("");
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameFor, setNameFor] = useState(conversations.activeId);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  if (nameFor !== conversations.activeId) {
    setNameFor(conversations.activeId);
    setNameDraft(null);
  }
  const activeConversation =
    conversations.conversations.find((item) => item.id === conversations.activeId) ?? conversations.conversations[0];
  const activeName = activeConversation?.name ?? DEFAULT_ASSIST_CONVERSATION_NAME;
  const [notice, setNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const sendRef = useRef<
    ((scheduled?: { readonly prompt: string; readonly sources: readonly AssistSavedPick[] }) => Promise<void>) | null
  >(null);
  const turnsRef = useRef<readonly Turn[]>([]);
  const mounted = useRef(true);

  const commit = useCallback((next: readonly Turn[], save: boolean) => {
    if (!mounted.current) return;
    turnsRef.current = next;
    if (save) {
      publishTranscript(next);
      setDraftTurns(null);
      return;
    }
    setDraftTurns(next);
  }, []);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns, turnsRef]);

  useEffect(() => {
    const rebound = rebindTurns(turnsRef.current, connections);
    if (rebound !== turnsRef.current) commit(rebound, true);
  }, [connections, commit]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Opening AI Assist, and each new reply, lands on the latest chart and the latest message.
  useLayoutEffect(() => {
    const pinToEnd = (node: HTMLElement | null) => {
      if (node === null) return;
      node.scrollTop = node.scrollHeight - node.clientHeight;
    };
    if (turns.length === 0) return;
    pinToEnd(chartsRef.current);
    pinToEnd(threadRef.current);
  }, [turns.length]);

  // Each saved prompt waits out its interval, then runs again. Sources are read
  // at that moment, so the queries run against whatever they say now.
  useEffect(() => {
    const handles = schedules.map((schedule) => {
      const delay = refreshDelayMs(schedule.seconds);
      if (delay === null) return 0;
      return window.setInterval(() => {
        const sources = schedule.sourceIds.flatMap((id) => {
          const pick = assistSavedPicks(storage.getSavedQueries()).find((item) => item.id === id);
          return pick === undefined ? [] : [pick];
        });
        if (schedule.prompt.trim() === "" && sources.length === 0) return;
        void sendRef.current?.({ prompt: schedule.prompt, sources });
      }, delay);
    });
    return () => {
      for (const handle of handles) window.clearInterval(handle);
    };
  }, [schedules]);

  useEffect(() => {
    let cancelled = false;
    void appFetch("/api/ai/assist")
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setModelStatus("failed");
          setGatewayStatus("failed");
          return;
        }
        const body: unknown = await response.json();
        const record = body !== null && typeof body === "object" ? body : null;
        const listed = record !== null && "models" in record ? normalizeModels(record.models) : [];
        const listedGateway = record !== null && "gatewayModels" in record ? normalizeModels(record.gatewayModels) : [];
        const hasServerKey = record !== null && "serverKey" in record ? record.serverKey === true : false;
        const gatewayFailed = record !== null && "gatewayCatalog" in record && record.gatewayCatalog === false;
        const listedRankings = readAssistRankings(record !== null && "rankings" in record ? record.rankings : null);
        if (cancelled) return;
        setModels(listed);
        setGatewayModels(listedGateway);
        setRankings(listedRankings);
        setServerKey(hasServerKey);
        setModelStatus("ready");
        setGatewayStatus(gatewayFailed ? "failed" : "ready");
      })
      .catch(() => {
        if (!cancelled) {
          setModelStatus("failed");
          setGatewayStatus("failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (schemaKey === "" || connections.length === 0) return;
    let cancelled = false;
    void loadAssistCatalog(connections, (connection) =>
      loadAssistSchema(
        connection,
        storage.getDataDictionary(connection.id),
        appFetch,
        storage.getActiveCatalog(connection.id),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      setLoadedSchema({
        key: schemaKey,
        context: loaded.schemaContext,
        notes: loaded.notes,
        byConnection: loaded.byConnection,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [connections, schemaKey]);

  const updateCard = (id: string, patch: Partial<AssistCard>, save: boolean) => {
    commit(
      turnsRef.current.map((turn) => ({
        ...turn,
        cards: turn.cards.map((card) => (card.id === id ? { ...card, ...patch } : card)),
      })),
      save,
    );
  };

  const runCard = async (id: string, connectionId: string | null, sql: string) => {
    commit(
      turnsRef.current.map((turn) => ({
        ...turn,
        cards: turn.cards.map((card) => {
          if (card.id !== id) return card;
          const changed = queryFilterShape(sql) !== queryFilterShape(card.titledSql);
          return {
            ...card,
            sql,
            title: changed ? titleForQuery(sql) : card.title,
            titledSql: sql,
            locked: queryFilterShape(sql) !== queryFilterShape(card.modelSql),
            chart: changed && card.chart !== null ? { ...card.chart, caption: "" } : card.chart,
            running: true,
            error: null,
          };
        }),
      })),
      false,
    );
    const target = connectionId === null ? null : (connections.find((item) => item.id === connectionId) ?? null);
    if (target === null) {
      updateCard(id, { running: false, error: "Connect a database in Traditional mode to run this query." }, true);
      return;
    }
    const statement = assistRunnableStatement(sql, target.type);
    if (statement === null) {
      updateCard(id, { running: false, error: "AI Assist only runs read-only queries." }, true);
      return;
    }
    const outcome = await runAssistQuery(target, statement, appFetch);
    updateCard(
      id,
      {
        running: false,
        ...(outcome.ok ? { result: outcome.result, error: null } : { error: outcome.error }),
      },
      true,
    );
  };

  const send = async (scheduled?: { readonly prompt: string; readonly sources: readonly AssistSavedPick[] }) => {
    const starting = scheduled === undefined ? attachedLive : scheduled.sources;
    const asked = assistSavedAsk(scheduled === undefined ? draft : scheduled.prompt, starting);
    if (asked.question === "" || sendingRef.current) return;
    const model = modelFor(settings);
    if (model === "") {
      setNotice("Name the model to use.");
      return;
    }
    const apiKey = keyFor(settings);
    const question = asked.question;
    const webSearch = assistModelSearches(settings.source, model, models, gatewayModels);
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    if (scheduled === undefined) {
      setDraft("");
      setAttached([]);
    }
    const history = historyOf(turnsRef.current, settings.historyMessages);
    const databaseType = assistDatabaseType(connections.map((item) => item.type));
    const at = askedAt();
    commit([...turnsRef.current, { id: nextId(), role: "user", text: asked.display, at, cards: [] }], true);
    try {
      const executeCards = async (batch: readonly AssistCard[]) => {
        await Promise.all(
          batch.map(async (card) => {
            const target =
              card.connectionId === null ? null : (connections.find((item) => item.id === card.connectionId) ?? null);
            if (target === null) return;
            const statement = assistRunnableStatement(card.sql, target.type);
            if (statement === null) {
              updateCard(card.id, { running: false, error: "AI Assist only runs read-only queries." }, true);
              return;
            }
            const outcome = await runAssistQuery(target, statement, appFetch);
            updateCard(
              card.id,
              {
                running: false,
                ...(outcome.ok ? { result: outcome.result, error: null } : { error: outcome.error }),
              },
              true,
            );
          }),
        );
      };
      const writeAnalysis = async (researchId: string, ids: Set<string>, fallback: string) => {
        const ran = turnsRef.current.flatMap((turn) => turn.cards).filter((card) => ids.has(card.id));
        const final = await groundResults({
          source: settings.source,
          model,
          apiKey,
          question,
          schemaContext,
          databaseType,
          history,
          webSearch,
          pass: "final",
          results: ran.map(resultPayload),
        });
        const analyzed = final?.explanation.trim() ?? "";
        commit(
          turnsRef.current.map((turn) =>
            turn.id === researchId ? { ...turn, text: analyzed === "" ? fallback : analyzed } : turn,
          ),
          true,
        );
      };
      if (starting.length > 0) {
        const seeded = savedCards(starting, connections);
        const researchId = nextId();
        const ids = new Set(seeded.map((card) => card.id));
        commit(
          [...turnsRef.current, { id: researchId, role: "assistant", text: "", at: askedAt(), cards: seeded }],
          true,
        );
        await executeCards(seeded);
        commit(
          turnsRef.current.map((turn) => ({
            ...turn,
            cards: turn.cards.map((card) => {
              if (!ids.has(card.id) || card.result === null || card.view !== null) return card;
              const view = suggestAssistChart(card.result);
              return view === null ? card : { ...card, view };
            }),
          })),
          true,
        );
        await writeAnalysis(researchId, ids, "The saved queries ran.");
        return;
      }
      const response = await appFetch("/api/ai/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: settings.source,
          model,
          apiKey,
          question,
          schemaContext,
          databaseType,
          history,
          webSearch,
          saved: assistSavedForPrompt(savedCatalog, connections),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        commit(
          [
            ...turnsRef.current,
            {
              id: nextId(),
              role: "assistant",
              text: errorText(body, "The assistant could not answer."),
              at: askedAt(),
              cards: [],
            },
          ],
          true,
        );
        return;
      }
      const answered = acceptAssistPlan(body, databaseType, schemaContext);
      const savedChart = answered.queries.length > 0 ? null : assistSavedChart(question, savedCatalog);
      const plan =
        savedChart === null
          ? answered
          : acceptAssistPlan(
              {
                explanation: answered.explanation,
                queries: [
                  {
                    title: savedChart.title,
                    connection: connections.find((item) => item.id === savedChart.connectionId)?.name ?? "",
                    sql: savedChart.sql,
                    chart: savedChart.chart,
                  },
                ],
              },
              databaseType,
              schemaContext,
            );
      const prior = turnsRef.current.flatMap((turn) =>
        turn.cards.map((card) => ({ sql: card.titledSql, title: card.title, locked: card.locked })),
      );
      const revised = questionOnlyRecolors(question)
        ? { revisions: [], queries: plan.queries }
        : reviseAssistCharts(plan.queries, editableCharts(turnsRef.current, settings.historyMessages));
      const follow = splitAssistFollowUp(revised.queries, prior);
      const recolors = [...follow.recolors, ...recolorsFromQuestion(question, prior)];
      const queries = questionOnlyRecolors(question) ? [] : follow.queries;
      const cards = plannedCards(queries, connections, schemas);
      const applied = applyChartRevisions(paint(turnsRef.current, recolors), revised.revisions, connections, schemas);
      const assistantId = nextId();
      commit(
        [
          ...applied.turns,
          {
            id: assistantId,
            role: "assistant",
            text: cards.length === 0 ? plan.explanation : "",
            at: askedAt(),
            cards,
          },
        ],
        true,
      );
      await executeCards([...applied.rerun, ...cards]);
      if (cards.length > 0) {
        await writeAnalysis(assistantId, new Set(cards.map((card) => card.id)), plan.explanation);
      }
    } catch {
      commit(
        [
          ...turnsRef.current,
          {
            id: nextId(),
            role: "assistant",
            text: "The assistant could not be reached.",
            at: askedAt(),
            cards: [],
          },
        ],
        true,
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  useEffect(() => {
    sendRef.current = send;
  });

  const saveSchedule = () => {
    const made = draftAssistSchedule({
      id: nextId(),
      prompt: draft,
      sourceIds: attachedLive.map((pick) => pick.id),
      intervalText,
      existing: schedules.length,
    });
    if (!made.ok) {
      setScheduleNote(made.error);
      return;
    }
    writeAssistSchedules([...schedules, made.schedule]);
    if (made.raised) {
      setIntervalText(String(made.schedule.seconds));
      setScheduleNote(`Raised to ${made.schedule.seconds} seconds, the shortest schedule.`);
      return;
    }
    setScheduleOpen(false);
    setIntervalText("");
    setScheduleNote(null);
  };

  const applyConversation = (change: { book: AssistConversationBook; turns: readonly AssistTranscriptTurn[] }) => {
    rememberBook(change.book);
    const live = rememberTurns(change.turns.map(fromStored));
    turnsRef.current = live;
    setDraftTurns(null);
    setDraft("");
    setAttached([]);
    setNotice(null);
    setConfirmClear(false);
    setConfirmDelete(false);
    notifyTranscript();
  };

  const openConversation = (id: string) => {
    if (sendingRef.current) return;
    const change = selectAssistConversation(
      readAssistConversations(Date.now()),
      id,
      storedOf(turnsRef.current),
      Date.now(),
    );
    if (change === null || change.turns === null) return;
    applyConversation({ book: change.book, turns: change.turns });
  };

  const startConversation = () => {
    if (sendingRef.current) return;
    const change = createAssistConversation(
      readAssistConversations(Date.now()),
      storedOf(turnsRef.current),
      Date.now(),
      nextId(),
    );
    if (change === null || change.turns === null) return;
    applyConversation({ book: change.book, turns: change.turns });
  };

  const commitName = () => {
    const current = readAssistConversations(Date.now());
    const renamed = renameAssistConversation(current, conversations.activeId, nameDraft ?? activeName, Date.now());
    setNameDraft(null);
    if (renamed === current) return;
    rememberBook(renamed);
    notifyTranscript();
  };

  const deleteConversation = () => {
    if (sendingRef.current) return;
    const change = removeAssistConversation(readAssistConversations(Date.now()), conversations.activeId, Date.now());
    if (change === null || change.turns === null) return;
    applyConversation({ book: change.book, turns: change.turns });
  };

  const canSend = (draft.trim() !== "" || attachedLive.length > 0) && !sending && modelFor(settings) !== "";

  const queries = turns.flatMap((turn) => turn.cards);
  const activeQuery = queries.at(-1) ?? null;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-sunken text-fg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3 sm:gap-3 sm:px-4">
        <MidstLockup className="shrink-0" markClassName="h-6 w-6" wordClassName="text-sm" />
        <p className="flex min-w-0 items-center justify-center gap-1.5 text-sm text-fg-muted">
          <span>Analytics</span>
          {activeQuery !== null && (
            <>
              <ChevronRight className="size-3.5 shrink-0" />
              <span className="truncate font-medium text-fg">{activeQuery.title}</span>
            </>
          )}
        </p>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-hairline bg-canvas py-1 pr-3 pl-1 text-xs font-medium text-fg sm:inline-flex">
            <span className="flex size-6 items-center justify-center rounded-full bg-brand-tint/20 text-[11px] font-semibold text-brand">
              K
            </span>
            KnowSQL
          </span>
          <ModeLinks page="assist" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden 2xl:flex-row">
        <main ref={chartsRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 2xl:px-8 2xl:py-6">
          {(hydrated && connections.length === 0) || schemaNotes.length > 0 ? (
            <div className="mx-auto mb-6 flex w-full max-w-5xl flex-col gap-3">
              {hydrated && connections.length === 0 && (
                <p className="text-sm text-fg-muted">
                  Add a database in Traditional mode to run the queries this page writes.
                </p>
              )}
              {schemaNotes.length > 0 && (
                <div className="rounded-lg border border-hairline-strong bg-raised px-3 py-2">
                  {schemaNotes.map((note) => (
                    <output key={note} className="block text-xs text-fg-muted">
                      {note}
                    </output>
                  ))}
                  <button
                    type="button"
                    className="mt-1 text-xs text-brand underline"
                    onClick={() => setSchemaAttempt((current) => current + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {turns.length === 0 && (
            <div className="mx-auto w-full max-w-lg rounded-xl border border-hairline bg-raised px-6 py-12 text-center shadow-sm">
              <Sparkles aria-hidden="true" strokeWidth={1.5} className="mx-auto mb-3 h-8 w-8 text-brand" />
              <h1 className="text-lg font-medium text-fg">How can I help?</h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
                {connections.length === 0
                  ? "Connect a database, then ask about its tables."
                  : "Ask about any connected database. The assistant writes a query, draws a chart, and explains what it shows. The SQL editor sits behind each chart."}
              </p>
            </div>
          )}
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
            {turns.map((turn) =>
              turn.role !== "assistant" ? null : (
                <section key={turn.id} aria-label="AI reply" className="flex flex-col gap-8">
                  {turn.text !== "" && (
                    <div className="space-y-1 text-sm leading-6 text-fg [&_h4]:text-sm [&_h4]:font-medium [&_h4]:text-fg [&_li]:text-sm [&_li]:leading-6 [&_li]:text-fg [&_p]:text-sm [&_p]:leading-6 [&_p]:text-fg">
                      {renderProse(turn.text)}
                    </div>
                  )}
                  {turn.cards.map((card) => {
                    const target =
                      card.connectionId === null
                        ? undefined
                        : connections.find((item) => item.id === card.connectionId);
                    return (
                      <ChartWithEditor
                        key={card.id}
                        title={card.title}
                        sql={card.sql}
                        connectionId={card.connectionId ?? undefined}
                        databaseType={target?.type}
                        schemaContext={
                          card.connectionId === null ? schemaContext : (schemas[card.connectionId] ?? schemaContext)
                        }
                        result={card.result}
                        error={card.error}
                        chart={card.chart}
                        color={card.color}
                        running={card.running}
                        savedView={card.view}
                        savedCode={card.code}
                        onRemember={(view, code) => {
                          const current = turnsRef.current
                            .flatMap((item) => item.cards)
                            .find((item) => item.id === card.id);
                          if (current === undefined || (sameChartView(current.view, view) && current.code === code))
                            return;
                          updateCard(card.id, { view, code }, true);
                        }}
                        onSqlChange={(sql) => updateCard(card.id, { sql }, false)}
                        onRun={(sql) => void runCard(card.id, card.connectionId, sql)}
                      />
                    );
                  })}
                </section>
              ),
            )}
          </div>
        </main>

        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-surface 2xl:h-full 2xl:w-96 2xl:overflow-hidden 2xl:border-t-0 2xl:border-l">
          <div className="flex shrink-0 flex-col gap-2 border-b border-hairline px-4 py-3">
            <div className="flex items-center gap-2">
              <select
                aria-label="Conversations"
                value={conversations.activeId}
                disabled={sending}
                onChange={(event) => openConversation(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
              >
                {conversations.conversations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="New conversation"
                disabled={sending}
                onClick={startConversation}
                className="shrink-0 rounded-lg border border-hairline px-2 py-1 text-xs font-medium text-fg hover:bg-fill-subtle disabled:opacity-50"
              >
                New
              </button>
              {confirmDelete && (
                <button
                  type="button"
                  aria-label="Confirm delete conversation"
                  onClick={deleteConversation}
                  className="shrink-0 rounded px-2 py-1 text-xs font-medium text-fg hover:bg-fill-subtle"
                >
                  Confirm
                </button>
              )}
              <button
                type="button"
                aria-label="Delete conversation"
                aria-pressed={confirmDelete}
                disabled={sending}
                onClick={() => {
                  setConfirmClear(false);
                  setConfirmDelete((current) => !current);
                }}
                className={`shrink-0 rounded px-2 py-1 text-xs font-medium hover:bg-fill-subtle disabled:opacity-50 ${confirmDelete ? "bg-fill-subtle text-fg" : "text-fg-muted"}`}
              >
                Delete
              </button>
            </div>
            <input
              aria-label="Conversation name"
              value={nameDraft ?? activeName}
              placeholder="Name this conversation"
              maxLength={ASSIST_CONVERSATION_NAME_CAP}
              disabled={sending}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitName();
              }}
              className="w-full rounded-lg border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
            />
          </div>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-4 py-3">
            <div className="flex min-w-0 items-start gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-fg">Ask KnowSQL AI</h2>
                <p className="text-xs text-fg-muted">Refine your query and explore insights</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {turns.length > 0 && (
                <>
                  {confirmClear && (
                    <button
                      type="button"
                      aria-label="Confirm clear chat"
                      onClick={() => {
                        commit([], true);
                        setConfirmClear(false);
                        setSchemaAttempt((current) => current + 1);
                      }}
                      className="rounded px-2 py-1 text-xs font-medium text-fg hover:bg-fill-subtle"
                    >
                      Confirm
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Clear chat"
                    title="Clear chat"
                    aria-pressed={confirmClear}
                    disabled={sending}
                    onClick={() => setConfirmClear((current) => !current)}
                    className={`rounded p-1 hover:bg-fill-subtle hover:text-fg disabled:opacity-50 ${confirmClear ? "bg-fill-subtle text-fg" : "text-fg-muted"}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              )}
              <button
                type="button"
                aria-label="New query"
                onClick={() => askRef.current?.focus()}
                className="rounded p-1 text-fg-muted hover:bg-fill-subtle hover:text-fg"
              >
                <Plus className="size-3.5" />
              </button>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-fill-subtle px-2 py-1 text-xs text-fg-secondary">
                <span className="size-1.5 rounded-full bg-success" />
                Ready
              </span>
            </div>
          </div>
          <section
            ref={threadRef}
            aria-label="Conversation"
            className="h-40 overflow-y-auto px-4 py-4 2xl:h-auto 2xl:min-h-0 2xl:flex-1"
          >
            <div className="flex flex-col gap-4">
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <section key={turn.id}>
                    <p className="text-xs font-medium text-fg-muted">You</p>
                    <p className="mt-1 rounded-xl bg-brand-tint/15 px-3 py-2 text-sm text-fg">{turn.text}</p>
                  </section>
                ) : null,
              )}
            </div>
          </section>
          <form
            className="shrink-0 border-t border-hairline px-4 py-3 2xl:max-h-[70%] 2xl:overflow-y-auto"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="flex flex-col gap-3">
              <AssistModelFields
                settings={settings}
                models={models}
                gatewayModels={gatewayModels}
                modelStatus={modelStatus}
                gatewayStatus={gatewayStatus}
                rankings={rankings}
                open={settingsOpen}
                onToggle={() => setSettingsOpen((current) => !current)}
                onChange={updateSettings}
                accessory={
                  <HistoryLimitButton
                    value={settings.historyMessages}
                    onChange={(historyMessages) => updateSettings({ historyMessages })}
                  />
                }
              />
              {notice !== null && (
                <p role="alert" className="text-xs text-danger">
                  {notice}
                </p>
              )}
              {serverKey === true && settings.source === "openrouter" && settings.openRouterKey.trim() === "" && (
                <p className="text-xs text-fg-muted">Using the server OpenRouter key.</p>
              )}
              {serverKey === false && settings.source === "openrouter" && settings.openRouterKey.trim() === "" && (
                <p className="text-xs text-fg-muted">
                  This server has no OpenRouter key. Set OPENROUTER_API_KEY on the running app and redeploy, or add a
                  key under Connectors.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {schedules.length > 0 && (
                  <ul aria-label="Scheduled prompts" className="flex flex-col gap-1">
                    {schedules.map((schedule) => {
                      const label = assistScheduleLabel(schedule, savedCatalog);
                      return (
                        <li key={schedule.id} className="flex items-center justify-between gap-2 text-xs text-fg">
                          <span className="min-w-0 truncate">{label}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${label}`}
                            onClick={() => writeAssistSchedules(schedules.filter((item) => item.id !== schedule.id))}
                            className="shrink-0 rounded px-1.5 py-0.5 text-fg-muted hover:bg-fill-subtle hover:text-fg"
                          >
                            Remove
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {scheduleOpen ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-fg-muted">
                      Every
                      <input
                        aria-label="Schedule seconds"
                        inputMode="numeric"
                        value={intervalText}
                        onChange={(event) => setIntervalText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          saveSchedule();
                        }}
                        className="h-7 w-20 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
                      />
                      seconds
                    </label>
                    <button
                      type="button"
                      onClick={saveSchedule}
                      className="rounded-full border border-hairline px-3 py-1 text-xs font-medium text-fg hover:bg-fill-subtle"
                    >
                      Save schedule
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleOpen(false);
                        setScheduleNote(null);
                      }}
                      className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-fill-subtle"
                    >
                      Cancel
                    </button>
                    {scheduleNote !== null && <p className="text-xs text-fg-muted">{scheduleNote}</p>}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setScheduleNote(null);
                      setScheduleOpen(true);
                    }}
                    className="self-start rounded-full border border-hairline px-3 py-1 text-xs font-medium text-fg hover:bg-fill-subtle"
                  >
                    Schedule
                  </button>
                )}
              </div>
              <AssistPromptBox
                label="How can I help?"
                value={draft}
                sending={sending}
                disabled={!canSend}
                onChange={setDraft}
                onSubmit={() => void send()}
                inputRef={askRef}
                savedChoices={savedCatalog.map((pick) => ({
                  id: pick.id,
                  name: pick.name,
                  detail: pick.connectionType,
                }))}
                selectedSavedIds={attachedLive.map((pick) => pick.id)}
                onToggleSaved={(id) => {
                  const pick = savedCatalog.find((item) => item.id === id);
                  if (pick === undefined) return;
                  setAttached((current) => toggleAssistSaved(current, pick));
                }}
              />
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
}
