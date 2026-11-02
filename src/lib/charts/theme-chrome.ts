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
function chromeColor(role: ChromeRole, color: unknown, theme: ChartTheme): string | undefined {
  if (typeof color !== "string") return undefined;
  if (!TOKENS[role].has(color.trim().toLowerCase())) return undefined;
  return theme[role];
}

function paintColor(record: Record<string, unknown>, role: ChromeRole, theme: ChartTheme): Record<string, unknown> {
  const color = chromeColor(role, record.color, theme);
  if (color === undefined || color === record.color) return record;
  return { ...record, color };
}

function paintChild(
  record: Record<string, unknown>,
  key: string,
  role: ChromeRole,
  theme: ChartTheme,
): Record<string, unknown> {
  const child = recordOf(record[key]);
  if (child === null) return record;
  const painted = paintColor(child, role, theme);
  if (painted === child) return record;
  return { ...record, [key]: painted };
}

function paintLine(record: Record<string, unknown>, key: string, theme: ChartTheme): Record<string, unknown> {
  const node = recordOf(record[key]);
  if (node === null) return record;
  const lineStyle = recordOf(node.lineStyle);
  if (lineStyle === null) return record;
  const painted = paintColor(lineStyle, "grid", theme);
  if (painted === lineStyle) return record;
  return { ...record, [key]: { ...node, lineStyle: painted } };
}

function paintAxis(axis: unknown, theme: ChartTheme): unknown {
  if (Array.isArray(axis)) return axis.map((item) => paintAxis(item, theme));
  const record = recordOf(axis);
  if (record === null) return axis;
  return paintLine(paintLine(paintChild(record, "axisLabel", "axis", theme), "axisLine", theme), "splitLine", theme);
}

/**
 * Rewrites theme ink and grid rules onto `option` for the theme that is open.
 * Series colors and any color the user typed stay.
 */
export function restampThemeChrome(option: Record<string, unknown>, theme: ChartTheme): Record<string, unknown> {
  let next = paintChild(option, "textStyle", "ink", theme);
  const legend = recordOf(next.legend);
  if (legend !== null) {
    const painted = paintChild(legend, "textStyle", "ink", theme);
    if (painted !== legend) next = { ...next, legend: painted };
  }
  for (const key of ["xAxis", "yAxis"] as const) {
    if (!(key in next)) continue;
    const painted = paintAxis(next[key], theme);
    if (painted !== next[key]) next = { ...next, [key]: painted };
  }
  return next;
}
