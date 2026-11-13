"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  assistCalendarCells,
  assistDateKey,
  assistDayLabel,
  assistMonthLabel,
  shiftAssistMonth,
} from "@/lib/ai/assist-schedule";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The month grid on the schedule card.
 * Sunday starts the week, the selected day is filled, and today keeps a ring.
 */
export function AssistScheduleCalendar({
  year,
  month,
  selected,
  onSelect,
  onMonth,
}: {
  readonly year: number;
  readonly month: number;
  readonly selected: string;
  readonly onSelect: (day: string) => void;
  readonly onMonth: (year: number, month: number) => void;
}) {
  const [today] = useState(() => assistDateKey(new Date()));
  const cells = assistCalendarCells(year, month);
  const weeks: (typeof cells)[] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  const show = (by: number) => {
    const next = shiftAssistMonth(year, month, by);
    onMonth(next.year, next.month);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{assistMonthLabel(year, month)}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => show(-1)}
            className="inline-flex size-7 items-center justify-center rounded-full text-fg hover:bg-fill-subtle"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => show(1)}
            className="inline-flex size-7 items-center justify-center rounded-full text-fg hover:bg-fill-subtle"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <table aria-label={assistMonthLabel(year, month)} className="w-full border-separate border-spacing-0.5">
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday} scope="col" className="text-center text-[10px] font-normal text-fg-muted">
                {weekday.slice(0, 1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.key}>
              {week.map((cell) => {
                const pressed = cell.key === selected;
                return (
                  <td key={cell.key} className="p-0 text-center">
                    <button
                      type="button"
                      aria-label={assistDayLabel(cell.key)}
                      aria-pressed={pressed}
                      onClick={() => {
                        onSelect(cell.key);
                        if (!cell.inMonth) {
                          const yearOfDay = Number(cell.key.slice(0, 4));
                          const monthOfDay = Number(cell.key.slice(5, 7)) - 1;
                          onMonth(yearOfDay, monthOfDay);
                        }
                      }}
                      className={cn(
                        "mx-auto flex size-8 items-center justify-center rounded-full text-xs",
                        pressed
                          ? "bg-brand-solid font-medium text-white"
                          : cell.inMonth
                            ? "text-fg hover:bg-fill-subtle"
                            : "text-fg-muted hover:bg-fill-subtle",
                        !pressed && cell.key === today && "ring-1 ring-brand-solid",
                      )}
                    >
                      {cell.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-fg">{assistDayLabel(selected)}</p>
    </div>
  );
}
