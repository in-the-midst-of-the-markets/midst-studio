/**
 * Keeps the chart-code editor's buffer aligned with text that did not come from a keystroke.
 *
 * The editor is uncontrolled. `@monaco-editor/react`'s controlled `value` prop rewrites the
 * whole buffer one render behind a keystroke and jumps the caret (#808), so a new query
 * result or a reset is applied here instead.
 */

export interface ChartCodeBuffer {
  getValue(): string;
  setValue(value: string): void;
}

/**
 * Writes chart code that arrived from outside the editor.
 * A keystroke has already changed the buffer, and writing that same text again moves the caret.
 * Returns whether the buffer was written.
 */
export function applyExternalChartCode(model: ChartCodeBuffer | null, next: string, typedByEditor: boolean): boolean {
  if (model === null || typedByEditor) return false;
  if (model.getValue() === next) return false;
  model.setValue(next);
  return true;
}

/**
 * The text a chart-code change should store.
 * Monaco reports a programmatic write through the same callback as a keystroke. That echo
 * matches the text already on screen, and storing it would mark the generated chart as edited.
 * An empty report is still a real edit when the buffer had text.
 */
export function chartCodeChangeToApply(next: string | undefined, currentValue: string): string | null {
  const text = next ?? "";
  if (text === currentValue) return null;
  return text;
}
