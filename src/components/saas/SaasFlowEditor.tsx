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
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  SAAS_DRAG_MIME,
  connectionFromNode,
  describeSaasFlow,
  draftSaasNode,
  linkSaasNodes,
  moveSaasNode,
  readSaasBoard,
  removeSaasNode,
  renameSaasNode,
  saasConnectionIssue,
  saasNodeFields,
  saasPalette,
  setSaasField,
  unlinkSaasNodes,
  writeSaasBoard,
  type SaasFlowBoard,
  type SaasFlowNode,
} from "@/lib/saas/flow-board";
import { storage } from "@/lib/storage";
import { cn } from "@/lib/utils";

interface ApiNodeData extends Record<string, unknown> {
  label: string;
  name: string;
}

function ApiNode({ data, selected }: NodeProps<Node<ApiNodeData>>) {
  return (
    <div
      className={cn(
        "min-w-36 rounded-lg border bg-raised px-3 py-2 shadow-sm",
        selected ? "border-brand-solid" : "border-hairline",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="text-sm font-medium text-fg">{data.label}</div>
      <div className="truncate text-xs text-fg-muted">{data.name}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { api: ApiNode };

/**
 * Drag a SaaS API onto the board, fill in its token, and save it as a connection.
 * A line means one API's data feeds another.
 */
export function SaasFlowEditor() {
  const [board, setBoard] = useState<SaasFlowBoard>(() =>
    readSaasBoard(typeof localStorage === "undefined" ? undefined : localStorage),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const dragged = useRef(false);
  const selected = board.nodes.find((node) => node.id === selectedId) ?? null;
  const needle = query.trim().toLowerCase();
  const palette = saasPalette().filter((item) => item.label.toLowerCase().includes(needle));

  useEffect(() => {
    writeSaasBoard(localStorage, board);
  }, [board]);

  const addNode = (type: string, x: number, y: number) => {
    const made = draftSaasNode({ type, x, y, existing: board.nodes });
    if (!made.ok) {
      setNote(made.error);
      return;
    }
    setBoard({ ...board, nodes: [...board.nodes, made.node] });
    setSelectedId(made.node.id);
    setNote(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragged.current = false;
    const bounds = event.currentTarget.getBoundingClientRect();
    addNode(event.dataTransfer.getData(SAAS_DRAG_MIME), event.clientX - bounds.left, event.clientY - bounds.top);
  };

  const onNodesChange = (changes: NodeChange<Node<ApiNodeData>>[]) => {
    setBoard((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type === "position" && change.position !== undefined) {
          next = moveSaasNode(next, change.id, change.position.x, change.position.y);
        } else if (change.type === "remove") {
          next = removeSaasNode(next, change.id);
        }
      }
      return next;
    });
  };

  const onConnect = (connection: Connection) => {
    if (connection.source === null || connection.target === null) return;
    const linked = linkSaasNodes(board, connection.source, connection.target);
    if (!linked.ok) {
      setNote(linked.error);
      return;
    }
    setBoard(linked.board);
    setNote(null);
  };

  const saveConnection = (node: SaasFlowNode) => {
    const issue = saasConnectionIssue(node);
    if (issue !== null) {
      setNote(issue);
      return;
    }
    storage.saveConnection(connectionFromNode(node));
    setNote(`Saved ${node.name.trim() || CONNECTION_FORM[node.type].label}. It is in your connections.`);
  };

  return (
    <div className="flex min-h-[640px] flex-col gap-3 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-2 lg:w-56">
        <label className="text-xs text-fg-muted">
          APIs
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            className="mt-1 h-8 w-full rounded border border-hairline-strong bg-canvas px-2 text-sm text-fg"
          />
        </label>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto lg:max-h-none">
          {palette.length === 0 && <p className="px-1 text-xs text-fg-muted">No matching API.</p>}
          {palette.map((item) => (
            <button
              key={item.type}
              type="button"
              draggable
              onDragStart={(event) => {
                dragged.current = true;
                event.dataTransfer.setData(SAAS_DRAG_MIME, item.type);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                addNode(item.type, 48 + board.nodes.length * 28, 48 + board.nodes.length * 28);
              }}
              className="rounded-lg border border-hairline bg-raised px-3 py-2 text-left text-sm text-fg hover:bg-fill-subtle"
            >
              {item.label}
            </button>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <ul aria-label="Data flows" className="flex flex-col gap-1">
          {board.edges.length === 0 && (
            <li className="text-xs text-fg-muted">Draw a line from one API to another when its data feeds the next.</li>
          )}
          {board.edges.map((edge) => {
            const label = describeSaasFlow(edge, board.nodes);
            return (
              <li key={edge.id} className="flex items-center justify-between gap-2 text-xs text-fg">
                <span>{label}</span>
                <button
                  type="button"
                  aria-label={`Remove line ${label}`}
                  onClick={() => setBoard(unlinkSaasNodes(board, edge.id))}
                  className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-fill-subtle hover:text-fg"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        <ReactFlow
          nodes={board.nodes.map((node) => ({
            id: node.id,
            type: "api",
            position: { x: node.x, y: node.y },
            selected: node.id === selectedId,
            data: { label: CONNECTION_FORM[node.type].label, name: node.name },
          }))}
          edges={board.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }))}
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
      <aside className="w-full shrink-0 lg:w-72">
        {selected === null ? (
          <p className="text-sm text-fg-muted">Choose an API, or drag one onto the board.</p>
        ) : (
          <form
            className="flex flex-col gap-3 rounded-lg border border-hairline bg-raised p-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              saveConnection(selected);
            }}
          >
            <h2 className="text-sm font-medium text-fg">{CONNECTION_FORM[selected.type].label}</h2>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Name
              <input
                aria-label="Connection name"
                value={selected.name}
                onChange={(event) => setBoard(renameSaasNode(board, selected.id, event.target.value))}
                className="h-8 rounded border border-hairline-strong bg-canvas px-2 text-sm text-fg"
              />
            </label>
            {saasNodeFields(selected.type).map((field) => (
              <label key={field.field} className="flex flex-col gap-1 text-xs text-fg-muted">
                {field.label}
                <input
                  aria-label={field.label}
                  type={field.secret ? "password" : "text"}
                  value={selected.values[field.field] ?? ""}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  onChange={(event) => setBoard(setSaasField(board, selected.id, field.field, event.target.value))}
                  className="h-8 rounded border border-hairline-strong bg-canvas px-2 text-sm text-fg"
                />
                {field.hint !== undefined && <span>{field.hint}</span>}
              </label>
            ))}
            <div className="flex items-center gap-2">
              <button type="submit" className="rounded-full bg-brand-solid px-3 py-1.5 text-xs font-medium text-white">
                Save connection
              </button>
              <button
                type="button"
                onClick={() => {
                  setBoard(removeSaasNode(board, selected.id));
                  setSelectedId(null);
                  setNote(null);
                }}
                className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-fill-subtle"
              >
                Remove from board
              </button>
            </div>
          </form>
        )}
        {note !== null && <output className="mt-2 block text-xs text-fg-muted">{note}</output>}
      </aside>
    </div>
  );
}
