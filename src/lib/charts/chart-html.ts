/**
 * An ECharts option safe to draw.
 *
 * The tooltip writes a string `formatter` with innerHTML, and the data view does
 * the same with its title and language strings. A saved look is data, so a string
 * that contains a tag is omitted and the chart uses its ordinary label instead.
 * A function formatter is the chart's own code and is left in place.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripNode(value: unknown, inDataView: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripNode(item, inDataView));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
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
