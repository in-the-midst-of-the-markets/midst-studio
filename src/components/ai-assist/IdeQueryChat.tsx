"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Sparkles, Trash2 } from "lucide-react";
import { AssistModelFields } from "@/components/ai-assist/AssistModelFields";
import { AssistPromptBox } from "@/components/ai-assist/AssistPromptBox";
import { HistoryLimitButton } from "@/components/ai-assist/HistoryLimitButton";
import { renderProse } from "@/components/rich-text";
import { BOARD_CONTEXT_CAP } from "@/lib/ai/dashboard-prompt";
import { appFetch } from "@/lib/config/base-path";
import { readAssistRankings, type AssistRankings } from "@/lib/ai/assist-model-rank";
import { acceptAssistPlan, recentAssistHistory, type AssistHistoryTurn } from "@/lib/ai/assist-plan";
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
  /** Puts the reply's explanation on the page, when the surface has a text box. */
  onUseNote?: (text: string) => void;
  /**
   * Places the reply on the page as soon as it arrives. The IDE leaves this
   * unset and shows a button instead, because that button replaces the editor.
   */
  onPlaceReply?: (reply: { readonly sql: string | null; readonly text: string }) => void;
  /** The open connection. A different one starts a new conversation. */
  connectionId?: string;
  /** `fixed` keeps the button on the screen while the page scrolls. */
  placement?: "absolute" | "fixed";
  conversationLabel?: string;
  useQueryLabel?: string;
  noteLabel?: string;
  /**
   * The dashboard's cell inventory. When set, the question is about that board
   * and the editor statement is not sent.
   */
  boardContext?: string;
  promptLabel?: string;
  promptPlaceholder?: string;
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
  onUseNote,
  onPlaceReply,
  open,
  onOpenChange,
  placement = "absolute",
  conversationLabel = "IDE conversation",
  useQueryLabel = "Use this query",
  noteLabel = "Add as text",
  boardContext,
  promptLabel = "Build or revise a query",
  promptPlaceholder = "Tell me what query to build or optimize",
}: {
  sql: string;
  databaseType: string;
  schemaContext: string;
  onUseQuery?: (sql: string) => void;
  onUseNote?: (text: string) => void;
  onPlaceReply?: (reply: { readonly sql: string | null; readonly text: string }) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: "absolute" | "fixed";
  conversationLabel?: string;
  useQueryLabel?: string;
  noteLabel?: string;
  boardContext?: string;
  promptLabel?: string;
  promptPlaceholder?: string;
}) {
  const anchored = placement === "fixed" ? "fixed" : "absolute";
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
          history: recentAssistHistory(history, settings.historyMessages),
          ...(boardContext === undefined
            ? { editorSql: sql }
            : { boardContext: boardContext.slice(0, BOARD_CONTEXT_CAP) }),
          webSearch: assistModelSearches(settings.source, model, models, gatewayModels),
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
      onPlaceReply?.({ sql: statement, text: plan.explanation });
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
      <section
        className={`${anchored} right-4 bottom-32 z-30 flex max-h-[70%] w-80 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg md:bottom-16`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-2">
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
        <div aria-label={conversationLabel} className="flex min-h-24 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {turns.map((turn) =>
            turn.role === "user" ? (
              <p key={turn.id} className="text-sm text-fg">
                {turn.text}
              </p>
            ) : (
              <div key={turn.id} className="text-sm text-fg-secondary">
                {turn.text !== "" && <div className="space-y-1">{renderProse(turn.text)}</div>}
                {onPlaceReply === undefined && turn.sql !== null && onUseQuery !== undefined && (
                  <button
                    type="button"
                    onClick={() => onUseQuery(turn.sql ?? "")}
                    className="mt-2 rounded-md bg-brand-solid px-2 py-1 text-xs font-medium text-white"
                  >
                    {useQueryLabel}
                  </button>
                )}
                {onPlaceReply === undefined && turn.text !== "" && onUseNote !== undefined && (
                  <button
                    type="button"
                    onClick={() => onUseNote(turn.text)}
                    className="mt-2 rounded-md border border-hairline px-2 py-1 text-xs font-medium text-fg"
                  >
                    {noteLabel}
                  </button>
                )}
              </div>
            ),
          )}
        </div>
        {/*
          The panel clips at 70% of the screen. Configuration lives in its
          own scroller so opening it cannot push the send button past that
          clip. The prompt stays pinned under the scroller.
        */}
        <form
          className="flex min-h-0 shrink flex-col border-t border-hairline"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div data-assist-config="" className="min-h-0 overflow-y-auto px-3 pt-2">
            <div className="flex flex-col gap-3">
              <AssistModelFields
                settings={settings}
                models={models}
                gatewayModels={gatewayModels}
                modelStatus={modelStatus}
                gatewayStatus={gatewayStatus}
                rankings={rankings}
                open={settingsOpen}
                onToggle={() => {
                  setSettingsOpen((current) => !current);
                  if (!settingsOpen) loadCatalog();
                }}
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
            </div>
          </div>
          <div className="shrink-0 px-3 pt-3 pb-2">
            <AssistPromptBox
              label={promptLabel}
              placeholder={promptPlaceholder}
              value={draft}
              sending={sending}
              disabled={draft.trim() === "" || sending}
              onChange={setDraft}
              onSubmit={() => void send()}
            />
          </div>
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
        className={`${anchored} right-4 bottom-20 z-30 flex size-10 items-center justify-center rounded-full bg-brand-solid text-white shadow-lg md:bottom-4`}
      >
        <Sparkles className="size-4" />
      </button>
    </>
  );
}
