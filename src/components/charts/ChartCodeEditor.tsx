"use client";

import { useMemo, useState } from "react";
import {
  applyChartValues,
  chartSourceKey,
  formatChartCode,
  parseChartCode,
  stripChartValues,
} from "@/lib/charts/chart-code";
import type { SlotSelection } from "@/lib/charts/echarts-catalog";
import { withFilterLooks, withoutFilterLooks, type FilterLook } from "@/lib/charts/filter-look";

const EMPTY_LOOKS: ReadonlyMap<string, FilterLook> = new Map();

export interface ChartCodeState {
  readonly text: string;
  readonly error: string | null;
  /** The chart to draw: the user's look with the query's values. Null while the generated chart is shown. */
  readonly option: Record<string, unknown> | null;
  /** The parsed chart code, before the query's values are filled in. */
  readonly editedOption: Record<string, unknown> | null;
  readonly edited: boolean;
  readonly onChange: (text: string) => void;
  readonly reset: () => void;
}

/**
 * Text for how the chart looks, replaced once the user types.
 * `source` is the shelves. A new shelf starts from the generated option again.
 * `refreshToken` is the query result. A new result drops values out of the text
 * and the canvas reads them from that result instead.
 */
export function useChartCode(
  generated: Record<string, unknown> | null,
  typeId: string | null,
  variationId: string | null,
  selection: SlotSelection | null,
  refreshToken: unknown = null,
  filterLooks: ReadonlyMap<string, FilterLook> = EMPTY_LOOKS,
): ChartCodeState {
  const source = chartSourceKey(typeId, variationId, selection);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editedOption, setEditedOption] = useState<Record<string, unknown> | null>(null);
  const [seenSource, setSeenSource] = useState(source);
  const [seenRefresh, setSeenRefresh] = useState(refreshToken);
  if (seenSource !== source) {
    setSeenSource(source);
    setSeenRefresh(refreshToken);
    setDraft(null);
    setError(null);
    setEditedOption(null);
  } else if (seenRefresh !== refreshToken) {
    setSeenRefresh(refreshToken);
    if (draft !== null && generated !== null) {
      const parsed = parseChartCode(draft);
      if (parsed.ok) {
        const cleaned = stripChartValues(parsed.option);
        const text = formatChartCode(cleaned);
        if (text !== draft) {
          setDraft(text);
          setEditedOption(cleaned);
          setError(null);
        }
      }
    }
  }

  const onChange = (text: string) => {
    setDraft(text);
    const parsed = parseChartCode(text);
    if (parsed.ok) {
      setError(null);
      setEditedOption(parsed.option);
      return;
    }
    setError(parsed.error);
  };

  const reset = () => {
    setDraft(null);
    setError(null);
    setEditedOption(null);
  };

  const option = useMemo(() => {
    if (editedOption === null || generated === null) return null;
    return withoutFilterLooks(applyChartValues(editedOption, generated));
  }, [editedOption, generated]);

  const text =
    draft ?? (generated === null ? "" : formatChartCode(withFilterLooks(stripChartValues(generated), filterLooks)));

  return {
    text,
    error,
    option,
    editedOption,
    edited: draft !== null,
    onChange,
    reset,
  };
}

export interface ChartCodeEditorProps {
  readonly value: string;
  readonly error: string | null;
  readonly edited: boolean;
  readonly onChange: (value: string) => void;
  readonly onReset: () => void;
}

/** The chart option as wrapping, editable JSON. */
export function ChartCodeEditor({ value, error, edited, onChange, onReset }: ChartCodeEditorProps) {
  return (
    <div className="flex h-full min-h-48 flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">
          Chart code sets the look. The query fills in the values. The title is title.text and its size is
          title.textStyle.fontSize. A filter is filters.name.control: text, select, number, or slider.
        </span>
        {edited && (
          <button type="button" onClick={onReset} className="text-xs font-medium text-fg-secondary underline">
            Use generated chart
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <textarea
        aria-label="Chart code"
        value={value}
        wrap="soft"
        spellCheck={false}
        placeholder="Chart code appears here after a query."
        onChange={(event) => onChange(event.target.value)}
        className="min-h-48 w-full flex-1 resize-y whitespace-pre-wrap break-words rounded border border-hairline-strong bg-canvas p-2 font-mono text-xs text-fg"
      />
    </div>
  );
}
