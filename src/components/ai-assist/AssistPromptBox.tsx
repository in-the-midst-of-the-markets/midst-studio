"use client";

import { ArrowUp, Plus, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";

/** One saved query the plus menu can attach. */
export interface AssistSavedChoice {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

/**
 * The prompt shared by every chat. Enter sends. Shift+Enter starts a new line.
 * The accessible name stays the caller's, so each surface keeps its own label.
 *
 * `savedChoices` turns on the plus button at the bottom of the box. Saved query
 * is the first choice; later choices can sit beside it.
 */
export function AssistPromptBox({
  label,
  value,
  sending,
  disabled,
  onChange,
  onSubmit,
  inputRef,
  savedChoices,
  selectedSavedIds,
  onToggleSaved,
}: {
  label: string;
  value: string;
  sending: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  savedChoices?: readonly AssistSavedChoice[];
  selectedSavedIds?: readonly string[];
  onToggleSaved?: (id: string) => void;
}) {
  const [menu, setMenu] = useState<"closed" | "add" | "saved">("closed");
  const addRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const choices = savedChoices ?? [];
  const canAdd = savedChoices !== undefined && onToggleSaved !== undefined;
  const selected = new Set(selectedSavedIds ?? []);
  const attached = choices.filter((choice) => selected.has(choice.id));

  useLayoutEffect(() => {
    if (menu === "closed") return;
    const place = (): void => {
      const button = addRef.current;
      if (button === null) return;
      setAnchor(menuAnchor(button));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menu]);

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl border border-hairline bg-control p-3">
        <textarea
          ref={inputRef}
          aria-label={label}
          value={value}
          placeholder="Tell me what query to build or optimize"
          rows={2}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className="min-h-16 w-full resize-none bg-transparent text-sm text-fg outline-none"
        />
        {attached.length > 0 && (
          <ul aria-label="Added queries" className="mt-2 flex flex-wrap gap-1.5">
            {attached.map((choice) => (
              <li key={choice.id}>
                <button
                  type="button"
                  aria-label={`Remove ${choice.name}`}
                  onClick={() => onToggleSaved?.(choice.id)}
                  className="inline-flex items-center gap-1 rounded-full bg-brand-tint/15 px-2 py-1 text-xs text-fg"
                >
                  {choice.name}
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {canAdd && (
              <>
                <button
                  ref={addRef}
                  type="button"
                  aria-label="Add to chat"
                  aria-expanded={menu !== "closed"}
                  onClick={() => setMenu((current) => (current === "closed" ? "add" : "closed"))}
                  className="inline-flex size-8 items-center justify-center rounded-full border border-hairline text-fg hover:bg-fill-subtle"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
                {menu !== "closed" &&
                  anchor !== null &&
                  createPortal(
                    <>
                      <button
                        type="button"
                        aria-label="Close add menu"
                        onClick={() => setMenu("closed")}
                        className="fixed inset-0 z-40 cursor-default"
                      />
                      <div
                        role="menu"
                        aria-label={menu === "saved" ? "Saved queries" : "Add to chat"}
                        style={{ left: anchor.left, bottom: anchor.bottom, maxHeight: anchor.maxHeight }}
                        className="fixed z-50 flex w-64 flex-col overflow-hidden rounded-lg border border-hairline bg-raised p-1 shadow-md"
                      >
                        {menu === "add" ? (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => setMenu("saved")}
                            className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-fill-subtle"
                          >
                            Saved query
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setMenu("add")}
                              className="shrink-0 rounded-md px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-fill-subtle"
                            >
                              Back
                            </button>
                            {choices.length === 0 ? (
                              <p className="px-2 py-1.5 text-sm text-fg-muted">No saved queries yet.</p>
                            ) : (
                              <ul className="min-h-0 overflow-y-auto">
                                {choices.map((choice) => {
                                  const added = selected.has(choice.id);
                                  return (
                                    <li key={choice.id}>
                                      <button
                                        type="button"
                                        role="menuitemcheckbox"
                                        aria-checked={added}
                                        onClick={() => onToggleSaved?.(choice.id)}
                                        className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-fill-subtle"
                                      >
                                        <span className="text-sm text-fg">
                                          {added ? "Added · " : ""}
                                          {choice.name}
                                        </span>
                                        {choice.detail !== "" && (
                                          <span className="text-xs text-fg-muted">{choice.detail}</span>
                                        )}
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        )}
                      </div>
                    </>,
                    document.body,
                  )}
              </>
            )}
            <p className="text-xs text-fg-muted">Shift + Enter for a new line</p>
          </div>
          <button
            type="submit"
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-solid px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
            <ArrowUp className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="text-center text-xs text-fg-muted">AI can make mistakes. Review generated queries.</p>
    </div>
  );
}

/** Where the add menu sits: above the plus button, inside the viewport. */
interface MenuAnchor {
  readonly left: number;
  readonly bottom: number;
  readonly maxHeight: number;
}

const MENU_WIDTH = 256;
const MENU_GAP = 8;

/**
 * The chat column clips overflow, so an absolute menu opening into the
 * conversation gets cut off by the reply text. Anchor it to the viewport instead.
 */
function menuAnchor(button: HTMLButtonElement): MenuAnchor {
  const rect = button.getBoundingClientRect();
  const left = Math.min(Math.max(MENU_GAP, rect.left), Math.max(MENU_GAP, window.innerWidth - MENU_WIDTH - MENU_GAP));
  return {
    left,
    bottom: window.innerHeight - rect.top + MENU_GAP,
    maxHeight: Math.max(120, rect.top - MENU_GAP * 2),
  };
}
