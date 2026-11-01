/**
 * Which columns an AI Assist chart draws, and how that choice survives a new result.
 *
 * The model names one chart per query. Running an edited statement draws that chart
 * again from the new rows. A dimension or metric the new result still has stays
 * selected. A column it no longer has is replaced from the new result.
 */

import type { AssistChart } from "@/lib/ai/assist-plan";
import {
  classifyColumns,
  defaultSelection,
  pruneSelection,
  seedChartChoice,
  selectionReady,
  slotsFor,
  type ClassifiedColumns,
  type SlotSelection,
} from "@/lib/charts/echarts-catalog";
import type { QueryResult } from "@/lib/types";

export interface AssistChartChoice {
  readonly typeId: string;
  readonly variationId: string;
  readonly selection: SlotSelection;
}

function readyChoice(typeId: string, variationId: string, selection: SlotSelection): AssistChartChoice | null {
  if (!selectionReady(typeId, variationId, selection)) return null;
  return { typeId, variationId, selection };
}

const TIME_COLUMN = /(?:^|_)(?:date|time|timestamp|month|year|quarter|week)(?:$|_)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** A column that reads as a series over time, by its name or by date values. */
function looksTemporal(name: string, rows: readonly Record<string, unknown>[]): boolean {
  if (TIME_COLUMN.test(name)) return true;
  const filled = rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined);
  if (filled.length === 0) return false;
  let dates = 0;
  for (const value of filled) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) dates += 1;
    else if (typeof value === "string" && ISO_DATE.test(value.trim())) dates += 1;
  }
  return dates > filled.length * 0.8;
}

/**
 * A chart for a result the model did not place.
 * A series over time is a line, two measures are a scatter, one measure is a gauge,
 * and a category comparison is a bar.
 */
function fallbackChoice(result: QueryResult): AssistChartChoice | null {
  const columns = classifyColumns(result.fields, result.rows);
  const categories = columns.dimensions.filter((name) => !columns.metrics.includes(name));
  if (columns.metrics.length === 0) return null;
  if (categories.length === 0 && columns.metrics.length >= 2) {
    return readyChoice("scatter", "basic", defaultSelection("scatter", "basic", columns));
  }
  if (categories.length === 0) {
    return readyChoice("gauge", "basic", defaultSelection("gauge", "basic", columns));
  }
  const category = categories[0] ?? "";
  if (looksTemporal(category, result.rows)) {
    return readyChoice("line", "basic", defaultSelection("line", "basic", columns));
  }
  return readyChoice("bar", "basic", defaultSelection("bar", "basic", columns));
}

/**
 * A basic bar is the model's usual answer. Open a line or a scatter when the columns
 * are a series over time or two measures. A stacked bar and any other type stay.
 */
function fitBarDefault(
  choice: AssistChartChoice,
  rows: readonly Record<string, unknown>[],
  columns: ClassifiedColumns,
): AssistChartChoice {
  if (choice.typeId !== "bar" || choice.variationId !== "basic") return choice;
  const category = choice.selection.category?.[0];
  const values = choice.selection.values ?? [];
  if (category !== undefined && looksTemporal(category, rows)) {
    const line = readyChoice("line", "basic", { category: [category], values });
    if (line !== null) return line;
  }
  const metric = values[0];
  if (category !== undefined && metric !== undefined && metric !== category && columns.metrics.includes(category)) {
    const scatter = readyChoice("scatter", "basic", { x: [category], y: [metric], series: [] });
    if (scatter !== null) return scatter;
  }
  return choice;
}

/**
 * The shelves to draw after a result arrives.
 * `previous` is the choice already on screen. It is kept when the new result still
 * has those columns, and dropped when this is a different chart from the model.
 */
export function nextAssistChoice(
  chart: AssistChart | null,
  result: QueryResult | null,
  previous: AssistChartChoice | null,
): AssistChartChoice | null {
  if (result === null || result.rows.length === 0) return null;
  const columns = classifyColumns(result.fields, result.rows);
  if (previous !== null) {
    const kept = readyChoice(
      previous.typeId,
      previous.variationId,
      pruneSelection(previous.typeId, previous.variationId, columns, previous.selection),
    );
    if (kept !== null) return kept;
  }
  const seeded = seedChartChoice(chart, columns);
  if (seeded.typeId !== null && seeded.variationId !== null) {
    return fitBarDefault(
      { typeId: seeded.typeId, variationId: seeded.variationId, selection: seeded.selection },
      result.rows,
      columns,
    );
  }
  if (chart === null && previous === null) return null;
  return fallbackChoice(result);
}

/**
 * The shelves a chart type opens on this result.
 * The page uses this when someone picks a type the model did not suggest.
 * An unknown type or variation is ignored.
 */
export function assistChoiceForVariation(
  typeId: string,
  variationId: string,
  columns: ClassifiedColumns,
): AssistChartChoice | null {
  if (slotsFor(typeId, variationId) === null) return null;
  return { typeId, variationId, selection: defaultSelection(typeId, variationId, columns) };
}

const QUERY_TITLE_CAP = 120;

function stripSqlComments(sql: string): string {
  let out = "";
  for (let index = 0; index < sql.length; index += 1) {
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (pair === "/*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    out += sql[index] ?? "";
  }
  return out;
}

function keywordAt(text: string, index: number, word: string): boolean {
  if (!text.toLowerCase().startsWith(word, index)) return false;
  const before = index === 0 ? " " : (text[index - 1] ?? " ");
  const after = text[index + word.length] ?? " ";
  return /[\s(;]/.test(before) && /[\s(]/.test(after);
}

function outerSelect(text: string): string | null {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && keywordAt(text, index, "select")) return text.slice(index);
  }
  return null;
}

function splitSelectList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function columnLabel(expression: string): string {
  let text = expression.trim().replace(/\s+/g, " ");
  const alias = /^(.*)\s+as\s+(.+)$/i.exec(text);
  if (alias !== null) text = alias[2]?.trim() ?? text;
  else {
    const bare = /^(.*\))\s+([A-Za-z_][\w$]*)$/.exec(text);
    if (bare !== null) text = bare[2] ?? text;
  }
  text = text.replace(/^["`[]|["`\]]$/g, "");
  const dot = text.lastIndexOf(".");
  if (dot >= 0 && !text.includes("(")) text = text.slice(dot + 1).replace(/^["`[]|["`\]]$/g, "");
  return text;
}

function clipTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > QUERY_TITLE_CAP ? trimmed.slice(0, QUERY_TITLE_CAP) : trimmed;
}

/**
 * The card heading after someone edits the statement and runs it.
 * The model's short name described the original statement, so a different
 * statement takes its name from the columns it selects.
 */
export function titleForQuery(sql: string): string {
  const statement = stripSqlComments(sql).replace(/\s+/g, " ").trim();
  if (statement === "") return "Query";
  const select = outerSelect(statement);
  if (select === null) return clipTitle(statement);
  let list = select.replace(/^select\s+/i, "");
  list = list.replace(/^(distinct|all)\s+/i, "").replace(/^top\s+\(?\d+\)?\s+/i, "");
  let table = "";
  let depth = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && keywordAt(list, index, "from")) {
      const after = list.slice(index + 4).trim();
      table = /^[^\s,;]+/.exec(after)?.[0]?.replace(/^["`[]|["`\]]$/g, "") ?? "";
      const dot = table.lastIndexOf(".");
      if (dot >= 0) table = table.slice(dot + 1).replace(/^["`[]|["`\]]$/g, "");
      list = list.slice(0, index);
      break;
    }
  }
  const columns = splitSelectList(list)
    .map(columnLabel)
    .filter((label) => label !== "");
  if (columns.length === 0) return clipTitle(statement);
  const only = columns[0];
  if (columns.length === 1) return clipTitle(only === "*" && table !== "" ? table : (only ?? statement));
  return clipTitle(`${columns.slice(1).join(", ")} by ${columns[0] ?? ""}`);
}
