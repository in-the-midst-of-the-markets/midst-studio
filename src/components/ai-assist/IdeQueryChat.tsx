"use client";

import { useState, type ReactNode } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import { AssistModelFields } from "@/components/ai-assist/AssistModelFields";
import { renderProse } from "@/components/rich-text";
import { appFetch } from "@/lib/config/base-path";
import { readAssistRankings, type AssistRankings } from "@/lib/ai/assist-model-rank";
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

interface IdeQueryChatProps {
  sql: string;
  databaseType: string;
  schemaContext: string;
  onUseQuery?: (sql: string) => void;
  /** The open connection. A different one starts a new conversation. */
  connectionId?: string;
}

/**
 * A corner chat on the IDE. It asks for a statement and can put that statement
 * in the editor. The model is the last one chosen in any chat. Switching the
 * connection remounts the conversation, so the previous engine's turns are not sent.
 */
export function IdeQueryChat({ connectionId = "", ...props }: IdeQueryChatProps) {
  const [open, setOpen] = useState(false);
  return <IdeQueryChatSession key={connectionId} open={open} onOpenChange={setOpen} {...props} />;
}

/**
 * One conversation for one connection. The parent remounts this session when
 * the connection changes, so a reply still in flight cannot land on the next
 * database, and the previous engine's turns are not sent.
 */
function IdeQueryChatSession({
  sql,
  databaseType,
  schemaContext,
  onUseQuery,
  open,
  onOpenChange,
}: {
  sql: string;
  databaseType: string;
  schemaContext: string;
  onUseQuery?: (sql: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useSyncExternalStore(subscribeAssistSettings, readAssistSettings, () => DEFAULT_ASSIST_SETTINGS);
  const updateSettings = (patch: Partial<AssistSettings>) => {
    writeAssistSettings({ ...settings, ...patch });
  };
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [models, setModels] = useState<readonly AssistModelOption[]>([]);
  const [gatewayModels, setGatewayModels] = useState<readonly AssistModelOption[]>([]);
  const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [gatewayStatus, setGatewayStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [rankings, setRankings] = useState<AssistRankings | null>(null);
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
        setRankings(readAssistRankings(record !== null && "rankings" in record ? record.rankings : null));
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
      const plan = acceptAssistPlan(body, databaseType);
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
          <div className="flex items-center gap-2">
            {turns.length > 0 && (
              <>
                {confirmClear && (
                  <button
                    type="button"
                    aria-label="Confirm clear chat"
                    onClick={() => {
                      setTurns([]);
                      setConfirmClear(false);
                      setNotice(null);
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
            <button type="button" onClick={() => onOpenChange(false)} className="text-xs text-fg-muted hover:text-fg">
              Close
            </button>
          </div>
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
                rankings={rankings}
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
        onClick={() => onOpenChange(!open)}
        className="absolute right-4 bottom-20 z-30 flex size-10 items-center justify-center rounded-full bg-brand-solid text-white shadow-lg md:bottom-4"
      >
        <Sparkles className="size-4" />
      </button>
    </>
  );
}
