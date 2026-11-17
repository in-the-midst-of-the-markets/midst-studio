import type { DetailedObject } from "@/lib/db/detailed-object";
import { resolveObjectAddress } from "@/lib/db/object-address";
import { objectPathLabel, pathKey } from "@/lib/db/object-path";
import { liveTable, type RelationshipNote, type TableNote } from "@/lib/data-dictionary";
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

/** Columns that keep a handle after Edit is turned off, so a noted edge still has somewhere to attach. */
export interface NotedColumnAnchors {
  readonly sources: ReadonlySet<string>;
  readonly targets: ReadonlySet<string>;
}

/**
 * Column handles a noted relationship needs on each card. Edit mode mounts a handle on every
 * column; leaving Edit removes those, and a noted edge whose handle id disappeared is not drawn.
 * Catalog foreign keys already anchor their own columns. This is the rest.
 */
export function notedHandleColumns(
  schema: readonly DetailedObject[],
  notes: readonly TableNote[],
): ReadonlyMap<string, NotedColumnAnchors> {
  const sources = new Map<string, Set<string>>();
  const targets = new Map<string, Set<string>>();
  for (const note of notes) {
    const source = sourceObject(schema, note);
    if (source === null) continue;
    const sourceId = diagramNodeId(source.path);
    for (const rel of note.relationships) {
      if (rel.fromColumn === "" || rel.toColumn === "") continue;
      const resolution = resolveObjectAddress(schema, (object) => object.path, rel.toTable, source.path.slice(0, -1));
      if (resolution.kind !== "resolved") continue;
      const targetId = diagramNodeId(resolution.object.path);
      if (targetId === sourceId) continue;
      addColumn(sources, sourceId, rel.fromColumn);
      addColumn(targets, targetId, rel.toColumn);
    }
  }
  const anchors = new Map<string, NotedColumnAnchors>();
  for (const id of new Set([...sources.keys(), ...targets.keys()])) {
    anchors.set(id, {
      sources: sources.get(id) ?? new Set<string>(),
      targets: targets.get(id) ?? new Set<string>(),
    });
  }
  return anchors;
}

function addColumn(map: Map<string, Set<string>>, id: string, column: string): void {
  const existing = map.get(id);
  if (existing !== undefined) {
    existing.add(column);
    return;
  }
  map.set(id, new Set([column]));
}

/** One relationship the selected card should name. `remove` is set only for a note Edit can drop. */
export interface ListedRelationship {
  readonly key: string;
  readonly text: string;
  readonly fromDatabase: boolean;
  readonly remove: { readonly path: readonly string[]; readonly relationship: RelationshipNote } | null;
}

/**
 * Relationships to show for one card: foreign keys the database declared, then notes.
 * A database key is listed and never offered for removal. A note is listed from either card,
 * and removal always edits the note on the source table.
 */
export function listedRelationships(
  table: DetailedObject,
  schema: readonly DetailedObject[],
  notes: readonly TableNote[],
): ListedRelationship[] {
  const rows: ListedRelationship[] = [];
  const here = pathKey(table.path);
  let index = 0;
  for (const fk of table.foreignKeys ?? []) {
    const referenced = resolveObjectAddress(
      schema,
      (object) => object.path,
      fk.referencedTable,
      table.path.slice(0, -1),
    );
    const targetLabel = referenced.kind === "resolved" ? objectPathLabel(referenced.object.path) : fk.referencedTable;
    index += 1;
    rows.push({
      key: `database:${index}:${fk.columnName}->${targetLabel}.${fk.referencedColumn}`,
      text: `${fk.columnName} references ${targetLabel}.${fk.referencedColumn}`,
      fromDatabase: true,
      remove: null,
    });
  }
  for (const other of schema) {
    if (pathKey(other.path) === here) continue;
    for (const fk of other.foreignKeys ?? []) {
      const referenced = resolveObjectAddress(
        schema,
        (object) => object.path,
        fk.referencedTable,
        other.path.slice(0, -1),
      );
      if (referenced.kind !== "resolved" || pathKey(referenced.object.path) !== here) continue;
      const sourceLabel = objectPathLabel(other.path);
      index += 1;
      rows.push({
        key: `database:${index}:${sourceLabel}.${fk.columnName}->${fk.referencedColumn}`,
        text: `${sourceLabel}.${fk.columnName} references ${fk.referencedColumn}`,
        fromDatabase: true,
        remove: null,
      });
    }
  }
  for (const note of notes) {
    const source = sourceObject(schema, note);
    if (source === null) continue;
    const sourceHere = pathKey(source.path) === here;
    const sourceLabel = objectPathLabel(source.path);
    for (const rel of note.relationships) {
      if (rel.fromColumn === "" || rel.toTable === "" || rel.toColumn === "") continue;
      const resolution = resolveObjectAddress(schema, (object) => object.path, rel.toTable, source.path.slice(0, -1));
      const targetHere = resolution.kind === "resolved" && pathKey(resolution.object.path) === here;
      // Equal when the note is a self-link, or when it belongs to two other tables.
      if (sourceHere === targetHere) continue;
      index += 1;
      rows.push({
        key: `note:${index}:${sourceLabel}.${rel.fromColumn}->${rel.toTable}.${rel.toColumn}`,
        text: sourceHere
          ? `${rel.fromColumn} references ${rel.toTable}.${rel.toColumn}`
          : `${sourceLabel}.${rel.fromColumn} references ${rel.toColumn}`,
        fromDatabase: false,
        remove: { path: source.path, relationship: rel },
      });
    }
  }
  return rows;
}
