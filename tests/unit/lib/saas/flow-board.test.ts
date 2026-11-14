import { describe, expect, test } from "bun:test";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  SAAS_FLOW_CAP,
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

const NOW = new Date("2026-11-13T18:00:00.000Z");

function node(over: Partial<SaasFlowNode> = {}): SaasFlowNode {
  return {
    id: "flow-1",
    type: "stripe",
    name: "Stripe",
    x: 0,
    y: 0,
    values: {},
    connectionId: "flow-1",
    createdAt: NOW.toISOString(),
    ...over,
  };
}

describe("saas flow board", () => {
  test("lists the SaaS APIs and the fields a node asks for", () => {
    const palette = saasPalette();
    expect(palette.map((item) => item.type)).toContain("stripe");
    expect(palette.find((item) => item.type === "stripe")?.label).toBe("Stripe");
    const fields = saasNodeFields("stripe");
    expect(fields.find((field) => field.field === "password")).toMatchObject({
      label: "Secret key",
      secret: true,
      placeholder: "sk_live_…",
    });
    expect(fields.find((field) => field.field === "host")?.secret).toBe(false);
    const postgres = saasNodeFields("postgres");
    expect(postgres.find((field) => field.field === "port")?.label).toBe("Port");
    expect(postgres.find((field) => field.field === "host")?.label).toBe("Host");
    expect(saasNodeFields("kafka").some((field) => field.field === "saslMechanism")).toBe(false);
  });

  test("drafts a node, skips taken ids, and refuses a full board or an unknown API", () => {
    const first = draftSaasNode({ type: "stripe", x: Number.NaN, y: Number.POSITIVE_INFINITY, existing: [], now: NOW });
    expect(first.ok && first.node).toMatchObject({ id: "flow-1", name: "Stripe", x: 0, y: 0, connectionId: "flow-1" });
    const second = draftSaasNode({
      type: "hubspot",
      x: 10,
      y: 20,
      existing: first.ok ? [first.node] : [],
      now: NOW,
    });
    expect(second.ok && second.node.id).toBe("flow-2");
    const full = Array.from({ length: SAAS_FLOW_CAP }, (_, index) => node({ id: `flow-${index + 1}` }));
    expect(draftSaasNode({ type: "stripe", x: 0, y: 0, existing: full, now: NOW })).toEqual({
      ok: false,
      error: `${SAAS_FLOW_CAP} APIs are the most this board keeps.`,
    });
    expect(draftSaasNode({ type: "nope", x: 0, y: 0, existing: [], now: NOW })).toEqual({
      ok: false,
      error: "Choose a SaaS API.",
    });
    expect(draftSaasNode({ type: "stripe", x: 1, y: 2, existing: [] }).ok).toBe(true);
  });

  test("turns a node into a connection and asks for a missing secret", () => {
    const stripe = node({ values: { host: "api.stripe.com" } });
    expect(saasConnectionIssue(stripe)).toBe("Add the Secret key before saving.");
    const ready = node({ name: "  ", values: { password: "sk_test_123", host: " api.stripe.com " } });
    expect(saasConnectionIssue(ready)).toBeNull();
    expect(connectionFromNode(ready)).toMatchObject({
      id: "flow-1",
      name: "Stripe",
      type: "stripe",
      host: "api.stripe.com",
      password: "sk_test_123",
    });
    expect(connectionFromNode(ready).port).toBeUndefined();
    const dated = connectionFromNode(node({ createdAt: "nope", values: { password: "sk" } }));
    expect(dated.createdAt.getTime()).toBe(0);
    const sheet = connectionFromNode(node({ type: "googlesheets", values: { password: "ya29", schema: "" } }));
    expect(sheet.schema).toBeUndefined();
    expect(sheet.password).toBe("ya29");
    const withPort = connectionFromNode(
      node({ type: "postgres", values: { port: "5432", password: "secret", host: "" } }),
    );
    expect(withPort.port).toBe(5432);
    expect(withPort.host).toBeUndefined();
    expect(connectionFromNode(node({ type: "postgres", values: { port: "nope" } })).port).toBeUndefined();
    expect(connectionFromNode(node({ type: "postgres", values: { port: "0" } })).port).toBeUndefined();
    expect(connectionFromNode(node({ type: "postgres", values: { port: "65536" } })).port).toBeUndefined();
  });

  test("moves, renames, edits, links, and removes", () => {
    const board: SaasFlowBoard = {
      nodes: [node(), node({ id: "flow-2", type: "hubspot", name: "HubSpot" })],
      edges: [],
    };
    expect(moveSaasNode(board, "flow-1", Number.NaN, 4)).toBe(board);
    const moved = moveSaasNode(board, "missing", 3, 4);
    expect(moved.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(moveSaasNode(board, "flow-1", 8, 9).nodes[0]).toMatchObject({ x: 8, y: 9 });
    expect(renameSaasNode(board, "missing", "Nope").nodes[0]?.name).toBe("Stripe");
    expect(renameSaasNode(board, "flow-1", "x".repeat(90)).nodes[0]?.name).toHaveLength(80);
    const edited = setSaasField(board, "flow-1", "password", " sk ");
    expect(edited.nodes[0]?.values.password).toBe(" sk ");
    expect(setSaasField(board, "flow-1", "nope", "x").nodes[0]?.values).toEqual({});
    expect(setSaasField(board, "missing", "password", "x").nodes[0]?.values).toEqual({});
    expect(setSaasField(board, "flow-1", "password", "p".repeat(9000)).nodes[0]?.values.password).toHaveLength(8000);
    expect(linkSaasNodes(board, "", "flow-2")).toEqual({ ok: false, error: "Connect two different APIs." });
    expect(linkSaasNodes(board, "flow-1", "flow-1")).toEqual({ ok: false, error: "Connect two different APIs." });
    expect(linkSaasNodes(board, "flow-9", "flow-2")).toEqual({ ok: false, error: "That API is not on the board." });
    const linked = linkSaasNodes(board, "flow-1", "flow-2");
    expect(linked.ok && linked.board.edges).toEqual([{ id: "flow-1::flow-2", source: "flow-1", target: "flow-2" }]);
    expect(linked.ok && linkSaasNodes(linked.board, "flow-1", "flow-2")).toEqual({
      ok: false,
      error: "Those APIs are already connected.",
    });
    expect(describeSaasFlow({ id: "flow-1::flow-2", source: "flow-1", target: "flow-2" }, board.nodes)).toBe(
      "Stripe feeds HubSpot",
    );
    expect(
      describeSaasFlow({ id: "gone::flow-2", source: "gone", target: "flow-2" }, [
        { ...node({ id: "flow-2", name: "  " }) },
      ]),
    ).toBe("API feeds API");
    const dropped = removeSaasNode(linked.ok ? linked.board : board, "flow-1");
    expect(dropped.nodes.map((item) => item.id)).toEqual(["flow-2"]);
    expect(dropped.edges).toEqual([]);
    expect(unlinkSaasNodes(linked.ok ? linked.board : board, "flow-1::flow-2").edges).toEqual([]);
  });

  test("reads a saved board and writes it back", () => {
    expect(readSaasBoard(undefined)).toEqual({ nodes: [], edges: [] });
    const memory = new Map<string, string>();
    const store = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    };
    expect(readSaasBoard(store)).toEqual({ nodes: [], edges: [] });
    memory.set("libredb_saas_flow", " ");
    expect(readSaasBoard(store).nodes).toEqual([]);
    memory.set("libredb_saas_flow", "{");
    expect(readSaasBoard(store).nodes).toEqual([]);
    memory.set("libredb_saas_flow", "null");
    expect(readSaasBoard(store).nodes).toEqual([]);
    memory.set("libredb_saas_flow", "[]");
    expect(readSaasBoard(store).nodes).toEqual([]);
    const long = "k".repeat(8001);
    memory.set(
      "libredb_saas_flow",
      JSON.stringify({
        nodes: [
          null,
          { id: "nope" },
          { id: "flow-1", type: "postgres" },
          { id: "flow-1", type: "stripe", x: 1, y: 2, createdAt: NOW.toISOString() },
          { id: "flow-2", type: "stripe", x: "1", y: 2, createdAt: NOW.toISOString() },
          { id: "flow-3", type: "stripe", x: 1, y: 2, createdAt: "nope" },
          { id: "flow-4", type: "stripe", x: 1, y: 2, createdAt: NOW.toISOString(), values: [] },
          {
            id: "flow-5",
            type: "stripe",
            name: 4,
            x: 1,
            y: 2,
            createdAt: NOW.toISOString(),
            connectionId: "",
            values: { password: long, host: 3 },
          },
          node({ id: "flow-5" }),
        ],
        edges: "nope",
      }),
    );
    const kept = readSaasBoard(store);
    expect(kept.nodes.map((item) => item.id)).toEqual(["flow-5"]);
    expect(kept.nodes[0]).toMatchObject({
      name: CONNECTION_FORM.stripe.label,
      connectionId: "flow-5",
      values: { password: "k".repeat(8000) },
    });
    expect(kept.edges).toEqual([]);
    const many = Array.from({ length: SAAS_FLOW_CAP + 1 }, (_, index) =>
      node({ id: `flow-${index + 1}`, type: "stripe" }),
    );
    memory.set(
      "libredb_saas_flow",
      JSON.stringify({
        nodes: many,
        edges: [
          null,
          { source: 1, target: "flow-2" },
          { source: "flow-1", target: "flow-1" },
          { source: "flow-1", target: "missing" },
          { source: "flow-1", target: "flow-2" },
          { source: "flow-1", target: "flow-2" },
        ],
      }),
    );
    const capped = readSaasBoard(store);
    expect(capped.nodes).toHaveLength(SAAS_FLOW_CAP);
    expect(capped.edges).toEqual([{ id: "flow-1::flow-2", source: "flow-1", target: "flow-2" }]);
    expect(writeSaasBoard(store, { nodes: [node()], edges: [] })).toBe(true);
    expect(JSON.parse(memory.get("libredb_saas_flow") ?? "{}").nodes).toHaveLength(1);
    expect(
      writeSaasBoard(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("full");
          },
        },
        { nodes: [], edges: [] },
      ),
    ).toBe(false);
  });
});
