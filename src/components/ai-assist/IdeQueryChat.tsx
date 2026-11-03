"use client";

import { useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { AssistModelFields } from "@/components/ai-assist/AssistModelFields";
import { renderProse } from "@/components/rich-text";
import { appFetch } from "@/lib/config/base-path";
import { acceptAssistPlan, type AssistHistoryTurn } from "@/lib/ai/assist-plan";
import {
  DEFAULT_ASSIST_SETTINGS,
  normalizeModels,
  readAssistSettings,
  subscribeAssistSettings,
  writeAssistSettings,
  type AssistModelOption,
  type AssistSettings,
} from "@/lib/ai/assist-settings";
import { useSyncExternalStore } from "react";

interface ChatTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sql: string | null;
}

function errorText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") {
    const text = body.error.trim();
    if (text !== "") return text;
  }
  return fallback;
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

/**
 * The statement the corner chat reads, and where a built statement is written.
 * A Source tab has no editor query, so the chat does not replace one.
 */
export function editorChatQuery(
  tab: { readonly id: string; readonly query: string; readonly source?: unknown },
  updateTab: (id: string, patch: { readonly query: string }) => void,
): { readonly sql: string; readonly onUseQuery?: (sql: string) => void } {
  if (tab.source !== undefined) return { sql: "" };
  return { sql: tab.query, onUseQuery: (next) => updateTab(tab.id, { query: next }) };
}

/**
 * A corner chat on the IDE. It asks for a statement and can put that statement
 * in the editor. The model is the last one chosen in any chat.
 */
export function IdeQueryChat({
  sql,
  databaseType,
  schemaContext,
  onUseQuery,
}: {
  sql: string;
  databaseType: string;
  schemaContext: string;
  onUseQuery?: (sql: string) => void;
}) {
  const settings = useSyncExternalStore(subscribeAssistSettings, readAssistSettings, () => DEFAULT_ASSIST_SETTINGS);
  const updateSettings = (patch: Partial<AssistSettings>) => {
    writeAssistSettings({ ...settings, ...patch });
  };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
  const [models, setModels] = useState<readonly AssistModelOption[]>([]);
  const [gatewayModels, setGatewayModels] = useState<readonly AssistModelOption[]>([]);
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [gatewayStatus, setGatewayStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadCatalog = () => {
    void appFetch("/api/ai/assist")
      .then(async (response) => {
        if (!response.ok) {
          setModelStatus("failed");
          setGatewayStatus("failed");
          return;
        }
        const body: unknown = await response.json();
        const record = body !== null && typeof body === "object" ? body : null;
        const listed = record !== null && "models" in record ? normalizeModels(record.models) : [];
        const listedGateway = record !== null && "gatewayModels" in record ? normalizeModels(record.gatewayModels) : [];
        const gatewayFailed = record !== null && "gatewayCatalog" in record && record.gatewayCatalog === false;
        setModels(listed);
        setGatewayModels(listedGateway);
        setModelStatus("ready");
        setGatewayStatus(gatewayFailed ? "failed" : "ready");
      })
      .catch(() => {
        setModelStatus("failed");
        setGatewayStatus("failed");
      });
  };

  const send = async () => {
    const question = draft.trim();
    if (question === "" || sending) return;
    const model = modelFor(settings);
    if (model === "") {
      setNotice("Name the model to use.");
      return;
    }
    setSending(true);
    setNotice(null);
    setDraft("");
    const history: AssistHistoryTurn[] = [];
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const next = turns[index + 1];
      if (turn?.role === "user" && next?.role === "assistant") {
        history.push({ question: turn.text, explanation: next.text });
      }
    }
    const asked: ChatTurn = { id: `user-${turns.length}`, role: "user", text: question, sql: null };
    setTurns((current) => [...current, asked]);
    try {
      const response = await appFetch("/api/ai/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: settings.source,
          model,
          apiKey: keyFor(settings),
          question,
          schemaContext: schemaContext.replace(/[\r\n]+/g, " ").slice(0, 30_000),
          databaseType,
          history: history.slice(-6),
          editorSql: sql,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setTurns((current) => [
          ...current,
          {
            id: `assistant-${current.length}`,
            role: "assistant",
            text: errorText(body, "The assistant could not answer."),
            sql: null,
          },
        ]);
        return;
      }
      const plan = acceptAssistPlan(body);
      const statement = plan.queries[0]?.sql ?? null;
      setTurns((current) => [
        ...current,
        {
          id: `assistant-${current.length}`,
          role: "assistant",
          text: plan.explanation,
          sql: statement,
        },
      ]);
    } catch {
      setTurns((current) => [
        ...current,
        {
          id: `assistant-${current.length}`,
          role: "assistant",
          text: "The assistant could not be reached.",
          sql: null,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  let panel: ReactNode = null;
  if (open) {
    panel = (
      <section className="absolute right-4 bottom-32 z-30 flex max-h-[70%] w-80 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg md:bottom-16">
        <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
          <p className="text-xs font-medium text-fg">Ask AI</p>
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-fg-muted hover:text-fg">
            Close
          </button>
        </div>
        <div aria-label="IDE conversation" className="flex min-h-24 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {turns.map((turn) =>
            turn.role === "user" ? (
              <p key={turn.id} className="text-sm text-fg">
                {turn.text}
              </p>
            ) : (
              <div key={turn.id} className="text-sm text-fg-secondary">
                {turn.text !== "" && <div className="space-y-1">{renderProse(turn.text)}</div>}
                {turn.sql !== null && onUseQuery !== undefined && (
                  <button
                    type="button"
                    onClick={() => onUseQuery(turn.sql ?? "")}
                    className="mt-2 rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
                  >
                    Use this query
                  </button>
                )}
              </div>
            ),
          )}
        </div>
        <form
          className="border-t border-hairline px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {notice !== null && (
            <p role="alert" className="mb-2 text-xs text-danger">
              {notice}
            </p>
          )}
          <div className="flex items-center gap-2">
            <textarea
              aria-label="Build or revise a query"
              value={draft}
              placeholder="Build a query or revise this one"
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="min-h-9 flex-1 resize-none rounded-lg border border-hairline bg-canvas px-2 py-1 text-sm text-fg outline-none"
            />
            <button
              type="submit"
              disabled={draft.trim() === "" || sending}
              className="rounded-lg bg-brand-solid px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          <button
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => {
              setSettingsOpen((current) => !current);
              if (!settingsOpen) loadCatalog();
            }}
            className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted hover:text-fg"
          >
            Model
          </button>
          {settingsOpen && (
            <div className="mt-2">
              <AssistModelFields
                settings={settings}
                models={models}
                gatewayModels={gatewayModels}
                modelStatus={modelStatus}
                gatewayStatus={gatewayStatus}
                onChange={updateSettings}
              />
            </div>
          )}
        </form>
      </section>
    );
  }

  return (
    <>
      {panel}
      <button
        type="button"
        aria-label="Ask AI"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="absolute right-4 bottom-20 z-30 flex size-10 items-center justify-center rounded-full bg-brand-solid text-white shadow-lg md:bottom-4"
      >
        <Sparkles className="size-4" />
      </button>
    </>
  );
}
