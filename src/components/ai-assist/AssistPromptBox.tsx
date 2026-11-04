"use client";

import { ArrowUp } from "lucide-react";
import type { Ref } from "react";

/**
 * The prompt shared by every chat. Enter sends. Shift+Enter starts a new line.
 * The accessible name stays the caller's, so each surface keeps its own label.
 */
export function AssistPromptBox({
  label,
  value,
  sending,
  disabled,
  onChange,
  onSubmit,
  inputRef,
}: {
  label: string;
  value: string;
  sending: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
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
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-fg-muted">Shift + Enter for a new line</p>
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
