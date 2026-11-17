"use client";

import { createContext, useContext } from "react";
import type { TableNote } from "@/lib/data-dictionary";
import type { NotedColumnAnchors } from "./note-edges";

/**
 * Imperative diagram actions consumed by node components. Passed through
 * context (not node data) so node data objects stay referentially stable.
 */
export interface DiagramActions {
  /** Keyed by the NODE ID, which is the object's `diagramNodeId` and never its label (#789). */
  toggleExpand(nodeId: string): void;
  /** While editing, every visible column offers a handle a relationship can be drawn from. */
  editing: boolean;
}

export const DiagramActionsContext = createContext<DiagramActions>({
  toggleExpand: () => {},
  editing: false,
});

/** Notes keyed by `pathKey(table.path)`, so a card can show its description without a graph rebuild. */
export const DiagramNotesContext = createContext<ReadonlyMap<string, TableNote>>(new Map());

/**
 * Noted relationship columns, keyed by node id. Cards read it so those columns keep a handle
 * when Edit is off and the edge still has an endpoint to draw to.
 */
export const DiagramAnchorsContext = createContext<ReadonlyMap<string, NotedColumnAnchors>>(new Map());

export function useDiagramActions(): DiagramActions {
  return useContext(DiagramActionsContext);
}
