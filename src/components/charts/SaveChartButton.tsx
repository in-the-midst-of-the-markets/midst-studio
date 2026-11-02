"use client";

import { useState } from "react";
import { Bookmark } from "lucide-react";
import { MIN_CHART_REFRESH_SECONDS, readRefreshText } from "@/lib/charts/chart-refresh";
import { buildSavedChart, findSavedChart, type SaveChartDraft } from "@/lib/charts/save-chart";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";

export interface SaveChartButtonProps {
  /** The chart on screen. The name and the refresh field are edited here. */
  readonly draft: Omit<SaveChartDraft, "refreshText">;
}

function SaveNotice({ notice }: { readonly notice: string | null }) {
  if (notice === null) return null;
  return <output className="text-xs text-fg-muted">{notice}</output>;
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
  const [notice, setNotice] = useState<string | null>(null);
  const canSchedule = draft.query !== undefined && draft.query.trim() !== "";
  const stored = findSavedChart(storage.getSavedCharts(), draft);

  const openDialog = () => {
    setName(draft.name);
    setRefreshText("");
    setError(null);
    setNote(null);
    setOpen(true);
  };

  const unsave = (id: string) => {
    storage.deleteChart(id);
    setNotice("Unsaved.");
    setError(null);
    setNote(null);
    setOpen(false);
  };

  const save = () => {
    const refresh = readRefreshText(canSchedule ? refreshText : "");
    if (!refresh.ok) {
      setError(refresh.error);
      setNote(null);
      return;
    }
    const next = { ...draft, name, refreshText: canSchedule ? refreshText : "" };
    const chart = buildSavedChart(next);
    if (chart === null) {
      setError("Name the chart before saving.");
      setNote(null);
      return;
    }
    if (findSavedChart(storage.getSavedCharts(), next) !== null) {
      setError("This chart is already saved.");
      setNote(null);
      return;
    }
    storage.saveChart(chart);
    setNotice("Saved.");
    setError(null);
    if (refresh.raised) {
      setRefreshText(String(refresh.seconds));
      setNote(`Raised to ${MIN_CHART_REFRESH_SECONDS} seconds, the shortest refresh.`);
      return;
    }
    setOpen(false);
  };

  if (!open) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={stored === null ? "Save Chart" : "Unsave"}
          title={stored === null ? "Save Chart" : "Unsave"}
          aria-pressed={stored !== null}
          onClick={() => {
            if (stored === null) openDialog();
            else unsave(stored.id);
          }}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-lg",
            stored === null ? "text-fg-muted hover:text-fg" : "bg-brand-solid text-white",
          )}
        >
          <Bookmark className={cn("size-3.5", stored !== null && "fill-current")} aria-hidden="true" />
        </button>
        <SaveNotice notice={notice} />
      </span>
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
      <SaveNotice notice={notice} />
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {note !== null && <p className="text-xs text-fg-muted">{note}</p>}
    </div>
  );
}
