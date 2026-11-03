"use client";

import { useEffect, useState, type ReactNode } from "react";
import { appFetch } from "@/lib/config/base-path";
import {
  DEFAULT_ASSIST_SETTINGS,
  readAssistSettings,
  subscribeAssistSettings,
  writeAssistSettings,
  type AssistSettings,
} from "@/lib/ai/assist-settings";
import { useSyncExternalStore } from "react";

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
      <input type="radio" name="connector-source" value={value} checked={checked} onChange={onSelect} />
      {label}
    </label>
  );
}

function connectorNote(source: AssistSettings["source"], serverKey: boolean | null): string {
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

/** The API keys for every chat, opened from the profile menu. */
export function AssistConnectors({ onClose }: { onClose: () => void }) {
  const settings = useSyncExternalStore(subscribeAssistSettings, readAssistSettings, () => DEFAULT_ASSIST_SETTINGS);
  const update = (patch: Partial<AssistSettings>) => {
    writeAssistSettings({ ...settings, ...patch });
  };
  const [serverKey, setServerKey] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void appFetch("/api/ai/assist")
      .then(async (response) => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        const has = body !== null && typeof body === "object" && "serverKey" in body && body.serverKey === true;
        if (!cancelled) setServerKey(has);
      })
      .catch(() => {
        if (!cancelled) setServerKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Connectors"
        className="mt-16 flex w-full max-w-md flex-col gap-3 rounded-xl border border-hairline bg-raised p-4 text-fg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Connectors</h2>
          <button type="button" onClick={onClose} className="text-xs font-medium text-fg-muted hover:text-fg">
            Close
          </button>
        </div>
        <fieldset className="m-0 flex flex-wrap gap-x-1 gap-y-1 border-0 p-0">
          <legend className="sr-only">Model provider</legend>
          <SourceChoice
            value="openrouter"
            label="OpenRouter"
            checked={settings.source === "openrouter"}
            onSelect={() => update({ source: "openrouter" })}
          />
          <SourceChoice
            value="fireworks"
            label="Fireworks AI"
            checked={settings.source === "fireworks"}
            onSelect={() => update({ source: "fireworks" })}
          />
          <SourceChoice
            value="gateway"
            label="Vercel AI Gateway"
            checked={settings.source === "gateway"}
            onSelect={() => update({ source: "gateway" })}
          />
        </fieldset>
        <p className="text-sm text-fg-muted">{connectorNote(settings.source, serverKey)}</p>
        {settings.source === "openrouter" && (
          <SavedKeyField
            label="OpenRouter API key"
            stored={settings.openRouterKey}
            placeholder="sk-or-..."
            onSave={(openRouterKey) => update({ openRouterKey })}
          />
        )}
        {settings.source === "fireworks" && (
          <SavedKeyField
            label="Fireworks API key"
            stored={settings.fireworksKey}
            onSave={(fireworksKey) => update({ fireworksKey })}
          />
        )}
        {settings.source === "gateway" && (
          <SavedKeyField
            label="Vercel AI Gateway API key"
            stored={settings.gatewayKey}
            onSave={(gatewayKey) => update({ gatewayKey })}
          />
        )}
      </div>
    </div>
  );
}
