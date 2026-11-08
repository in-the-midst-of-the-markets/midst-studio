"use client";

import { ChevronDown } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import {
  CUSTOM_EMBEDDING_CHOICE,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODEL_OPTIONS,
  isListedEmbeddingModel,
  normalizeEmbeddingModel,
} from "@/lib/embeddings/models";
import { embeddingModelFor, subscribeEmbeddingSettings, writeEmbeddingModel } from "@/lib/embeddings/settings";

/** The words on the closed control: a catalog name, a typed id, or Custom. */
function embeddingModelFace(model: string, choosingCustom: boolean, draft: string | null): string {
  const match = EMBEDDING_MODEL_OPTIONS.find((option) => option.id === model);
  if (match !== undefined && !choosingCustom) return match.name;
  const typed = (draft ?? "").trim();
  if (typed !== "") return typed;
  if (!isListedEmbeddingModel(model)) return model;
  return "Custom";
}

/**
 * The model this connection uses when a vector value is written as `{{text}}`.
 * Voyage 4 is the default. Custom is any other model id the database was embedded with.
 */
export function EmbeddingModelSelect({ connectionId }: { readonly connectionId?: string }) {
  const model = useSyncExternalStore(
    subscribeEmbeddingSettings,
    () => embeddingModelFor(connectionId),
    () => DEFAULT_EMBEDDING_MODEL,
  );
  const listed = isListedEmbeddingModel(model);
  const [connection, setConnection] = useState(connectionId);
  const [choosingCustom, setChoosingCustom] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  if (connection !== connectionId) {
    setConnection(connectionId);
    setChoosingCustom(false);
    setDraft(null);
  }

  const showCustom = choosingCustom || !listed;
  const shown = draft ?? (listed ? "" : model);
  const face = embeddingModelFace(model, choosingCustom, draft);

  return (
    <span className="inline-flex items-center gap-1">
      <span className="relative inline-flex h-7 items-center">
        <span
          aria-hidden="true"
          className="pointer-events-none inline-flex items-center gap-1 text-xs font-medium text-fg-muted"
        >
          Model: {face}
          <ChevronDown strokeWidth={1.5} className="h-3 w-3" />
        </span>
        <select
          aria-label="Embedding model"
          value={listed && !choosingCustom ? model : CUSTOM_EMBEDDING_CHOICE}
          onChange={(event) => {
            const next = event.target.value;
            if (next === CUSTOM_EMBEDDING_CHOICE) {
              setChoosingCustom(true);
              return;
            }
            setChoosingCustom(false);
            setDraft(null);
            writeEmbeddingModel(connectionId, next);
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {EMBEDDING_MODEL_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
          <option value={CUSTOM_EMBEDDING_CHOICE}>Custom model</option>
        </select>
      </span>
      {showCustom && (
        <input
          aria-label="Custom embedding model"
          value={shown}
          placeholder="model id"
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            const trimmed = next.trim();
            if (trimmed === "" || normalizeEmbeddingModel(trimmed) !== trimmed) return;
            writeEmbeddingModel(connectionId, trimmed);
          }}
          onBlur={() => {
            if (draft === null) {
              setChoosingCustom(false);
              return;
            }
            if (draft.trim() === "") {
              writeEmbeddingModel(connectionId, "");
              setDraft(null);
              setChoosingCustom(false);
              return;
            }
            if (normalizeEmbeddingModel(draft) === draft.trim()) setDraft(null);
          }}
          className="h-7 w-36 rounded border border-hairline bg-canvas px-1.5 font-mono text-xs text-fg"
        />
      )}
    </span>
  );
}
