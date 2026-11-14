import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { SAAS_FLOW_CAP, writeSaasBoard, type SaasFlowNode } from "@/lib/saas/flow-board";

let dropOnCanvas: ((event: React.DragEvent<HTMLDivElement>) => void) | null = null;

mock.module("@xyflow/react", () => ({
  ReactFlow: (props: {
    nodes?: Array<{
      id: string;
      type?: string;
      position: { x: number; y: number };
      data: Record<string, unknown>;
      selected?: boolean;
    }>;
    nodeTypes?: Record<string, React.ComponentType<{ id: string; data: Record<string, unknown>; selected?: boolean }>>;
    onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
    onConnect?: (connection: { source: string | null; target: string | null }) => void;
    onNodesChange?: (changes: Array<{ type: string; id: string; position?: { x: number; y: number } }>) => void;
    children?: React.ReactNode;
  }) => {
    const nodes = props.nodes ?? [];
    dropOnCanvas = props.onDrop ?? null;
    return React.createElement(
      "div",
      {
        "data-testid": "saas-canvas",
        onDrop: props.onDrop,
        onDragOver: props.onDragOver,
      },
      nodes.map((node) => {
        const NodeComp = props.nodeTypes?.[node.type ?? ""];
        return React.createElement(
          "div",
          {
            key: node.id,
            "data-testid": `node-${node.id}`,
            "data-x": node.position.x,
            "data-y": node.position.y,
            onClick: (event: React.MouseEvent) => props.onNodeClick?.(event, node),
          },
          NodeComp === undefined
            ? null
            : React.createElement(NodeComp, { id: node.id, data: node.data, selected: node.selected }),
        );
      }),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            const source = nodes[0]?.id ?? "";
            props.onConnect?.({ source, target: nodes[1]?.id ?? source });
          },
        },
        "Draw line",
      ),
      React.createElement(
        "button",
        { type: "button", onClick: () => props.onConnect?.({ source: null, target: null }) },
        "Bad line",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            const id = nodes[0]?.id;
            if (id === undefined) return;
            props.onNodesChange?.([
              { type: "select", id },
              { type: "position", id },
              { type: "position", id, position: { x: 12, y: 34 } },
            ]);
          },
        },
        "Nudge",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            const id = nodes[0]?.id;
            if (id === undefined) return;
            props.onNodesChange?.([{ type: "remove", id }]);
          },
        },
        "Drop change",
      ),
      props.children,
    );
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  Background: () => null,
  Controls: () => null,
  Handle: ({ type }: { type: string }) => React.createElement("span", { "data-handle": type }),
  Position: { Left: "left", Right: "right" },
}));

import ConnectPage from "@/app/connect/page";

function transfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "none",
    dropEffect: "none",
  };
}

describe("SaaS flow editor", () => {
  beforeEach(() => {
    localStorage.clear();
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("adds an API by click or drop, links it, and saves the connection", async () => {
    render(<ConnectPage />);
    expect(await screen.findByRole("heading", { name: "Connect APIs" })).not.toBeNull();
    expect(screen.getByText("Choose an API, or drag one onto the board.")).not.toBeNull();
    expect(screen.getByText("Draw a line from one API to another when its data feeds the next.")).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Filter"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching API.")).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Filter"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Stripe" }));
    expect(screen.getByTestId("node-flow-1")).not.toBeNull();

    const stripe = screen.getByRole("button", { name: "Stripe" });
    const dragged = transfer();
    fireEvent.dragStart(stripe, { dataTransfer: dragged });
    fireEvent.click(stripe);
    expect(screen.queryByTestId("node-flow-2")).toBeNull();

    const hubspot = screen.getByRole("button", { name: "HubSpot" });
    const dropped = transfer();
    fireEvent.dragStart(hubspot, { dataTransfer: dropped });
    const canvas = screen.getByTestId("saas-canvas");
    fireEvent.dragOver(canvas, { dataTransfer: dropped });
    await act(async () => {
      dropOnCanvas?.({
        preventDefault() {},
        clientX: 100,
        clientY: 80,
        dataTransfer: dropped,
        currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });
    const added = screen.getByTestId("node-flow-2");
    expect(added.dataset.x).toBe("90");
    expect(added.dataset.y).toBe("60");

    fireEvent.click(screen.getByRole("button", { name: "Bad line" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw line" }));
    expect(screen.getByText("Stripe feeds HubSpot")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Draw line" }));
    expect(screen.getByRole("status").textContent).toBe("Those APIs are already connected.");
    fireEvent.click(screen.getByRole("button", { name: "Remove line Stripe feeds HubSpot" }));
    expect(screen.queryByText("Stripe feeds HubSpot")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
    expect(screen.getByTestId("node-flow-1").dataset.x).toBe("12");
    fireEvent.click(screen.getByTestId("node-flow-1"));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Add the Secret key before saving.");
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "sk_test_123" } });
    fireEvent.change(screen.getByLabelText("API host"), { target: { value: "api.stripe.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Saved Stripe. It is in your connections.");
    const saved = JSON.parse(localStorage.getItem("libredb_connections") ?? "[]") as Array<{
      id: string;
      password?: string;
      host?: string;
      name?: string;
    }>;
    expect(saved.find((item) => item.id === "flow-1")).toMatchObject({
      password: "sk_test_123",
      host: "api.stripe.com",
      name: "Stripe",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove from board" }));
    expect(screen.queryByTestId("node-flow-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drop change" }));
    expect(screen.queryByTestId("node-flow-2")).toBeNull();
  });

  test("stops at the board cap", async () => {
    const nodes: SaasFlowNode[] = Array.from({ length: SAAS_FLOW_CAP }, (_, index) => ({
      id: `flow-${index + 1}`,
      type: "excel",
      name: "Microsoft Excel",
      x: 0,
      y: 0,
      values: {},
      connectionId: `flow-${index + 1}`,
      createdAt: "2026-11-13T18:00:00.000Z",
    }));
    writeSaasBoard(localStorage, { nodes, edges: [] });
    render(<ConnectPage />);
    expect(await screen.findByRole("heading", { name: "Connect APIs" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stripe" }));
    expect(screen.getByRole("status").textContent).toBe("24 APIs are the most this board keeps.");
  });
});
