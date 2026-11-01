"use client";

import { useState } from "react";
import { MIN_CHART_REFRESH_SECONDS, readRefreshText } from "@/lib/charts/chart-refresh";
import { buildSavedChart, type SaveChartDraft } from "@/lib/charts/save-chart";
import { storage } from "@/lib/storage";

export interface SaveChartButtonProps {
  /** The chart on screen. The name and the refresh field are edited here. */
  readonly draft: Omit<SaveChartDraft, "refreshText">;
}

/**
 * Saves the chart on screen, including its query and an optional refresh.
 * The refresh reruns that query. The shortest schedule is 60 seconds.
 */
export function SaveChartButton({ draft }: SaveChartButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(draft.name);
  const [refreshText, setRefreshText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const canSchedule = draft.query !== undefined && draft.query.trim() !== "";

  const openDialog = () => {
    setName(draft.name);
    setRefreshText("");
    setError(null);
    setNote(null);
    setOpen(true);
  };

  const save = () => {
    const refresh = readRefreshText(canSchedule ? refreshText : "");
    if (!refresh.ok) {
      setError(refresh.error);
      setNote(null);
      return;
    }
    const chart = buildSavedChart({ ...draft, name, refreshText: canSchedule ? refreshText : "" });
    if (chart === null) {
      setError("Name the chart before saving.");
      setNote(null);
      return;
    }
    storage.saveChart(chart);
    if (refresh.raised) {
      setRefreshText(String(refresh.seconds));
      setNote(`Raised to ${MIN_CHART_REFRESH_SECONDS} seconds, the shortest refresh.`);
      setError(null);
      return;
    }
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" onClick={openDialog} className="text-xs font-medium text-fg-secondary underline">
        Save chart
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        aria-label="Chart name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-7 w-36 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg"
      />
      <label className="flex items-center gap-1 text-xs text-fg-muted">
        Refresh seconds
        <input
          aria-label="Refresh seconds"
          inputMode="numeric"
          value={refreshText}
          disabled={!canSchedule}
          placeholder={canSchedule ? String(MIN_CHART_REFRESH_SECONDS) : "Needs a query"}
          onChange={(event) => setRefreshText(event.target.value)}
          className="h-7 w-24 rounded border border-hairline-strong bg-canvas px-2 text-xs text-fg disabled:opacity-50"
        />
      </label>
      <button type="button" onClick={save} className="text-xs font-medium text-brand underline">
        Save
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs font-medium text-fg-muted underline">
        Cancel
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {note !== null && <p className="text-xs text-fg-muted">{note}</p>}
    </div>
  );
}
