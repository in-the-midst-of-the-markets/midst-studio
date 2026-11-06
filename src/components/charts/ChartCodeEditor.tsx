"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import {
  applyChartValues,
  chartSourceKey,
  formatChartCode,
  parseChartCode,
  stripChartValues,
} from "@/lib/charts/chart-code";
import { applyExternalChartCode, chartCodeChangeToApply } from "@/lib/charts/chart-code-sync";
import type { SlotSelection } from "@/lib/charts/echarts-catalog";
import { withFilterLooks, withoutFilterLooks, type FilterLook } from "@/lib/charts/filter-look";
import { configureMonacoLoader } from "@/lib/editor/monaco-loader";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";

// Serve Monaco from our own origin rather than @monaco-editor/react's jsdelivr default.
// Runs at module load so it is in place before the first <Editor> mounts.
configureMonacoLoader();

/**
 * IDE options for the chart JSON. The studio theme supplies the token colours, and Monaco's
 * JSON grammar is what paints keys, strings, numbers, and true/false/null.
 */
const CHART_CODE_EDITOR_OPTIONS = {
  ariaLabel: "Chart code",
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
  lineNumbers: "on" as const,
  tabSize: 2,
  wordWrap: "on" as const,
  folding: true,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  fixedOverflowWidgets: true,
  padding: { top: 8 },
  cursorSmoothCaretAnimation: "on" as const,
  cursorBlinking: "smooth" as const,
  smoothScrolling: true,
  renderLineHighlight: "all" as const,
  bracketPairColorization: { enabled: true },
  matchBrackets: "always" as const,
  guides: { indentation: true, bracketPairs: true as const },
  stickyScroll: { enabled: true },
  scrollbar: {
    vertical: "visible" as const,
    horizontal: "visible" as const,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
  fontLigatures: true,
};

const EMPTY_LOOKS: ReadonlyMap<string, FilterLook> = new Map();

export interface ChartCodeState {
  readonly text: string;
  readonly error: string | null;
  /** The chart to draw: the user's look with the query's values. Null while the generated chart is shown. */
  readonly option: Record<string, unknown> | null;
  /** The parsed chart code, before the query's values are filled in. */
  readonly editedOption: Record<string, unknown> | null;
  readonly edited: boolean;
  /** Text to keep with the chart. Null means the generated chart is showing. */
  readonly persisted: string | null;
  readonly onChange: (text: string) => void;
  readonly reset: () => void;
}

/**
 * Text for how the chart looks, replaced once the user types.
 * `source` is the shelves. A new shelf starts from the generated option again.
 * `refreshToken` is the query result. A new result drops values out of the text
 * and the canvas reads them from that result instead.
 * `storedText` is a look already saved on the chart. It is what the editor shows
 * until the user types, and a parsed copy is what the canvas draws, so opening
 * the chart again matches the editor. Reset hides that saved text.
 */
export function useChartCode(
  generated: Record<string, unknown> | null,
  typeId: string | null,
  variationId: string | null,
  selection: SlotSelection | null,
  refreshToken: unknown = null,
  filterLooks: ReadonlyMap<string, FilterLook> = EMPTY_LOOKS,
  storedText: string | null = null,
): ChartCodeState {
  const source = chartSourceKey(typeId, variationId, selection);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editedOption, setEditedOption] = useState<Record<string, unknown> | null>(null);
  const [ignoreStored, setIgnoreStored] = useState(false);
  const [seenSource, setSeenSource] = useState(source);
  const [seenRefresh, setSeenRefresh] = useState(refreshToken);
  const [acceptedStored, setAcceptedStored] = useState(storedText);
  if (storedText !== acceptedStored) {
    setAcceptedStored(storedText);
    if (storedText !== draft) {
      setDraft(null);
      setError(null);
      setEditedOption(null);
      setIgnoreStored(false);
    }
  }
  if (seenSource !== source) {
    setSeenSource(source);
    setSeenRefresh(refreshToken);
    setDraft(null);
    setError(null);
    setEditedOption(null);
    setIgnoreStored(false);
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
    setIgnoreStored(false);
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
    setIgnoreStored(true);
  };

  const storedOption = useMemo(() => {
    if (ignoreStored || storedText === null) return null;
    const parsed = parseChartCode(storedText);
    return parsed.ok ? parsed.option : null;
  }, [ignoreStored, storedText]);
  const activeEdited = draft === null ? storedOption : (editedOption ?? storedOption);
  const option = useMemo(() => {
    if (activeEdited === null || generated === null) return null;
    return withoutFilterLooks(applyChartValues(activeEdited, generated));
  }, [activeEdited, generated]);

  const text =
    draft ??
    (ignoreStored ? null : storedText) ??
    (generated === null ? "" : formatChartCode(withFilterLooks(stripChartValues(generated), filterLooks)));
  const persisted = draft ?? (ignoreStored ? null : storedText);

  return {
    text,
    error,
    option,
    editedOption: activeEdited,
    edited: persisted !== null,
    persisted,
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

/** The chart option as JSON in the studio editor. The query's values stay out of the text. */
export function ChartCodeEditor({ value, error, edited, onChange, onReset }: ChartCodeEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(value);
  const typedByEditor = useRef(false);
  // A path of its own, so this model does not share view state with the query editor.
  const path = `chart-code-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
  const theme = useEffectiveTheme() === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK;

  useEffect(() => {
    // Updated before the write, so the write's own change event matches the text already stored.
    valueRef.current = value;
    applyExternalChartCode(editorRef.current?.getModel() ?? null, value, typedByEditor.current);
    typedByEditor.current = false;
  }, [value]);

  const handleChange = (next: string | undefined) => {
    const text = chartCodeChangeToApply(next, valueRef.current);
    if (text === null) return;
    typedByEditor.current = true;
    onChange(text);
  };

  return (
    <div className="flex h-full min-h-48 flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">
          This JSON is the whole chart. The query fills in data, links, and a radar indicator, so leave those out.
          title.text is drawn on the chart. An axis or the tooltip can set prefix and suffix, such as "$" or "%", or the
          tooltip can set formatter. A filter control is filters.name.control: text, select, number, or slider.
        </span>
        {edited && (
          <button type="button" onClick={onReset} className="shrink-0 text-xs font-medium text-fg-secondary underline">
            Use generated chart
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="min-h-48 w-full flex-1 overflow-hidden rounded border border-hairline-strong">
        {/*
         * `defaultValue`, not `value`. The controlled prop makes Monaco rewrite the whole buffer
         * one render behind a keystroke and jump the caret (#808). A new result or a reset still
         * reaches the model through applyExternalChartCode.
         */}
        <Editor
          path={path}
          language="json"
          theme={theme}
          defaultValue={value}
          beforeMount={defineStudioThemes}
          onMount={(editor) => {
            editorRef.current = editor;
            applyExternalChartCode(editor.getModel(), valueRef.current, false);
          }}
          onChange={handleChange}
          height="100%"
          options={CHART_CODE_EDITOR_OPTIONS}
          loading={
            <div className="flex h-full items-center justify-center bg-canvas text-xs text-fg-muted">
              Loading editor...
            </div>
          }
        />
      </div>
    </div>
  );
}
