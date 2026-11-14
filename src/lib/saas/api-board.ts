/**
 * The board a person uses to define an API this app does not already ship.
 * A resource becomes a table when a line connects it to the API. Saving writes
 * a connection; the board itself stays in this browser.
 */
import type { DatabaseConnection } from "@/lib/types";
import {
  readRestCatalog,
  restCatalogIssue,
  restHost,
  restHostIssue,
  REST_RESOURCE_CAP,
  type RestAuth,
} from "@/lib/db/providers/sql/rest/catalog";

export const API_BOARD_KEY = "libredb_api_board";
export const API_BOARD_CAP = REST_RESOURCE_CAP;
export const API_DRAG_MIME = "application/x-libredb-api-resource";

export interface ApiSettings {
  name: string;
  host: string;
  auth: RestAuth;
  headerName: string;
  user: string;
  secret: string;
  x: number;
  y: number;
}

export interface ApiResourceNode {
  id: string;
  name: string;
  path: string;
  rows: string;
  x: number;
  y: number;
}

export interface ApiBoardEdge {
  id: string;
  target: string;
}

export interface ApiBoard {
  api: ApiSettings;
  nodes: ApiResourceNode[];
  edges: ApiBoardEdge[];
}

export interface ApiFlow {
  id: string;
  label: string;
}

interface BoardStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function emptyApiBoard(): ApiBoard {
  return {
    api: { name: "", host: "", auth: "bearer", headerName: "X-API-Key", user: "", secret: "", x: 40, y: 48 },
    nodes: [],
    edges: [],
  };
}

function authOf(value: unknown): RestAuth {
  if (value === "header" || value === "basic" || value === "bearer") return value;
  return "bearer";
}

function nodeOf(value: unknown): ApiResourceNode | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = text(record.id);
  if (!/^res-[1-9]\d{0,5}$/.test(id)) return null;
  return {
    id,
    name: text(record.name),
    path: text(record.path),
    rows: text(record.rows),
    x: finite(record.x),
    y: finite(record.y),
  };
}

/** The board last saved in this browser, or an empty one when nothing readable is there. */
export function readApiBoard(store: BoardStore | undefined): ApiBoard {
  if (store === undefined) return emptyApiBoard();
  const raw = store.getItem(API_BOARD_KEY);
  if (raw === null || raw === "") return emptyApiBoard();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyApiBoard();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyApiBoard();
  const record = parsed as Record<string, unknown>;
  const api = typeof record.api === "object" && record.api !== null ? (record.api as Record<string, unknown>) : {};
  const nodes: ApiResourceNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.nodes)) {
    for (const item of record.nodes) {
      const node = nodeOf(item);
      if (node === null || seen.has(node.id) || nodes.length >= API_BOARD_CAP) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }
  const edges: ApiBoardEdge[] = [];
  const linked = new Set<string>();
  if (Array.isArray(record.edges)) {
    for (const item of record.edges) {
      if (typeof item !== "object" || item === null) continue;
      const target = text((item as Record<string, unknown>).target);
      if (!seen.has(target) || linked.has(target)) continue;
      linked.add(target);
      edges.push({ id: `api::${target}`, target });
    }
  }
  return {
    api: {
      name: text(api.name),
      host: text(api.host),
      auth: authOf(api.auth),
      headerName: text(api.headerName) || "X-API-Key",
      user: text(api.user),
      secret: text(api.secret),
      x: finite(api.x),
      y: finite(api.y),
    },
    nodes,
    edges,
  };
}

export function writeApiBoard(store: BoardStore, board: ApiBoard): void {
  store.setItem(API_BOARD_KEY, JSON.stringify(board));
}

function nextId(nodes: readonly ApiResourceNode[]): string {
  const taken = new Set(nodes.map((node) => node.id));
  for (let index = 1; index <= API_BOARD_CAP; index += 1) {
    const id = `res-${index}`;
    if (!taken.has(id)) return id;
  }
  return "";
}

/** A new resource, already connected to the API, or the same board when 24 exist. */
export function addApiResource(board: ApiBoard, x: number, y: number): ApiBoard {
  const id = nextId(board.nodes);
  if (board.nodes.length >= API_BOARD_CAP || id === "") return board;
  const number = id.slice("res-".length);
  const node: ApiResourceNode = {
    id,
    name: `items${number}`,
    path: `/items${number}`,
    rows: "",
    x: finite(x),
    y: finite(y),
  };
  return {
    ...board,
    nodes: [...board.nodes, node],
    edges: [...board.edges, { id: `api::${id}`, target: id }],
  };
}

export function moveApiNode(board: ApiBoard, id: string, x: number, y: number): ApiBoard {
  if (id === "api") return { ...board, api: { ...board.api, x: finite(x), y: finite(y) } };
  if (!board.nodes.some((node) => node.id === id)) return board;
  return {
    ...board,
    nodes: board.nodes.map((node) => (node.id === id ? { ...node, x: finite(x), y: finite(y) } : node)),
  };
}

export function setApiSettings(board: ApiBoard, patch: Partial<ApiSettings>): ApiBoard {
  return {
    ...board,
    api: {
      ...board.api,
      name: patch.name ?? board.api.name,
      host: patch.host ?? board.api.host,
      auth: patch.auth ?? board.api.auth,
      headerName: patch.headerName ?? board.api.headerName,
      user: patch.user ?? board.api.user,
      secret: patch.secret ?? board.api.secret,
    },
  };
}

export function setApiResource(board: ApiBoard, id: string, patch: Partial<ApiResourceNode>): ApiBoard {
  if (!board.nodes.some((node) => node.id === id)) return board;
  return {
    ...board,
    nodes: board.nodes.map((node) =>
      node.id === id
        ? {
            ...node,
            name: patch.name ?? node.name,
            path: patch.path ?? node.path,
            rows: patch.rows ?? node.rows,
          }
        : node,
    ),
  };
}

export function removeApiResource(board: ApiBoard, id: string): ApiBoard {
  if (!board.nodes.some((node) => node.id === id)) return board;
  return {
    ...board,
    nodes: board.nodes.filter((node) => node.id !== id),
    edges: board.edges.filter((edge) => edge.target !== id),
  };
}

/** A line from the API to a resource. Any other pair is left unchanged. */
export function linkApiResource(board: ApiBoard, source: string, target: string): ApiBoard {
  if (source !== "api" || source === target) return board;
  if (!board.nodes.some((node) => node.id === target)) return board;
  if (board.edges.some((edge) => edge.target === target)) return board;
  return { ...board, edges: [...board.edges, { id: `api::${target}`, target }] };
}

export function unlinkApiResource(board: ApiBoard, id: string): ApiBoard {
  if (!board.edges.some((edge) => edge.id === id)) return board;
  return { ...board, edges: board.edges.filter((edge) => edge.id !== id) };
}

export function describeApiFlows(board: ApiBoard): ApiFlow[] {
  const apiName = board.api.name.trim() || "This API";
  return board.edges.map((edge) => {
    const node = board.nodes.find((item) => item.id === edge.target);
    const resource = node === undefined || node.name.trim() === "" ? "resource" : node.name.trim();
    return { id: edge.id, label: `${apiName} feeds ${resource}` };
  });
}

function linkedResources(board: ApiBoard): ApiResourceNode[] {
  const targets = new Set(board.edges.map((edge) => edge.target));
  return board.nodes.filter((node) => targets.has(node.id));
}

/** Why this board cannot be saved yet. */
export function apiConnectionIssue(board: ApiBoard): string | null {
  if (board.api.name.trim() === "") return "Name this API.";
  const host = restHostIssue(board.api.host);
  if (host !== null) return host;
  if (board.api.auth === "header" && board.api.headerName.trim() === "")
    return "Name the header the secret is sent in.";
  if (board.api.auth === "basic" && (board.api.user.trim() === "" || /[\r\n:]/.test(board.api.user))) {
    return "Add the username for basic authentication.";
  }
  const secret = board.api.secret.trim();
  if (secret.length < 8 || /[\r\n]/.test(secret)) return "Add the secret. It is sent as a header, never in the URL.";
  const resources = linkedResources(board);
  if (resources.length === 0) return "Add a resource and draw a line from the API to it.";
  return restCatalogIssue(catalogText(board, resources));
}

function catalogText(board: ApiBoard, resources: readonly ApiResourceNode[]): string {
  return JSON.stringify({
    auth: board.api.auth,
    headerName: board.api.auth === "header" ? board.api.headerName.trim() : "X-API-Key",
    resources: resources.map((resource) => ({
      name: resource.name.trim(),
      path: resource.path.trim(),
      rows: resource.rows.trim(),
    })),
  });
}

/** The connection the editor can query, when `apiConnectionIssue` is null. */
export function connectionFromBoard(board: ApiBoard, now = Date.now()): DatabaseConnection {
  const issue = apiConnectionIssue(board);
  if (issue !== null) {
    return {
      id: "invalid",
      name: "invalid",
      type: "rest",
      createdAt: new Date(0),
    };
  }
  const resources = linkedResources(board);
  const catalog = catalogText(board, resources);
  readRestCatalog(catalog);
  const name = board.api.name.trim();
  return {
    id: `custom-${now}`,
    name,
    type: "rest",
    host: restHost(board.api.host),
    ...(board.api.auth === "basic" ? { user: board.api.user.trim() } : {}),
    password: board.api.secret.trim(),
    apiCatalog: catalog,
    createdAt: new Date(now),
  };
}
