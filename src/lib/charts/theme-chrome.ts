import { chartTheme, type ChartTheme } from "@/lib/charts/palette";

/**
 * Ink, axis type, and grid rules that belong to the theme on screen.
 * A saved chart keeps the series colors the user chose. These three are the
 * chrome around them, and a look saved in the other theme still carries that
 * theme's values: white legend type and a heavy rule on a light card.
 */

type ChromeRole = "ink" | "axis" | "grid";

const DARK = chartTheme("dark");
const LIGHT = chartTheme("light");

const TOKENS: Record<ChromeRole, ReadonlySet<string>> = {
  ink: new Set([DARK.ink.toLowerCase(), LIGHT.ink.toLowerCase()]),
  axis: new Set([DARK.axis.toLowerCase(), LIGHT.axis.toLowerCase()]),
  grid: new Set([DARK.grid.toLowerCase(), LIGHT.grid.toLowerCase()]),
};

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The current theme's color when `color` is one of the two themes' tokens for this role. */
function chromeColor(
  role: ChromeRole,
  color: unknown,
  theme: ChartTheme,
  keep: ReadonlySet<string>,
): string | undefined {
  if (typeof color !== "string") return undefined;
  const lower = color.trim().toLowerCase();
  if (keep.has(lower)) return undefined;
  if (!TOKENS[role].has(lower)) return undefined;
  return theme[role];
}

function paintColor(
  record: Record<string, unknown>,
  role: ChromeRole,
  theme: ChartTheme,
  keep: ReadonlySet<string>,
): Record<string, unknown> {
  const color = chromeColor(role, record.color, theme, keep);
  if (color === undefined || color === record.color) return record;
  return { ...record, color };
}

function paintChild(
  record: Record<string, unknown>,
  key: string,
  role: ChromeRole,
  theme: ChartTheme,
  keep: ReadonlySet<string>,
): Record<string, unknown> {
  const child = recordOf(record[key]);
  if (child === null) return record;
  const painted = paintColor(child, role, theme, keep);
  if (painted === child) return record;
  return { ...record, [key]: painted };
}

function paintLine(
  record: Record<string, unknown>,
  key: string,
  theme: ChartTheme,
  keep: ReadonlySet<string>,
): Record<string, unknown> {
  const node = recordOf(record[key]);
  if (node === null) return record;
  const lineStyle = recordOf(node.lineStyle);
  if (lineStyle === null) return record;
  const painted = paintColor(lineStyle, "grid", theme, keep);
  if (painted === lineStyle) return record;
  return { ...record, [key]: { ...node, lineStyle: painted } };
}

function paintAxis(axis: unknown, theme: ChartTheme, keep: ReadonlySet<string>): unknown {
  if (Array.isArray(axis)) return axis.map((item) => paintAxis(item, theme, keep));
  const record = recordOf(axis);
  if (record === null) return axis;
  return paintLine(
    paintLine(paintChild(record, "axisLabel", "axis", theme, keep), "axisLine", theme, keep),
    "splitLine",
    theme,
    keep,
  );
}

/**
 * Rewrites theme ink and grid rules onto `option` for the theme that is open.
 * Series colors and any color the user typed stay. `keep` is a profile color
 * that must stay even when it is also one of the theme tokens.
 */
export function restampThemeChrome(
  option: Record<string, unknown>,
  theme: ChartTheme,
  keep: readonly string[] = [],
): Record<string, unknown> {
  const held = new Set(keep.map((color) => color.trim().toLowerCase()));
  let next = paintChild(option, "textStyle", "ink", theme, held);
  const legend = recordOf(next.legend);
  if (legend !== null) {
    const painted = paintChild(legend, "textStyle", "ink", theme, held);
    if (painted !== legend) next = { ...next, legend: painted };
  }
  for (const key of ["xAxis", "yAxis"] as const) {
    if (!(key in next)) continue;
    const painted = paintAxis(next[key], theme, held);
    if (painted !== next[key]) next = { ...next, [key]: painted };
  }
  return next;
}
