/**
 * The chart title lives in the option the user edits as chart code.
 * `title.text` is the words on the chart. An empty string leaves the chart untitled
 * and does not move the legend.
 */

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
