"use client";

import { useState } from "react";
import { chartSourceKey, formatChartCode, parseChartCode } from "@/lib/charts/chart-code";
import type { SlotSelection } from "@/lib/charts/echarts-catalog";

export interface ChartCodeState {
  readonly text: string;
  readonly error: string | null;
  /** The user's option, or null while the generated chart is what should be drawn. */
  readonly option: Record<string, unknown> | null;
  readonly edited: boolean;
  readonly onChange: (text: string) => void;
  readonly reset: () => void;
}

/**
 * Text for the generated option, replaced once the user types.
 * `source` is the shelves. A new shelf starts from the generated option again.
 */
export function useChartCode(
  generated: Record<string, unknown> | null,
  typeId: string | null,
  variationId: string | null,
  selection: SlotSelection | null,
): ChartCodeState {
  const source = chartSourceKey(typeId, variationId, selection);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [option, setOption] = useState<Record<string, unknown> | null>(null);
  const [seenSource, setSeenSource] = useState(source);
  if (seenSource !== source) {
    setSeenSource(source);
    setDraft(null);
    setError(null);
    setOption(null);
  }

  const onChange = (text: string) => {
    setDraft(text);
    const parsed = parseChartCode(text);
    if (parsed.ok) {
      setError(null);
      setOption(parsed.option);
      return;
    }
    setError(parsed.error);
  };

  const reset = () => {
    setDraft(null);
    setError(null);
    setOption(null);
  };

  return {
    text: draft ?? (generated === null ? "" : formatChartCode(generated)),
    error,
    option,
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
        <span className="text-xs text-fg-muted">Chart code. The chart title is title.text.</span>
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
