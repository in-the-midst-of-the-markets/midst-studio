"use client";

import { ArrowUp, Plus, X } from "lucide-react";
import { useState, type Ref } from "react";

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
  const choices = savedChoices ?? [];
  const canAdd = savedChoices !== undefined && onToggleSaved !== undefined;
  const selected = new Set(selectedSavedIds ?? []);
  const attached = choices.filter((choice) => selected.has(choice.id));

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
              <div className="relative">
                <button
                  type="button"
                  aria-label="Add to chat"
                  aria-expanded={menu !== "closed"}
                  onClick={() => setMenu((current) => (current === "closed" ? "add" : "closed"))}
                  className="relative z-20 inline-flex size-8 items-center justify-center rounded-full border border-hairline text-fg hover:bg-fill-subtle"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
                {menu !== "closed" && (
                  <>
                    <button
                      type="button"
                      aria-label="Close add menu"
                      onClick={() => setMenu("closed")}
                      className="fixed inset-0 z-10 cursor-default"
                    />
                    <div
                      role="menu"
                      aria-label={menu === "saved" ? "Saved queries" : "Add to chat"}
                      className="absolute bottom-10 left-0 z-20 w-64 rounded-lg border border-hairline bg-raised p-1 shadow-md"
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
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => setMenu("add")}
                            className="rounded-md px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-fill-subtle"
                          >
                            Back
                          </button>
                          {choices.length === 0 ? (
                            <p className="px-2 py-1.5 text-sm text-fg-muted">No saved queries yet.</p>
                          ) : (
                            <ul className="max-h-48 overflow-y-auto">
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
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
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
