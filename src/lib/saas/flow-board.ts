/**
 * A board of SaaS APIs the user drags into place and connects.
 *
 * Each card is one engine from the SaaS picker. Saving a card writes a normal
 * connection, so the editor can query that API. A line means one API's data
 * feeds another. The board itself stays in this browser.
 */
import {
  BODY_CONNECTION_FIELDS,
  CONNECTION_FIELD_DESCRIPTORS,
  savedFieldValue,
  type ConnectionField,
} from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  SAAS_PICKER_TYPES,
  connectionFieldHint,
  connectionFieldLabel,
  connectionFieldPlaceholder,
} from "@/lib/db/connection-form";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

export const SAAS_FLOW_KEY = "libredb_saas_flow";
export const SAAS_FLOW_CAP = 24;
export const SAAS_DRAG_MIME = "application/x-libredb-saas";

const NAME_CAP = 80;
const VALUE_CAP = 8000;

export interface SaasPaletteItem {
  readonly type: DatabaseType;
  readonly label: string;
}

export interface SaasField {
  readonly field: ConnectionField;
  readonly label: string;
  readonly placeholder: string;
  readonly hint?: string;
  readonly secret: boolean;
}

export interface SaasFlowNode {
  readonly id: string;
  readonly type: DatabaseType;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly values: Readonly<Record<string, string>>;
  readonly connectionId: string;
  readonly createdAt: string;
}

export interface SaasFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface SaasFlowBoard {
  readonly nodes: readonly SaasFlowNode[];
  readonly edges: readonly SaasFlowEdge[];
}

export interface SaasFlowStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type WritableField = (typeof BODY_CONNECTION_FIELDS)[number];

const EMPTY_BOARD: SaasFlowBoard = { nodes: [], edges: [] };

/** The SaaS APIs the palette offers, in the connection dialog's order. */
export function saasPalette(): readonly SaasPaletteItem[] {
  return SAAS_PICKER_TYPES.map((type) => ({ type, label: CONNECTION_FORM[type].label }));
}

/** A picker type, or null when the text is not one of those APIs. */
export function saasTypeOf(value: string): DatabaseType | null {
  for (const type of SAAS_PICKER_TYPES) {
    if (type === value) return type;
  }
  return null;
}

/** The boxes a card draws for one API: the engine's own labels, hints and secrets. */
export function saasNodeFields(type: DatabaseType): readonly SaasField[] {
  const config = CONNECTION_FORM[type];
  const fields: SaasField[] = [];
  for (const field of config.connectionFields) {
    const descriptor = CONNECTION_FIELD_DESCRIPTORS[field];
    const text = descriptor.slot === "body" && descriptor.control.kind === "text";
    if (descriptor.slot !== "address" && !text) continue;
    const fallback = descriptor.slot === "body" ? descriptor.label : field === "port" ? "Port" : "Host";
    const placeholder = connectionFieldPlaceholder(
      config,
      field,
      descriptor.slot === "body" ? (descriptor.placeholder ?? "") : "",
    );
    fields.push({
      field,
      label: connectionFieldLabel(config, field, fallback),
      placeholder,
      hint: connectionFieldHint(config, field),
      secret:
        descriptor.slot === "body" && descriptor.control.kind === "text" && descriptor.control.typing === "secret",
    });
  }
  return fields;
}

function freshId(existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((node) => node.id));
  let n = 1;
  while (taken.has(`flow-${n}`)) n += 1;
  return `flow-${n}`;
}

function blankValues(type: DatabaseType): Record<string, string> {
  return Object.fromEntries(saasNodeFields(type).map((field) => [field.field, ""]));
}

/** A card for one API, or why it cannot be added. */
export function draftSaasNode(input: {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly existing: readonly SaasFlowNode[];
  readonly now?: Date;
}): { ok: true; node: SaasFlowNode } | { ok: false; error: string } {
  if (input.existing.length >= SAAS_FLOW_CAP) {
    return { ok: false, error: `${SAAS_FLOW_CAP} APIs are the most this board keeps.` };
  }
  const type = saasTypeOf(input.type);
  if (type === null) return { ok: false, error: "Choose a SaaS API." };
  const now = input.now ?? new Date();
  const id = freshId(input.existing);
  return {
    ok: true,
    node: {
      id,
      type,
      name: CONNECTION_FORM[type].label,
      x: Number.isFinite(input.x) ? input.x : 0,
      y: Number.isFinite(input.y) ? input.y : 0,
      values: blankValues(type),
      connectionId: id,
      createdAt: now.toISOString(),
    },
  };
}

/** Why a card cannot be saved as a connection yet, or null when it can. */
export function saasConnectionIssue(node: SaasFlowNode): string | null {
  for (const field of saasNodeFields(node.type)) {
    if (!field.secret) continue;
    if ((node.values[field.field] ?? "").trim() === "") return `Add the ${field.label} before saving.`;
  }
  return null;
}

function isWritableField(field: ConnectionField): field is WritableField {
  return (BODY_CONNECTION_FIELDS as readonly string[]).includes(field);
}

function writeAddress(connection: DatabaseConnection, field: ConnectionField, raw: string): void {
  if (field === "port") {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port <= 65535) connection.port = port;
    return;
  }
  const host = raw.trim();
  if (host !== "") connection.host = host;
}

/** The connection a saved card becomes. An empty host is left out so the API's own host applies. */
export function connectionFromNode(node: SaasFlowNode): DatabaseConnection {
  const created = new Date(node.createdAt);
  const connection: DatabaseConnection = {
    id: node.connectionId,
    name: node.name.trim() || CONNECTION_FORM[node.type].label,
    type: node.type,
    createdAt: Number.isNaN(created.getTime()) ? new Date(0) : created,
  };
  for (const item of saasNodeFields(node.type)) {
    const raw = node.values[item.field] ?? "";
    const descriptor = CONNECTION_FIELD_DESCRIPTORS[item.field];
    if (descriptor.slot === "address") {
      writeAddress(connection, item.field, raw);
      continue;
    }
    if (descriptor.slot === "body" && isWritableField(item.field)) {
      const saved = savedFieldValue(item.field, raw);
      if (saved !== undefined) connection[item.field] = saved;
    }
  }
  return connection;
}

export function moveSaasNode(board: SaasFlowBoard, id: string, x: number, y: number): SaasFlowBoard {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return board;
  return {
    ...board,
    nodes: board.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
  };
}

export function renameSaasNode(board: SaasFlowBoard, id: string, name: string): SaasFlowBoard {
  const clipped = name.slice(0, NAME_CAP);
  return {
    ...board,
    nodes: board.nodes.map((node) => (node.id === id ? { ...node, name: clipped } : node)),
  };
}

export function setSaasField(board: SaasFlowBoard, id: string, field: string, value: string): SaasFlowBoard {
  const clipped = value.slice(0, VALUE_CAP);
  return {
    ...board,
    nodes: board.nodes.map((node) => {
      if (node.id !== id) return node;
      const known = saasNodeFields(node.type).some((item) => item.field === field);
      if (!known) return node;
      return { ...node, values: { ...node.values, [field]: clipped } };
    }),
  };
}

export function removeSaasNode(board: SaasFlowBoard, id: string): SaasFlowBoard {
  return {
    nodes: board.nodes.filter((node) => node.id !== id),
    edges: board.edges.filter((edge) => edge.source !== id && edge.target !== id),
  };
}

/** A line from one card to another, or why it cannot be drawn. */
export function linkSaasNodes(
  board: SaasFlowBoard,
  source: string,
  target: string,
): { ok: true; board: SaasFlowBoard } | { ok: false; error: string } {
  if (source === "" || target === "" || source === target) return { ok: false, error: "Connect two different APIs." };
  const ids = new Set(board.nodes.map((node) => node.id));
  if (!ids.has(source) || !ids.has(target)) return { ok: false, error: "That API is not on the board." };
  const id = `${source}::${target}`;
  if (board.edges.some((edge) => edge.id === id)) return { ok: false, error: "Those APIs are already connected." };
  return { ok: true, board: { ...board, edges: [...board.edges, { id, source, target }] } };
}

export function unlinkSaasNodes(board: SaasFlowBoard, id: string): SaasFlowBoard {
  return { ...board, edges: board.edges.filter((edge) => edge.id !== id) };
}

/** "Stripe feeds HubSpot". A card with no name reads as API. */
export function describeSaasFlow(edge: SaasFlowEdge, nodes: readonly SaasFlowNode[]): string {
  const name = (id: string): string => {
    const node = nodes.find((item) => item.id === id);
    const trimmed = node?.name.trim() ?? "";
    return trimmed === "" ? "API" : trimmed;
  };
  return `${name(edge.source)} feeds ${name(edge.target)}`;
}

function readNode(value: unknown, taken: Set<string>): SaasFlowNode | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^flow-[1-9]\d{0,5}$/.test(record.id) || taken.has(record.id)) return null;
  if (typeof record.type !== "string") return null;
  const type = saasTypeOf(record.type);
  if (type === null) return null;
  if (typeof record.x !== "number" || typeof record.y !== "number") return null;
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null;
  if (typeof record.createdAt !== "string" || Number.isNaN(new Date(record.createdAt).getTime())) return null;
  const name = typeof record.name === "string" ? record.name.slice(0, NAME_CAP) : CONNECTION_FORM[type].label;
  const connectionId =
    typeof record.connectionId === "string" && record.connectionId.trim() !== ""
      ? record.connectionId.slice(0, NAME_CAP)
      : record.id;
  const stored = record.values !== null && typeof record.values === "object" ? record.values : null;
  if (stored === null || Array.isArray(stored)) return null;
  const values: Record<string, string> = blankValues(type);
  for (const field of Object.keys(values)) {
    const raw = (stored as Record<string, unknown>)[field];
    if (typeof raw === "string") values[field] = raw.slice(0, VALUE_CAP);
  }
  taken.add(record.id);
  return { id: record.id, type, name, x: record.x, y: record.y, values, connectionId, createdAt: record.createdAt };
}

function readNodes(value: unknown): SaasFlowNode[] {
  if (!Array.isArray(value)) return [];
  const taken = new Set<string>();
  const nodes: SaasFlowNode[] = [];
  for (const item of value) {
    if (nodes.length >= SAAS_FLOW_CAP) break;
    const node = readNode(item, taken);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

function readEdges(value: unknown, ids: ReadonlySet<string>): SaasFlowEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: SaasFlowEdge[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.source !== "string" || typeof record.target !== "string") continue;
    if (!ids.has(record.source) || !ids.has(record.target) || record.source === record.target) continue;
    const id = `${record.source}::${record.target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, source: record.source, target: record.target });
  }
  return edges;
}

/** The board this browser stored, or an empty one when the copy is missing or broken. */
export function readSaasBoard(store: SaasFlowStore | undefined): SaasFlowBoard {
  if (store === undefined) return EMPTY_BOARD;
  const raw = store.getItem(SAAS_FLOW_KEY);
  if (raw === null || raw.trim() === "") return EMPTY_BOARD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_BOARD;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_BOARD;
  const record = parsed as { nodes?: unknown; edges?: unknown };
  const nodes = readNodes(record.nodes);
  return { nodes, edges: readEdges(record.edges, new Set(nodes.map((node) => node.id))) };
}

/** Writes the board. A store that refuses the write answers false. */
export function writeSaasBoard(store: SaasFlowStore, board: SaasFlowBoard): boolean {
  try {
    store.setItem(SAAS_FLOW_KEY, JSON.stringify(board));
    return true;
  } catch {
    return false;
  }
}
