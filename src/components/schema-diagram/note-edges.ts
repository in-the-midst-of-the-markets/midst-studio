import type { DetailedObject } from "@/lib/db/detailed-object";
import { resolveObjectAddress } from "@/lib/db/object-address";
import { pathKey } from "@/lib/db/object-path";
import { liveTable, type TableNote } from "@/lib/data-dictionary";
import { diagramNodeId, TABLE_SOURCE_HANDLE, TABLE_TARGET_HANDLE, type FkFlowEdge } from "./graph";

export interface ColumnLink {
  readonly sourceId: string;
  readonly fromColumn: string;
  readonly targetId: string;
  readonly toColumn: string;
}

/** The column-to-column drag a person finished, or null when the handles are not two columns. */
export function columnLink(connection: {
  readonly source: string | null;
  readonly target: string | null;
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
}): ColumnLink | null {
  const forward = directed(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
  if (forward !== null) return forward;
  return directed(connection.target, connection.targetHandle, connection.source, connection.sourceHandle);
}

function directed(
  source: string | null,
  sourceHandle: string | null,
  target: string | null,
  targetHandle: string | null,
): ColumnLink | null {
  if (source === null || target === null || source === target) return null;
  const fromColumn = columnName(sourceHandle, "right");
  const toColumn = columnName(targetHandle, "left");
  if (fromColumn === null || toColumn === null) return null;
  return { sourceId: source, fromColumn, targetId: target, toColumn };
}

function columnName(handle: string | null, side: "left" | "right"): string | null {
  if (handle === null || handle.startsWith("__table")) return null;
  const suffix = `-${side}`;
  if (!handle.endsWith(suffix)) return null;
  const name = handle.slice(0, -suffix.length);
  return name === "" ? null : name;
}

interface NotedEdgeInput {
  readonly schema: readonly DetailedObject[];
  readonly notes: readonly TableNote[];
  readonly nodes: readonly { id: string; data: { visibleColumns: readonly { name: string }[] } }[];
  readonly existing: readonly {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
  readonly compact: boolean;
}

/**
 * Edges for relationships a person noted, skipping any pair the database (or the heuristic)
 * already draws with the same handles. A note whose table is filtered out of the canvas,
 * or whose target spelling names nothing here, draws nothing.
 */
export function notedEdges(input: NotedEdgeInput): FkFlowEdge[] {
  const present = new Set(input.nodes.map((node) => node.id));
  const visible = new Map(
    input.nodes.map((node) => [node.id, new Set(node.data.visibleColumns.map((column) => column.name))]),
  );
  const taken = new Set(
    input.existing.map((edge) => `${edge.source}|${edge.sourceHandle ?? ""}|${edge.target}|${edge.targetHandle ?? ""}`),
  );
  const edges: FkFlowEdge[] = [];
  for (const note of input.notes) {
    const source = sourceObject(input.schema, note);
    if (source === null) continue;
    const sourceId = diagramNodeId(source.path);
    if (!present.has(sourceId)) continue;
    for (const rel of note.relationships) {
      if (rel.fromColumn === "" || rel.toColumn === "") continue;
      const resolution = resolveObjectAddress(
        input.schema,
        (object) => object.path,
        rel.toTable,
        source.path.slice(0, -1),
      );
      if (resolution.kind !== "resolved") continue;
      const targetId = diagramNodeId(resolution.object.path);
      if (targetId === sourceId || !present.has(targetId)) continue;
      const sourceHandle = handleFor(input.compact, visible, sourceId, rel.fromColumn, "source");
      const targetHandle = handleFor(input.compact, visible, targetId, rel.toColumn, "target");
      const key = `${sourceId}|${sourceHandle}|${targetId}|${targetHandle}`;
      if (taken.has(key)) continue;
      taken.add(key);
      edges.push({
        id: `note:${sourceId}.${rel.fromColumn}->${targetId}.${rel.toColumn}`,
        source: sourceId,
        target: targetId,
        sourceHandle,
        targetHandle,
        type: "fk",
        data: { heuristic: false, noted: true },
      });
    }
  }
  return edges;
}

function sourceObject(schema: readonly DetailedObject[], note: TableNote): DetailedObject | null {
  const exact = schema.find((object) => pathKey(object.path) === pathKey(note.path));
  if (exact !== undefined) return exact;
  const named = liveTable(schema, note.path);
  return named === null ? null : (named as DetailedObject);
}

function handleFor(
  compact: boolean,
  visible: ReadonlyMap<string, ReadonlySet<string>>,
  nodeId: string,
  column: string,
  side: "source" | "target",
): string {
  if (!compact && visible.get(nodeId)?.has(column)) {
    return side === "source" ? `${column}-right` : `${column}-left`;
  }
  return side === "source" ? TABLE_SOURCE_HANDLE : TABLE_TARGET_HANDLE;
}
