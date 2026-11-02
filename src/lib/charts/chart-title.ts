/**
 * The chart title lives in the option the user edits as chart code.
 * `title.text` is the words on the chart. An empty string leaves the chart untitled
 * and does not move the legend.
 */

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Fields from `title.textStyle` that the heading can show. */
export interface ChartTitleLook {
  fontSize?: number;
  fontWeight?: number | string;
  color?: string;
  fontFamily?: string;
  fontStyle?: "normal" | "italic" | "oblique";
}

/** The words in an option's title, or "" when the option has none. */
export function chartTitleText(option: Record<string, unknown> | null | undefined): string {
  if (option === null || option === undefined) return "";
  const title = option.title;
  if (typeof title === "string") return title;
  const record = recordOf(title);
  if (record === null) return "";
  return typeof record.text === "string" ? record.text : "";
}

/** Font, color, and weight from `title.textStyle`. Anything else is left to the heading. */
export function chartTitleStyle(option: Record<string, unknown> | null | undefined): ChartTitleLook {
  const textStyle = recordOf(recordOf(option?.title)?.textStyle);
  if (textStyle === null) return {};
  const look: ChartTitleLook = {};
  const fontSize = textStyle.fontSize;
  if (typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0) look.fontSize = fontSize;
  const fontWeight = textStyle.fontWeight;
  if (typeof fontWeight === "number" && Number.isFinite(fontWeight)) look.fontWeight = fontWeight;
  else if (typeof fontWeight === "string" && fontWeight.trim() !== "") look.fontWeight = fontWeight;
  const color = textStyle.color;
  if (typeof color === "string" && color.trim() !== "") look.color = color;
  const fontFamily = textStyle.fontFamily;
  if (typeof fontFamily === "string" && fontFamily.trim() !== "") look.fontFamily = fontFamily;
  const fontStyle = textStyle.fontStyle;
  if (fontStyle === "normal" || fontStyle === "italic" || fontStyle === "oblique") look.fontStyle = fontStyle;
  return look;
}

/**
 * Drops the title drawn inside the plot.
 * `untitled` is the same chart built with no title, and its legend and grid tops are what
 * the plot uses, so removing the words also gives that space back to the chart.
 */
export function omitDrawnChartTitle(
  option: Record<string, unknown>,
  untitled: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...option };
  delete next.title;
  const legendTop = recordOf(untitled.legend)?.top;
  const legend = recordOf(next.legend);
  if (legend !== null && legendTop !== undefined) next.legend = { ...legend, top: legendTop };
  const gridTop = recordOf(untitled.grid)?.top;
  const grid = recordOf(next.grid);
  if (grid !== null && gridTop !== undefined) next.grid = { ...grid, top: gridTop };
  return next;
}

/**
 * Puts `title` on an option and, when the words are non-empty, makes room under the legend.
 * The rest of the option is unchanged, so a refresh can rebuild the series and keep the title.
 */
export function applyChartTitle(option: Record<string, unknown>, title: string): Record<string, unknown> {
  const color = recordOf(option.textStyle)?.color;
  const next: Record<string, unknown> = {
    ...option,
    title: {
      text: title,
      left: "center",
      top: 0,
      textStyle: {
        fontSize: 14,
        fontWeight: 500,
        ...(typeof color === "string" && color !== "" ? { color } : {}),
      },
    },
  };
  if (title === "") return next;
  const legend = recordOf(option.legend);
  if (legend !== null) next.legend = { ...legend, top: 28 };
  const grid = recordOf(option.grid);
  if (grid !== null) {
    const top = typeof grid.top === "number" ? Math.max(grid.top, 64) : 64;
    next.grid = { ...grid, top };
  }
  return next;
}
