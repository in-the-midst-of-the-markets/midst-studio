"use client";

import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import { ASSIST_HISTORY_MAX } from "@/lib/ai/assist-plan";

/**
 * How many earlier questions the next message includes.
 * The icon opens the count. The chat remembers the choice with the model.
 */
export function HistoryLimitButton({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Earlier messages, ${value}`}
        onClick={() => setOpen((current) => !current)}
        className="rounded p-1 text-fg-muted hover:bg-fill-subtle hover:text-fg"
      >
        <MessagesSquare className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <label className="absolute right-0 top-full z-30 mt-2 flex w-44 flex-col gap-1 rounded-lg border border-hairline bg-control p-2 text-xs text-fg-muted shadow-sm">
          Earlier messages
          <select
            aria-label="Number of earlier messages"
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
            className="rounded-lg border border-hairline bg-canvas px-2 py-1 text-sm text-fg"
          >
            {Array.from({ length: ASSIST_HISTORY_MAX + 1 }, (_, count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
