/**
 * Saved queries a person attaches to an AI Assist question.
 *
 * The chat can take several. They are run first and charted when the rows support
 * a chart. The model then writes the explanation from those rows.
 */

import { ASSIST_TEXT_CAP } from "@/lib/ai/assist-plan";
import type { SavedQuery } from "@/lib/types";

export interface AssistSavedPick {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
  readonly connectionId: string | null;
  readonly connectionType: string;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ASSIST_TEXT_CAP ? trimmed.slice(0, ASSIST_TEXT_CAP) : trimmed;
}

/** Saved queries the picker can offer. A blank statement is not one. */
export function assistSavedPicks(queries: readonly SavedQuery[]): AssistSavedPick[] {
  const picks: AssistSavedPick[] = [];
  for (const query of queries) {
    const sql = query.query.trim();
    if (sql === "") continue;
    const name = query.name.trim();
    picks.push({
      id: query.id,
      name: name === "" ? "Saved query" : name,
      sql,
      connectionId: query.connectionId ?? null,
      connectionType: query.connectionType,
    });
  }
  return picks;
}

/** Adds the query, or removes it when it is already attached. */
export function toggleAssistSaved(selected: readonly AssistSavedPick[], pick: AssistSavedPick): AssistSavedPick[] {
  if (selected.some((item) => item.id === pick.id)) return selected.filter((item) => item.id !== pick.id);
  return [...selected, pick];
}

export interface AssistSavedAsk {
  /** What the person sees in the thread. */
  readonly display: string;
  /** What the model reads. */
  readonly question: string;
}

/**
 * The question that goes with the attached queries.
 * An empty draft still asks about those queries.
 */
export function assistSavedAsk(draft: string, saved: readonly { readonly name: string }[]): AssistSavedAsk {
  const typed = draft.trim();
  if (saved.length === 0) {
    const text = clip(typed);
    return { display: text, question: text };
  }
  const names = saved
    .map((item) => item.name.trim())
    .filter((name) => name !== "")
    .join(", ");
  const lead = typed === "" ? "Analyze these saved queries." : typed;
  const display = clip(names === "" ? lead : `${lead}\n\n${names}`);
  const question = clip(`${display}\n\nExplain what these saved queries show.`);
  return { display, question };
}
