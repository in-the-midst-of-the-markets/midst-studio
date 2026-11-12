/**
 * An ECharts option safe to draw.
 *
 * The tooltip writes a string `formatter` with innerHTML, and the data view does
 * the same with its title and language strings. The tooltip arrow also writes
 * `backgroundColor` and `borderColor`, including a gradient's first stop, into a
 * style attribute. A saved look is data, so a string that contains a tag is
 * omitted, and a color that is not a CSS color is omitted. The chart uses its
 * ordinary label or its default color instead. A function formatter is the
 * chart's own code and is left in place.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys whose string values are written into the tooltip arrow's style attribute. */
const HTML_COLOR_KEYS = new Set(["color", "backgroundColor", "borderColor", "color0", "borderColor0"]);

/**
 * A color ECharts can paint. Anything else is left out, because the tooltip arrow
 * concatenates these strings into HTML.
 */
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,40}|(?:rgb|hsl)a?\([0-9a-zA-Z%.,\s/]{1,80}\))$/;

function cssColor(value: string): string | undefined {
  const color = value.trim();
  return CSS_COLOR.test(color) ? color : undefined;
}

function htmlColor(value: unknown, inDataView: boolean): unknown {
  if (typeof value === "string") return cssColor(value);
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const color = cssColor(entry);
        if (color !== undefined) next.push(color);
        continue;
      }
      next.push(stripNode(entry, inDataView));
    }
    return next;
  }
  if (isRecord(value)) return stripNode(value, inDataView);
  return value;
}

function stripNode(value: unknown, inDataView: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNode(item, inDataView));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (HTML_COLOR_KEYS.has(key)) {
      const color = htmlColor(item, inDataView);
      if (color !== undefined) next[key] = color;
      continue;
    }
    if (typeof item === "string" && item.includes("<")) {
      if (key === "formatter" || key === "optionToContent") continue;
      if (inDataView && key === "title") {
        next[key] = "";
        continue;
      }
    }
    if (key === "lang" && inDataView && Array.isArray(item)) {
      next[key] = item.map((entry) => (typeof entry === "string" && entry.includes("<") ? "" : stripNode(entry, true)));
      continue;
    }
    next[key] = stripNode(item, inDataView || key === "dataView");
  }
  return next;
}

/** A copy of `option` whose HTML-bearing strings cannot be written into the page. */
export function chartOptionForDisplay<T>(option: T): T {
  return stripNode(option, false) as T;
}
