"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  API_DRAG_MIME,
  addApiResource,
  apiConnectionIssue,
  connectionFromBoard,
  describeApiFlows,
  linkApiResource,
  moveApiNode,
  readApiBoard,
  removeApiResource,
  setApiResource,
  setApiSettings,
  unlinkApiResource,
  writeApiBoard,
  type ApiBoard,
  type ApiResourceNode,
} from "@/lib/saas/api-board";
import type { RestAuth } from "@/lib/db/providers/sql/rest/catalog";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";

interface ApiNodeData extends Record<string, unknown> {
  label: string;
  detail: string;
}

function boardStore(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function FlowNode({ data, selected }: NodeProps<Node<ApiNodeData>>) {
  return (
    <div
      className={cn(
        "min-w-36 rounded-lg border bg-raised px-3 py-2 shadow-sm",
        selected ? "border-brand-solid" : "border-hairline",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="text-sm font-medium text-fg">{data.label}</div>
      <div className="truncate text-xs text-fg-muted">{data.detail}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { api: FlowNode, resource: FlowNode };

const inputClass = "h-8 rounded border border-hairline-strong bg-canvas px-2 text-sm text-fg";

/**
 * Define an API this app does not already ship: a hostname, how the secret is
 * sent, and the GET paths that become tables. A line includes a resource in the
 * saved connection.
 */
export function SaasFlowEditor() {
  const dragged = useRef(false);
  const [board, setBoard] = useState<ApiBoard>(() => readApiBoard(boardStore()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const store = boardStore();
    if (store !== undefined) writeApiBoard(store, board);
  }, [board]);

  const selected = board.nodes.find((node) => node.id === selectedId) ?? null;

  const onNodesChange = (changes: NodeChange<Node<ApiNodeData>>[]) => {
    setBoard((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type === "position" && change.position !== undefined) {
          next = moveApiNode(next, change.id, change.position.x, change.position.y);
        } else if (change.type === "remove" && change.id !== "api") {
          next = removeApiResource(next, change.id);
        }
      }
      return next;
    });
  };

  const onConnect = (connection: Connection) => {
    if (connection.source === null || connection.target === null) return;
    setBoard((current) => linkApiResource(current, connection.source ?? "", connection.target ?? ""));
    setNote(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.getData(API_DRAG_MIME) !== "resource") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setBoard((current) => addApiResource(current, event.clientX - bounds.left, event.clientY - bounds.top));
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const issue = apiConnectionIssue(board);
    if (issue !== null) {
      setNote(issue);
      return;
    }
    const connection = connectionFromBoard(board);
    storage.saveConnection(connection);
    setNote(`Saved ${connection.name}. It is in your connections.`);
  };

  const flows = describeApiFlows(board);
  const nodes = [
    {
      id: "api",
      type: "api",
      position: { x: board.api.x, y: board.api.y },
      selected: selectedId === "api",
      data: { label: board.api.name.trim() || "New API", detail: board.api.host.trim() || "Hostname" },
    },
    ...board.nodes.map((node) => ({
      id: node.id,
      type: "resource",
      position: { x: node.x, y: node.y },
      selected: node.id === selectedId,
      data: { label: node.name.trim() || "Resource", detail: node.path.trim() || "/path" },
    })),
  ];

  return (
    <div className="flex min-h-[640px] flex-col gap-3 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-72">
        <form
          id="api-settings"
          className="flex flex-col gap-3 rounded-lg border border-hairline bg-raised p-3"
          onSubmit={save}
        >
          <h2 className="text-sm font-medium text-fg">API</h2>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Name
            <input
              aria-label="API name"
              value={board.api.name}
              onChange={(event) => setBoard(setApiSettings(board, { name: event.target.value }))}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Hostname
            <input
              aria-label="Hostname"
              value={board.api.host}
              placeholder="api.example.com"
              autoComplete="off"
              onChange={(event) => setBoard(setApiSettings(board, { host: event.target.value }))}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Authentication
            <select
              aria-label="Authentication"
              value={board.api.auth}
              onChange={(event) => setBoard(setApiSettings(board, { auth: event.target.value as RestAuth }))}
              className={inputClass}
            >
              <option value="bearer">Bearer token</option>
              <option value="header">API key header</option>
              <option value="basic">Basic</option>
            </select>
          </label>
          {board.api.auth === "header" && (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Header name
              <input
                aria-label="Header name"
                value={board.api.headerName}
                autoComplete="off"
                onChange={(event) => setBoard(setApiSettings(board, { headerName: event.target.value }))}
                className={inputClass}
              />
            </label>
          )}
          {board.api.auth === "basic" && (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Username
              <input
                aria-label="Username"
                value={board.api.user}
                autoComplete="off"
                onChange={(event) => setBoard(setApiSettings(board, { user: event.target.value }))}
                className={inputClass}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Secret
            <input
              aria-label="Secret"
              type="password"
              value={board.api.secret}
              autoComplete="off"
              onChange={(event) => setBoard(setApiSettings(board, { secret: event.target.value }))}
              className={inputClass}
            />
          </label>
          <button type="submit" className="rounded-full bg-brand-solid px-3 py-1.5 text-xs font-medium text-white">
            Save connection
          </button>
        </form>
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            dragged.current = true;
            event.dataTransfer.setData(API_DRAG_MIME, "resource");
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            setBoard((current) => addApiResource(current, 220, 48 + current.nodes.length * 28));
          }}
          className="rounded-lg border border-hairline bg-raised px-3 py-2 text-left text-sm text-fg hover:bg-fill-subtle"
        >
          Resource
        </button>
        <p className="text-xs text-fg-muted">
          Drag a resource onto the board. A line from the API includes it. The secret stays in this browser until you
          save, and it is sent only to that hostname.
        </p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <ul aria-label="Data flows" className="flex flex-col gap-1">
          {flows.length === 0 && (
            <li className="text-xs text-fg-muted">Draw a line from the API to a resource to include it.</li>
          )}
          {flows.map((flow) => (
            <li key={flow.id} className="flex items-center justify-between gap-2 text-xs text-fg">
              <span>{flow.label}</span>
              <button
                type="button"
                aria-label={`Remove line ${flow.label}`}
                onClick={() => setBoard(unlinkApiResource(board, flow.id))}
                className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-fill-subtle hover:text-fg"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <ReactFlow
          nodes={nodes}
          edges={board.edges.map((edge) => ({ id: edge.id, source: "api", target: edge.target }))}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          fitView
          className="h-[480px] rounded-lg border border-hairline bg-canvas"
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <aside className="w-full shrink-0 lg:w-64">
        {selected === null ? (
          <p className="text-sm text-fg-muted">Choose a resource to name its path.</p>
        ) : (
          <ResourceForm
            board={board}
            resource={selected}
            onChange={setBoard}
            onRemove={() => {
              setBoard(removeApiResource(board, selected.id));
              setSelectedId(null);
              setNote(null);
            }}
          />
        )}
        {note !== null && <output className="mt-2 block text-xs text-fg-muted">{note}</output>}
      </aside>
    </div>
  );
}

function ResourceForm({
  board,
  resource,
  onChange,
  onRemove,
}: {
  board: ApiBoard;
  resource: ApiResourceNode;
  onChange: (board: ApiBoard) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-raised p-3">
      <h2 className="text-sm font-medium text-fg">Resource</h2>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Name
        <input
          aria-label="Resource name"
          value={resource.name}
          onChange={(event) => onChange(setApiResource(board, resource.id, { name: event.target.value }))}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Path
        <input
          aria-label="Path"
          value={resource.path}
          placeholder="/v1/orders"
          autoComplete="off"
          onChange={(event) => onChange(setApiResource(board, resource.id, { path: event.target.value }))}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Rows path
        <input
          aria-label="Rows path"
          value={resource.rows}
          placeholder="data"
          autoComplete="off"
          onChange={(event) => onChange(setApiResource(board, resource.id, { rows: event.target.value }))}
          className={inputClass}
        />
      </label>
      <button type="button" onClick={onRemove} className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-fill-subtle">
        Remove from board
      </button>
    </div>
  );
}
