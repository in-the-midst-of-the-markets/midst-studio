"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Plus, Sparkles } from "lucide-react";
import { ChartWithEditor } from "@/components/ai-assist/ChartWithEditor";
import { ModeLinks } from "@/components/ai-assist/AssistModeToggle";
import { MidstLockup } from "@/components/midst-logo";
import { appFetch } from "@/lib/config/base-path";
import { assistDatabaseType, loadAssistCatalog } from "@/lib/ai/assist-catalog";
import {
  ASSIST_TRANSCRIPT_KEY,
  readAssistTranscript,
  writeAssistTranscript,
  type AssistTranscriptTurn,
} from "@/lib/ai/assist-history";
import {
  acceptAssistPlan,
  explanationWithEdits,
  questionOnlyRecolors,
  recolorsFromQuestion,
  splitAssistFollowUp,
  type AssistChart,
  type AssistHistoryTurn,
  type AssistPlan,
  type AssistQueryPlan,
  type AssistRecolor,
} from "@/lib/ai/assist-plan";
import { ASSIST_RESULT_CAP, explanationWithResults, followUpQueries, readAssistResults } from "@/lib/ai/assist-reading";
import { isReadOnlySql } from "@/lib/ai/assist-readonly";
import { titleForQuery } from "@/lib/ai/assist-chart";
import { applyQueryFilters, queryFilterShape, queryIdentity } from "@/lib/charts/query-filters";
import { connectionForAssistQuery, rebindAssistCard, runAssistQuery } from "@/lib/ai/assist-query";
import { loadAssistSchema } from "@/lib/ai/assist-schema";
import {
  COMMON_OPENROUTER_MODELS,
  DEFAULT_ASSIST_SETTINGS,
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

function publishTranscript(turns: readonly Turn[]): void {
  writeAssistTranscript(storedOf(turns), Date.now());
  transcriptSnapshot = turns;
  transcriptRaw = localStorage.getItem(ASSIST_TRANSCRIPT_KEY) ?? "";
  for (const listener of transcriptListeners) listener();
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
    })),
  }));
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

function historyOf(turns: readonly Turn[]): AssistHistoryTurn[] {
  const pairs: AssistHistoryTurn[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const next = turns[index + 1];
    if (turn?.role === "user" && next?.role === "assistant") {
      const edited = next.cards.filter((card) => card.locked).map((card) => card.sql);
      const results = readAssistResults(next.cards.slice(0, ASSIST_RESULT_CAP).map(resultPayload));
      const explanation = explanationWithResults(
        explanationWithEdits(next.text, edited),
        results.ok ? results.value : [],
      );
      pairs.push({ question: turn.text, explanation });
    }
  }
  return pairs.slice(-6);
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
      running: resolved.ok,
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
  readonly pass: "follow" | "final";
}): Promise<AssistPlan | null> {
  try {
    const response = await appFetch("/api/ai/assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return null;
    return acceptAssistPlan(body);
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

function SourceChoice({
  value,
  checked,
  label,
  onSelect,
}: {
  value: AssistSettings["source"];
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-fg ${checked ? "bg-brand-tint/15" : ""}`}
    >
      <input
        type="radio"
        name="assist-source"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-brand" : "border-hairline-strong"}`}
      >
        {checked ? <span className="size-2 rounded-full bg-brand" /> : null}
      </span>
      {label}
    </label>
  );
}

function providerNote(source: AssistSettings["source"], serverKey: boolean | null): string {
  if (source === "fireworks") return "Saved in this browser. A Fireworks model uses the key you save here.";
  if (source === "gateway") return "Saved in this browser. Vercel AI Gateway uses the key you save here.";
  if (serverKey === true) {
    return "Saved in this browser. The OpenRouter key can stay blank; this server already has one.";
  }
  return "Saved in this browser. Leave the OpenRouter key blank to use the server's key.";
}

function SavedKeyField({
  label,
  stored,
  placeholder,
  onSave,
}: {
  label: string;
  stored: string;
  placeholder?: string;
  onSave: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const saved = stored.trim() !== "";
  const showInput = !saved || replacing;
  let action: ReactNode = null;
  if (!showInput) {
    action = (
      <button
        type="button"
        aria-label={`Replace ${label}`}
        onClick={() => {
          setDraft("");
          setReplacing(true);
        }}
        className="text-xs font-medium text-fg-muted hover:text-fg"
      >
        Replace
      </button>
    );
  } else if (draft.trim() !== "" || saved) {
    action = (
      <button
        type="button"
        aria-label={`Save ${label}`}
        onClick={() => {
          onSave(draft.trim());
          setDraft("");
          setReplacing(false);
        }}
        className="rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
      >
        Save
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        {showInput ? (
          <input
            type="password"
            aria-label={label}
            autoComplete="off"
            placeholder={placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
          />
        ) : (
          <output className="text-sm text-fg">API key saved</output>
        )}
        {action}
      </span>
    </div>
  );
}

/**
 * The AI Assist page: a chat that writes queries, draws charts, and explains them.
 * Each chart keeps the SQL editor behind it.
 */
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
  const [draftTurns, setDraftTurns] = useState<readonly Turn[] | null>(null);
  const turns = draftTurns ?? storedTurns;
  const threadRef = useRef<HTMLElement>(null);
  const chartsRef = useRef<HTMLElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
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
        if (cancelled) return;
        setModels(listed);
        setGatewayModels(listedGateway);
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
    const statement = applyQueryFilters(sql);
    if (!isReadOnlySql(statement)) {
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

  const send = async () => {
    const question = draft.trim();
    if (question === "" || sendingRef.current) return;
    const model = modelFor(settings);
    if (model === "") {
      setNotice("Name the model to use.");
      return;
    }
    const apiKey = keyFor(settings);
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    setDraft("");
    const history = historyOf(turnsRef.current);
    const at = askedAt();
    commit([...turnsRef.current, { id: nextId(), role: "user", text: question, at, cards: [] }], true);
    try {
      const response = await appFetch("/api/ai/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: settings.source,
          model,
          apiKey,
          question,
          schemaContext,
          databaseType: assistDatabaseType(connections.map((item) => item.type)),
          history,
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
      const plan = acceptAssistPlan(body);
      const prior = turnsRef.current.flatMap((turn) =>
        turn.cards.map((card) => ({ sql: card.titledSql, title: card.title, locked: card.locked })),
      );
      const follow = splitAssistFollowUp(plan.queries, prior);
      const recolors = [...follow.recolors, ...recolorsFromQuestion(question, prior)];
      const queries = questionOnlyRecolors(question) ? [] : follow.queries;
      const cards = plannedCards(queries, connections, schemas);
      const assistantId = nextId();
      const databaseType = assistDatabaseType(connections.map((item) => item.type));
      commit(
        [
          ...paint(turnsRef.current, recolors),
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
      const executeCards = async (batch: readonly AssistCard[]) => {
        await Promise.all(
          batch.map(async (card) => {
            const target =
              card.connectionId === null ? null : (connections.find((item) => item.id === card.connectionId) ?? null);
            if (target === null) return;
            const outcome = await runAssistQuery(target, applyQueryFilters(card.sql), appFetch);
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
      await executeCards(cards);
      if (cards.length > 0) {
        const ids = new Set(cards.map((card) => card.id));
        const ranCards = () => turnsRef.current.flatMap((turn) => turn.cards).filter((card) => ids.has(card.id));
        const readingInput = {
          source: settings.source,
          model,
          apiKey,
          question,
          schemaContext,
          databaseType,
          history,
        };
        const follow = await groundResults({ ...readingInput, pass: "follow", results: ranCards().map(resultPayload) });
        const existingSql = turnsRef.current.flatMap((turn) => turn.cards).map((card) => card.titledSql);
        const extra = follow === null ? [] : followUpQueries(follow.queries, existingSql);
        const extraCards = plannedCards(extra, connections, schemas);
        for (const card of extraCards) ids.add(card.id);
        if (extraCards.length > 0) {
          commit(
            turnsRef.current.map((turn) =>
              turn.id === assistantId ? { ...turn, cards: [...turn.cards, ...extraCards] } : turn,
            ),
            true,
          );
          await executeCards(extraCards);
        }
        const final = await groundResults({ ...readingInput, pass: "final", results: ranCards().map(resultPayload) });
        const analyzed = [final, follow].map((item) => item?.explanation.trim() ?? "").find((text) => text !== "");
        commit(
          turnsRef.current.map((turn) =>
            turn.id === assistantId ? { ...turn, text: analyzed ?? plan.explanation } : turn,
          ),
          true,
        );
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

  const catalog = modelStatus === "ready" && models.length > 0 ? models : COMMON_OPENROUTER_MODELS;
  const modelOptions = catalog.some((item) => item.id === settings.openRouterModel)
    ? catalog
    : [{ id: settings.openRouterModel, name: settings.openRouterModel }, ...catalog];
  const canSend = draft.trim() !== "" && !sending && modelFor(settings) !== "";

  const queries = turns.flatMap((turn) => turn.cards);
  const activeQuery = queries.at(-1) ?? null;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-sunken text-fg">
      <header className="grid h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline bg-surface px-4">
        <MidstLockup className="min-w-0" markClassName="h-6 w-6" wordClassName="text-sm" />
        <p className="flex min-w-0 items-center justify-center gap-1.5 text-sm text-fg-muted">
          <span>Analytics</span>
          {activeQuery !== null && (
            <>
              <ChevronRight className="size-3.5 shrink-0" />
              <span className="truncate font-medium text-fg">{activeQuery.title}</span>
            </>
          )}
        </p>
        <div className="flex items-center justify-end gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-hairline bg-canvas py-1 pr-3 pl-1 text-xs font-medium text-fg sm:inline-flex">
            <span className="flex size-6 items-center justify-center rounded-full bg-brand-tint/20 text-[11px] font-semibold text-brand">
              M
            </span>
            Midst
          </span>
          <ModeLinks page="assist" variant="outline" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden 2xl:flex-row">
        <main ref={chartsRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5 2xl:px-8 2xl:py-6">
          {(hydrated && connections.length === 0) || (hydrated && connections.length > 1) || schemaNotes.length > 0 ? (
            <div className="mx-auto mb-6 flex w-full max-w-5xl flex-col gap-3">
              {hydrated && connections.length === 0 && (
                <p className="text-sm text-fg-muted">
                  Add a database in Traditional mode to run the queries this page writes.
                </p>
              )}
              {hydrated && connections.length > 1 && (
                <ul aria-label="Connected databases" className="flex flex-wrap gap-x-4 gap-y-1">
                  {connections.map((item) => (
                    <li key={item.id} className="truncate text-xs text-fg">
                      {item.name}
                      <span className="text-fg-muted"> · {item.type}</span>
                    </li>
                  ))}
                </ul>
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
              turn.cards.map((card) => {
                const target =
                  card.connectionId === null ? undefined : connections.find((item) => item.id === card.connectionId);
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
                    onSqlChange={(sql) => updateCard(card.id, { sql }, false)}
                    onRun={(sql) => void runCard(card.id, card.connectionId, sql)}
                  />
                );
              }),
            )}
          </div>
        </main>

        <aside className="flex w-full shrink-0 flex-col border-t border-hairline bg-surface 2xl:h-full 2xl:w-96 2xl:overflow-hidden 2xl:border-t-0 2xl:border-l">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-4 py-3">
            <div className="flex min-w-0 items-start gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint/15 text-brand">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-fg">Ask Midst AI</h2>
                <p className="text-xs text-fg-muted">Refine your query and explore insights</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
                ) : (
                  <section key={turn.id}>
                    {turn.text !== "" && (
                      <>
                        <p className="text-xs font-medium text-fg-muted">AI</p>
                        <p className="mt-1 rounded-xl bg-fill-subtle px-3 py-2 text-sm leading-6 text-fg-secondary">
                          {turn.text}
                        </p>
                      </>
                    )}
                  </section>
                ),
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
            <div className="flex flex-col gap-2">
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
                  key under Model.
                </p>
              )}
              <div className="flex items-center gap-2 rounded-xl border border-hairline-strong bg-canvas p-2">
                <Sparkles className="size-4 shrink-0 text-brand" />
                <textarea
                  ref={askRef}
                  aria-label="How can I help?"
                  value={draft}
                  placeholder="Ask about your data"
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  className="min-h-9 flex-1 resize-none bg-transparent py-1 text-sm text-fg outline-none"
                />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="rounded-lg bg-brand-solid px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
              <div>
                <button
                  type="button"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((current) => !current)}
                  className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted hover:text-fg"
                >
                  Model
                </button>
                {settingsOpen && (
                  <div className="mt-3 flex flex-col gap-3">
                    <fieldset className="m-0 flex flex-wrap gap-x-1 gap-y-1 border-0 p-0">
                      <legend className="sr-only">Model provider</legend>
                      <SourceChoice
                        value="openrouter"
                        label="OpenRouter"
                        checked={settings.source === "openrouter"}
                        onSelect={() => updateSettings({ source: "openrouter" })}
                      />
                      <SourceChoice
                        value="fireworks"
                        label="Fireworks AI"
                        checked={settings.source === "fireworks"}
                        onSelect={() => updateSettings({ source: "fireworks" })}
                      />
                      <SourceChoice
                        value="gateway"
                        label="Vercel AI Gateway"
                        checked={settings.source === "gateway"}
                        onSelect={() => updateSettings({ source: "gateway" })}
                      />
                    </fieldset>
                    <p className="text-sm text-fg-muted">{providerNote(settings.source, serverKey)}</p>
                    {settings.source === "openrouter" && (
                      <div className="grid grid-cols-2 gap-3">
                        <SavedKeyField
                          label="OpenRouter API key"
                          stored={settings.openRouterKey}
                          placeholder="sk-or-..."
                          onSave={(openRouterKey) => updateSettings({ openRouterKey })}
                        />
                        <label className="flex flex-col gap-1 text-xs text-fg-muted">
                          Model
                          <select
                            aria-label="OpenRouter model"
                            value={settings.openRouterModel}
                            onChange={(event) => updateSettings({ openRouterModel: event.target.value })}
                            className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
                          >
                            {modelOptions.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {modelStatus === "failed" && (
                          <output className="col-span-2 block text-xs text-fg-muted">
                            The OpenRouter catalog could not be loaded.
                          </output>
                        )}
                      </div>
                    )}
                    {settings.source === "fireworks" && (
                      <div className="grid grid-cols-2 gap-3">
                        <SavedKeyField
                          label="Fireworks API key"
                          stored={settings.fireworksKey}
                          onSave={(fireworksKey) => updateSettings({ fireworksKey })}
                        />
                        <label className="flex flex-col gap-1 text-xs text-fg-muted">
                          Fine-tuned model
                          <input
                            aria-label="Fireworks model"
                            value={settings.fireworksModel}
                            placeholder="accounts/your-account/models/your-model"
                            onChange={(event) => updateSettings({ fireworksModel: event.target.value })}
                            className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
                          />
                        </label>
                      </div>
                    )}
                    {settings.source === "gateway" && (
                      <div className="grid grid-cols-2 gap-3">
                        <SavedKeyField
                          label="Vercel AI Gateway API key"
                          stored={settings.gatewayKey}
                          onSave={(gatewayKey) => updateSettings({ gatewayKey })}
                        />
                        <label className="flex flex-col gap-1 text-xs text-fg-muted">
                          Model
                          <input
                            aria-label="Vercel AI Gateway model"
                            list="vercel-gateway-models"
                            value={settings.gatewayModel}
                            placeholder="provider/model"
                            onChange={(event) => updateSettings({ gatewayModel: event.target.value })}
                            className="rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-fg"
                          />
                          <datalist id="vercel-gateway-models">
                            {gatewayModels.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </datalist>
                        </label>
                        {gatewayStatus === "failed" && (
                          <output className="col-span-2 block text-xs text-fg-muted">
                            The Vercel AI Gateway catalog could not be loaded.
                          </output>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </form>
        </aside>
      </div>
    </div>
  );
}
