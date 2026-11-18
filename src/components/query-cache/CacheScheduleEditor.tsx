"use client";

import { Calendar } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AssistScheduleCalendar } from "@/components/ai-assist/AssistScheduleCalendar";
import { ASSIST_START_TIMES, assistMinuteLabel } from "@/lib/ai/assist-schedule";
import type { CacheScheduleEvery } from "@/lib/query-cache/schedule";

export interface CacheScheduleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  every: CacheScheduleEvery;
  minuteOfDay: number;
  startsOn: string;
  year: number;
  month: number;
  busy: boolean;
  onEvery: (every: CacheScheduleEvery) => void;
  onMinute: (minute: number) => void;
  onStartsOn: (day: string) => void;
  onMonth: (year: number, month: number) => void;
  onSave: () => void;
}

interface MenuAnchor {
  readonly left: number;
  readonly bottom: number;
  readonly maxHeight: number;
}

const SCHEDULE_WIDTH = 336;
const MENU_GAP = 8;

function menuAnchor(button: HTMLButtonElement): MenuAnchor {
  const rect = button.getBoundingClientRect();
  const left = Math.min(
    Math.max(MENU_GAP, rect.left),
    Math.max(MENU_GAP, window.innerWidth - SCHEDULE_WIDTH - MENU_GAP),
  );
  return {
    left,
    bottom: window.innerHeight - rect.top + MENU_GAP,
    maxHeight: Math.max(120, rect.top - MENU_GAP * 2),
  };
}

/**
 * The same calendar the AI chat uses to pick a day and a start time.
 * Daily shows the month and the clock. Hourly and off hide both.
 */
export function CacheScheduleEditor({
  open,
  onOpenChange,
  every,
  minuteOfDay,
  startsOn,
  year,
  month,
  busy,
  onEvery,
  onMinute,
  onStartsOn,
  onMonth,
  onSave,
}: CacheScheduleEditorProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const saveOnEnter = (event: { key: string; preventDefault: () => void }) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onSave();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const button = buttonRef.current;
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
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        disabled={busy}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-hairline px-2 text-fg hover:bg-fill disabled:opacity-60"
      >
        <Calendar className="size-3.5" aria-hidden="true" />
        Schedule
      </button>
      {open &&
        anchor !== null &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close schedule"
              onClick={() => onOpenChange(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <section
              aria-label="Schedule"
              style={{
                left: anchor.left,
                bottom: anchor.bottom,
                maxHeight: anchor.maxHeight,
                width: SCHEDULE_WIDTH,
              }}
              className="fixed z-50 flex flex-col gap-2 overflow-y-auto rounded-lg border border-hairline bg-raised p-3 shadow-md"
            >
              {every === "daily" && (
                <AssistScheduleCalendar
                  year={year}
                  month={month}
                  selected={startsOn}
                  onSelect={onStartsOn}
                  onMonth={onMonth}
                />
              )}
              {every === "daily" && (
                <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                  Start time
                  <select
                    aria-label="Start time"
                    value={String(minuteOfDay)}
                    onChange={(event) => onMinute(Number(event.target.value))}
                    onKeyDown={saveOnEnter}
                    className="h-7 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
                  >
                    {ASSIST_START_TIMES.map((minute) => (
                      <option key={minute} value={String(minute)}>
                        {assistMinuteLabel(minute)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                Repeat
                <select
                  aria-label="Schedule interval"
                  value={every}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === "hourly" || next === "daily" || next === "off") onEvery(next);
                  }}
                  onKeyDown={saveOnEnter}
                  className="h-7 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
                >
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
                  <option value="off">Only when asked</option>
                </select>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onSave}
                  className="rounded-full border border-hairline px-3 py-1 text-xs font-medium text-fg hover:bg-fill-subtle disabled:opacity-60"
                >
                  Save schedule
                </button>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-fill-subtle"
                >
                  Cancel
                </button>
              </div>
            </section>
          </>,
          document.body,
        )}
    </>
  );
}
