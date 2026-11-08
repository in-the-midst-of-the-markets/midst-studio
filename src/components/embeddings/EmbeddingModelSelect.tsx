"use client";

import { ChevronDown } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
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

interface MenuBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState(connectionId);
  const [choosingCustom, setChoosingCustom] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<MenuBox | null>(null);
  if (connection !== connectionId) {
    setConnection(connectionId);
    setChoosingCustom(false);
    setDraft(null);
    setOpen(false);
  }

  const showCustom = choosingCustom || !listed;
  const shown = draft ?? (listed ? "" : model);
  const face = embeddingModelFace(model, choosingCustom, draft);

  const closeMenu = (): void => {
    setOpen(false);
    setDraft(null);
    if (listed) setChoosingCustom(false);
  };

  const openMenu = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setBox({ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 192) });
    }
    setOpen(true);
  };

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Embedding model"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        className="h-7 gap-1 px-2 text-xs font-medium text-fg-muted hover:text-fg-bright"
      >
        Model: {face}
        <ChevronDown strokeWidth={1.5} className="size-3" />
      </Button>
      {open &&
        box !== null &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close embedding model"
              onClick={closeMenu}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              role="menu"
              aria-label="Embedding models"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                closeMenu();
              }}
              style={{ left: box.left, top: box.top, width: box.width }}
              className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-hairline bg-raised p-1 shadow-md"
            >
              {EMBEDDING_MODEL_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  aria-current={option.id === model && !choosingCustom ? "true" : undefined}
                  onClick={() => {
                    setChoosingCustom(false);
                    setDraft(null);
                    writeEmbeddingModel(connectionId, option.id);
                    setOpen(false);
                  }}
                  className="rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-fill-subtle"
                >
                  {option.name}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                aria-current={showCustom ? "true" : undefined}
                onClick={() => setChoosingCustom(true)}
                className="rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-fill-subtle"
              >
                Custom model
              </button>
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
                  className="mx-1 mb-1 h-7 rounded border border-hairline bg-canvas px-1.5 font-mono text-xs text-fg"
                />
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
