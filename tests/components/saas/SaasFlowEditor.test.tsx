import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { API_BOARD_CAP, writeApiBoard, type ApiResourceNode } from "@/lib/saas/api-board";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

let dropOnCanvas: ((event: React.DragEvent<HTMLDivElement>) => void) | null = null;
let dragOverCanvas: ((event: React.DragEvent<HTMLDivElement>) => void) | null = null;

mock.module("@xyflow/react", () => ({
  ReactFlow: (props: {
    nodes?: Array<{
      id: string;
      type?: string;
      position: { x: number; y: number };
      data: { label?: string; detail?: string };
      selected?: boolean;
    }>;
    nodeTypes?: Record<
      string,
      React.ComponentType<{ id: string; data: { label: string; detail: string }; selected?: boolean }>
    >;
    onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
    onConnect?: (connection: { source: string | null; target: string | null }) => void;
    onNodesChange?: (changes: Array<{ type: string; id: string; position?: { x: number; y: number } }>) => void;
    children?: React.ReactNode;
  }) => {
    const nodes = props.nodes ?? [];
    dropOnCanvas = props.onDrop ?? null;
    dragOverCanvas = props.onDragOver ?? null;
    return React.createElement(
      "div",
      { "data-testid": "saas-canvas" },
      nodes.map((node) => {
        const NodeView = props.nodeTypes?.[node.type ?? ""];
        return React.createElement(
          "div",
          {
            key: node.id,
            "data-testid": `node-${node.id}`,
            "data-x": String(node.position.x),
            "data-y": String(node.position.y),
            "data-label": node.data.label,
            onClick: () => props.onNodeClick?.({} as React.MouseEvent, node),
          },
          NodeView
            ? React.createElement(NodeView, {
                id: node.id,
                data: { label: node.data.label ?? "", detail: node.data.detail ?? "" },
                selected: node.selected,
              })
            : node.data.label,
        );
      }),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => props.onConnect?.({ source: nodes[0]?.id ?? null, target: nodes[1]?.id ?? null }),
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
            props.onNodesChange?.([
              { type: "select", id: "api" },
              { type: "position", id: "api" },
              { type: "position", id: "api", position: { x: 12, y: 34 } },
              { type: "position", id: "missing", position: { x: 1, y: 1 } },
              { type: "remove", id: "api" },
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
            const id = nodes[2]?.id ?? nodes[1]?.id;
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
  Handle: () => null,
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

describe("custom API editor", () => {
  beforeEach(() => {
    localStorage.clear();
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("defines an API this app does not already ship and saves it", async () => {
    render(<ConnectPage />);
    expect(await screen.findByRole("heading", { name: "Connect APIs" })).not.toBeNull();
    expect(screen.getByText(/does not already ship/)).not.toBeNull();
    expect(screen.getByText("Choose a resource to name its path.")).not.toBeNull();
    expect(screen.getByText("Draw a line from the API to a resource to include it.")).not.toBeNull();
    expect(screen.getByTestId("node-api").dataset.label).toBe("New API");

    fireEvent.click(screen.getByTestId("node-api"));
    const resource = screen.getByRole("button", { name: "Resource" });
    fireEvent.dragStart(resource, { dataTransfer: transfer() });
    fireEvent.click(resource);
    expect(screen.queryByTestId("node-res-1")).toBeNull();

    fireEvent.click(resource);
    expect(screen.getByTestId("node-res-1").dataset.x).toBe("220");
    expect(screen.getByText("This API feeds items1")).not.toBeNull();

    await act(async () => {
      dropOnCanvas?.({
        preventDefault() {},
        dataTransfer: { getData: () => "" },
        clientX: 0,
        clientY: 0,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });
    expect(screen.queryByTestId("node-res-2")).toBeNull();
    await act(async () => {
      dragOverCanvas?.({
        preventDefault() {},
        dataTransfer: { dropEffect: "none" },
      } as unknown as React.DragEvent<HTMLDivElement>);
      dropOnCanvas?.({
        preventDefault() {},
        dataTransfer: { getData: () => "resource" },
        clientX: 100,
        clientY: 80,
        currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });
    expect(screen.getByTestId("node-res-2").dataset.x).toBe("90");
    expect(screen.getByTestId("node-res-2").dataset.y).toBe("60");

    while (screen.queryAllByRole("button", { name: /^Remove line / }).length > 0) {
      fireEvent.click(screen.getAllByRole("button", { name: /^Remove line / })[0] as HTMLElement);
    }
    expect(screen.getByText("Draw a line from the API to a resource to include it.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bad line" }));
    fireEvent.click(screen.getByRole("button", { name: "Draw line" }));
    expect(screen.getByText("This API feeds items1")).not.toBeNull();

    fireEvent.click(screen.getByTestId("node-res-1"));
    fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "" } });
    expect(screen.getByTestId("node-res-1").dataset.label).toBe("Resource");
    fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "orders" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/orders" } });
    fireEvent.change(screen.getByLabelText("Rows path"), { target: { value: "data" } });
    expect(screen.getByText("This API feeds orders")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
    expect(screen.getByTestId("node-api").dataset.x).toBe("12");
    fireEvent.click(screen.getByRole("button", { name: "Drop change" }));
    expect(screen.queryByTestId("node-res-2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Name this API.");
    fireEvent.change(screen.getByLabelText("API name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "https://api.example.com/" } });
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "super-secret" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "header" } });
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Name the header the secret is sent in.");
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-API-Key" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "basic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Add the username for basic authentication.");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "account" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "bearer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("status").textContent).toBe("Saved Acme. It is in your connections.");

    const saved = JSON.parse(localStorage.getItem("libredb_connections") ?? "[]") as Array<{
      type?: string;
      host?: string;
      password?: string;
      name?: string;
      apiCatalog?: string;
      user?: string;
    }>;
    const connection = saved.find((item) => item.name === "Acme");
    expect(connection).toMatchObject({ type: "rest", host: "api.example.com", password: "super-secret", name: "Acme" });
    expect(connection?.user).toBeUndefined();
    const catalog = JSON.parse(connection?.apiCatalog ?? "") as { auth: string; resources: unknown[] };
    expect(catalog.auth).toBe("bearer");
    expect(JSON.stringify(catalog)).not.toContain("super-secret");
    expect(catalog.resources).toEqual([{ name: "orders", path: "/orders", rows: "data" }]);

    fireEvent.click(screen.getByRole("button", { name: "Remove from board" }));
    expect(screen.queryByTestId("node-res-1")).toBeNull();
    expect(screen.getByText("Choose a resource to name its path.")).not.toBeNull();
  });

  test("stops at 24 resources", async () => {
    const nodes: ApiResourceNode[] = Array.from({ length: API_BOARD_CAP }, (_, index) => ({
      id: `res-${index + 1}`,
      name: `items${index + 1}`,
      path: `/items${index + 1}`,
      rows: "",
      x: 0,
      y: 0,
    }));
    writeApiBoard(localStorage, {
      api: { name: "", host: "", auth: "bearer", headerName: "X-API-Key", user: "", secret: "", x: 40, y: 48 },
      nodes,
      edges: [],
    });
    render(<ConnectPage />);
    expect(await screen.findByRole("heading", { name: "Connect APIs" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resource" }));
    expect(screen.queryByTestId("node-res-25")).toBeNull();
    expect(screen.getByTestId("node-res-24")).not.toBeNull();
  });
});
