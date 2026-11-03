"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useId, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { applyExternalChartCode, chartCodeChangeToApply } from "@/lib/charts/chart-code-sync";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { configureMonacoLoader } from "@/lib/editor/monaco-loader";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";

configureMonacoLoader();

const JAVASCRIPT_EDITOR_OPTIONS = {
  ariaLabel: "JavaScript",
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
  scrollbar: {
    vertical: "visible" as const,
    horizontal: "visible" as const,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
};

export interface JsCodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** A JavaScript text container. Each custom filter gets its own Monaco model. */
export function JsCodeEditor({ value, onChange }: JsCodeEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(value);
  const typedByEditor = useRef(false);
  const path = `filter-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}.js`;
  const theme = useEffectiveTheme() === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK;

  useEffect(() => {
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
    <div className="min-h-48 w-full overflow-hidden rounded border border-hairline-strong">
      <Editor
        path={path}
        language="javascript"
        theme={theme}
        defaultValue={value}
        beforeMount={defineStudioThemes}
        onMount={(editor) => {
          editorRef.current = editor;
          applyExternalChartCode(editor.getModel(), valueRef.current, false);
        }}
        onChange={handleChange}
        height="12rem"
        options={JAVASCRIPT_EDITOR_OPTIONS}
        loading={
          <div className="flex h-48 items-center justify-center bg-canvas text-xs text-fg-muted">Loading editor...</div>
        }
      />
    </div>
  );
}
