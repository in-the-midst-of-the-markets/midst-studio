"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LayoutDashboard } from "lucide-react";
import { ChartWithEditor } from "@/components/ai-assist/ChartWithEditor";
import { AssistModeToggle, OtherModeLink } from "@/components/ai-assist/AssistModeToggle";
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
  type AssistRecolor,
} from "@/lib/ai/assist-plan";
import { isReadOnlySql } from "@/lib/ai/assist-readonly";
import { titleForQuery } from "@/lib/ai/assist-chart";
import { applyQueryFilters, queryFilterShape, queryIdentity } from "@/lib/charts/query-filters";
import { connectionForAssistQuery, runAssistQuery } from "@/lib/ai/assist-query";
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
import { cn } from "@/lib/utils";
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

function historyOf(turns: readonly Turn[]): AssistHistoryTurn[] {
  const pairs: AssistHistoryTurn[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const next = turns[index + 1];
    if (turn?.role === "user" && next?.role === "assistant") {
      const edited = next.cards.filter((card) => card.locked).map((card) => card.sql);
      pairs.push({ question: turn.text, explanation: explanationWithEdits(next.text, edited) });
    }
  }
  return pairs.slice(-6);
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
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "failed">("loading");
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
  const threadRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const turnsRef = useRef<readonly Turn[]>([]);
  const mounted = useRef(true);

  const commit = (next: readonly Turn[], save: boolean) => {
    if (!mounted.current) return;
    turnsRef.current = next;
    if (save) {
      publishTranscript(next);
      setDraftTurns(null);
      return;
    }
    setDraftTurns(next);
  };

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns, turnsRef]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A saved conversation is taller than the pane, so opening AI Assist lands on the
  // latest message. A new reply grows the thread, and the same position keeps it in view.
  useEffect(() => {
    const node = threadRef.current;
    if (node === null || turns.length === 0) return;
    node.scrollTop = node.scrollHeight - node.clientHeight;
  }, [turns.length]);

  useEffect(() => {
    let cancelled = false;
    void appFetch("/api/ai/assist")
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setModelStatus("failed");
          return;
        }
        const body: unknown = await response.json();
        const listed =
          body !== null && typeof body === "object" && "models" in body ? normalizeModels(body.models) : [];
        const hasServerKey =
          body !== null && typeof body === "object" && "serverKey" in body ? body.serverKey === true : false;
        if (cancelled) return;
        setModels(listed);
        setServerKey(hasServerKey);
        setModelStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setModelStatus("failed");
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
        result: outcome.ok ? outcome.result : null,
        error: outcome.ok ? null : outcome.error,
      },
      true,
    );
  };

  const send = async () => {
    const question = draft.trim();
    if (question === "" || sendingRef.current) return;
    const model = settings.source === "openrouter" ? settings.openRouterModel.trim() : settings.fireworksModel.trim();
    if (model === "") {
      setNotice("Name the model to use.");
      return;
    }
    const apiKey = settings.source === "openrouter" ? settings.openRouterKey : settings.fireworksKey;
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
      const cards: AssistCard[] = queries.map((query) => {
        const resolved = connectionForAssistQuery(connections, query.connection);
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
      commit(
        [
          ...paint(turnsRef.current, recolors),
          { id: nextId(), role: "assistant", text: plan.explanation, at: askedAt(), cards },
        ],
        true,
      );
      await Promise.all(
        cards.map(async (card) => {
          const target =
            card.connectionId === null ? null : (connections.find((item) => item.id === card.connectionId) ?? null);
          if (target === null) return;
          const outcome = await runAssistQuery(target, applyQueryFilters(card.sql), appFetch);
          updateCard(
            card.id,
            {
              running: false,
              result: outcome.ok ? outcome.result : null,
              error: outcome.ok ? null : outcome.error,
            },
            true,
          );
        }),
      );
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
  const canSend =
    draft.trim() !== "" &&
    !sending &&
    (settings.source === "openrouter" ? settings.openRouterModel.trim() : settings.fireworksModel.trim()) !== "";

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-sunken text-fg">
      <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-hairline bg-surface px-4">
        <MidstLockup className="min-w-0" markClassName="h-6 w-6" wordClassName="text-sm" />
        <AssistModeToggle mode="assist" />
        <div className="flex justify-end">
          <OtherModeLink mode="assist" />
        </div>
      </header>

      <section ref={threadRef} aria-label="Conversation" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 md:px-6">
          {hydrated && connections.length === 0 && (
            <p className="text-sm text-fg-muted">
              Add a database in Traditional mode to run the queries this page writes.
            </p>
          )}
          {hydrated && connections.length > 1 && (
            <ul aria-label="Connected databases" className="flex flex-wrap gap-2">
              {connections.map((item) => (
                <li
                  key={item.id}
                  className="rounded-full border border-hairline-strong bg-raised px-2.5 py-0.5 text-xs text-fg"
                >
                  {item.name}
                  <span className="text-fg-muted"> · {item.type}</span>
                </li>
              ))}
            </ul>
          )}
          {schemaNotes.length > 0 && (
            <div className="rounded-lg border border-hairline-strong bg-raised px-3 py-2">
              {schemaNotes.map((note) => (
                <output key={note} className="block text-sm text-fg-muted">
                  {note}
                </output>
              ))}
              <button
                type="button"
                className="mt-1 text-sm text-brand underline"
                onClick={() => setSchemaAttempt((current) => current + 1)}
              >
                Retry
              </button>
            </div>
          )}
          {turns.length === 0 && (
            <div className="mx-auto w-full max-w-lg rounded-lg border border-hairline-strong bg-raised px-6 py-12 text-center">
              <LayoutDashboard aria-hidden="true" strokeWidth={1.5} className="mx-auto mb-3 h-8 w-8 text-fg-muted" />
              <h1 className="text-lg font-medium text-fg">How can I help?</h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
                {connections.length === 0
                  ? "Connect a database, then ask about its tables."
                  : "Ask about any connected database. The assistant writes a query, draws a chart, and explains what it shows. The SQL editor sits behind each chart."}
              </p>
            </div>
          )}
          {turns.map((turn) =>
            turn.role === "user" ? (
              <section key={turn.id} className="flex justify-end">
                <p className="max-w-xl rounded-2xl bg-brand-solid px-4 py-2 text-sm text-white">{turn.text}</p>
              </section>
            ) : (
              <section key={turn.id} className="flex flex-col gap-4">
                {turn.text !== "" && (
                  <p className="rounded-lg border border-hairline-strong bg-raised px-4 py-3 text-sm leading-6 text-fg-secondary">
                    {turn.text}
                  </p>
                )}
                {turn.cards.length > 0 && (
                  <div className={cn("grid grid-cols-1 gap-4", turn.cards.length > 1 && "lg:grid-cols-2")}>
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
                          connectionName={card.connectionName}
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
                    })}
                  </div>
                )}
              </section>
            ),
          )}
        </div>
      </section>

      <form
        className="shrink-0 border-t border-hairline bg-surface px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
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
              This server has no OpenRouter key. Set OPENROUTER_API_KEY on the running app and redeploy, or add a key
              under Model.
            </p>
          )}
          <div className="flex items-end gap-2 rounded-xl border border-hairline-strong bg-raised p-2">
            <textarea
              aria-label="How can I help?"
              value={draft}
              placeholder="How can I help?"
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="min-h-16 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-fg outline-none"
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
              className="text-xs font-medium text-fg-muted hover:text-fg"
            >
              Model
            </button>
            {settingsOpen && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <fieldset className="m-0 flex gap-3 border-0 p-0">
                  <legend className="sr-only">Model provider</legend>
                  <label className="flex items-center gap-1.5 text-xs text-fg">
                    <input
                      type="radio"
                      name="assist-source"
                      value="openrouter"
                      checked={settings.source === "openrouter"}
                      onChange={() => updateSettings({ source: "openrouter" })}
                    />
                    OpenRouter
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-fg">
                    <input
                      type="radio"
                      name="assist-source"
                      value="fireworks"
                      checked={settings.source === "fireworks"}
                      onChange={() => updateSettings({ source: "fireworks" })}
                    />
                    Fireworks AI
                  </label>
                </fieldset>
                <p className="text-xs text-fg-muted sm:col-span-2">
                  {serverKey
                    ? "Saved in this browser. The OpenRouter key can stay blank; this server already has one."
                    : "Saved in this browser. Leave the OpenRouter key blank to use the server's key."}
                </p>
                {settings.source === "openrouter" ? (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      OpenRouter API key
                      <input
                        type="password"
                        aria-label="OpenRouter API key"
                        autoComplete="off"
                        value={settings.openRouterKey}
                        onChange={(event) => updateSettings({ openRouterKey: event.target.value })}
                        className="rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Model
                      <select
                        aria-label="OpenRouter model"
                        value={settings.openRouterModel}
                        onChange={(event) => updateSettings({ openRouterModel: event.target.value })}
                        className="rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
                      >
                        {modelOptions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {modelStatus === "failed" && (
                      <output className="block text-xs text-fg-muted sm:col-span-2">
                        The OpenRouter catalog could not be loaded.
                      </output>
                    )}
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Fireworks API key
                      <input
                        type="password"
                        aria-label="Fireworks API key"
                        autoComplete="off"
                        value={settings.fireworksKey}
                        onChange={(event) => updateSettings({ fireworksKey: event.target.value })}
                        className="rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-fg-muted">
                      Fine-tuned model
                      <input
                        aria-label="Fireworks model"
                        value={settings.fireworksModel}
                        placeholder="accounts/your-account/models/your-model"
                        onChange={(event) => updateSettings({ fireworksModel: event.target.value })}
                        className="rounded-md border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
                      />
                    </label>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
