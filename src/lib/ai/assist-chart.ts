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

function fallbackChoice(result: QueryResult): AssistChartChoice | null {
  const columns = classifyColumns(result.fields, result.rows);
  return readyChoice("bar", "basic", defaultSelection("bar", "basic", columns));
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
    return { typeId: seeded.typeId, variationId: seeded.variationId, selection: seeded.selection };
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
