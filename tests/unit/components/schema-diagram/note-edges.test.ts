import { describe, expect, test } from "bun:test";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { TableNote } from "@/lib/data-dictionary";
import { diagramNodeId, TABLE_SOURCE_HANDLE, TABLE_TARGET_HANDLE } from "@/components/schema-diagram/graph";
import { columnLink, notedEdges } from "@/components/schema-diagram/note-edges";

function table(name: string, path: string[], columns: string[]): DetailedObject {
  return {
    name,
    kind: "table",
    path,
    columns: columns.map((column) => ({ name: column, type: "int", nullable: true, isPrimary: column === "id" })),
    indexes: [],
  };
}

function noted(path: string[], relationships: TableNote["relationships"]): TableNote {
  return {
    path,
    description: "",
    endorsement: "normal",
    columns: {},
    columnTypes: {},
    relationships,
  };
}

const users = table("users", ["public", "users"], ["id", "email"]);
const posts = table("posts", ["public", "posts"], ["id", "title"]);
const schema = [users, posts];

function nodes(objects: DetailedObject[], visible: Record<string, string[]> = {}) {
  return objects.map((object) => ({
    id: diagramNodeId(object.path),
    data: {
      visibleColumns: (visible[object.name] ?? object.columns.map((column) => column.name)).map((name) => ({ name })),
    },
  }));
}

describe("columnLink", () => {
  test("reads a column-to-column drag in either direction", () => {
    expect(
      columnLink({ source: "posts", sourceHandle: "title-right", target: "users", targetHandle: "id-left" }),
    ).toEqual({ sourceId: "posts", fromColumn: "title", targetId: "users", toColumn: "id" });
    expect(
      columnLink({ source: "users", sourceHandle: "id-left", target: "posts", targetHandle: "title-right" }),
    ).toEqual({ sourceId: "posts", fromColumn: "title", targetId: "users", toColumn: "id" });
  });

  test("refuses a drag that is not two different columns", () => {
    expect(
      columnLink({ source: "posts", sourceHandle: "title-right", target: "posts", targetHandle: "id-left" }),
    ).toBeNull();
    expect(
      columnLink({ source: null, sourceHandle: "title-right", target: "users", targetHandle: "id-left" }),
    ).toBeNull();
    expect(
      columnLink({ source: "posts", sourceHandle: "title-right", target: null, targetHandle: "id-left" }),
    ).toBeNull();
    expect(
      columnLink({ source: "posts", sourceHandle: "__table-source", target: "users", targetHandle: "id-left" }),
    ).toBeNull();
    expect(
      columnLink({ source: "posts", sourceHandle: "-right", target: "users", targetHandle: "id-left" }),
    ).toBeNull();
    expect(
      columnLink({ source: "posts", sourceHandle: "title-top", target: "users", targetHandle: "id-left" }),
    ).toBeNull();
    expect(columnLink({ source: "posts", sourceHandle: null, target: "users", targetHandle: null })).toBeNull();
  });
});

describe("notedEdges", () => {
  const link = { fromColumn: "title", toTable: "public.users", toColumn: "id" };

  test("draws a column edge, a table-level edge, and nothing for a pair already drawn", () => {
    const detail = notedEdges({
      schema,
      notes: [noted(["public", "posts"], [link])],
      nodes: nodes(schema),
      existing: [],
      compact: false,
    });
    expect(detail).toEqual([
      {
        id: `note:${diagramNodeId(posts.path)}.title->${diagramNodeId(users.path)}.id`,
        source: diagramNodeId(posts.path),
        target: diagramNodeId(users.path),
        sourceHandle: "title-right",
        targetHandle: "id-left",
        type: "fk",
        data: { heuristic: false, noted: true },
      },
    ]);

    const hidden = notedEdges({
      schema,
      notes: [noted(["public", "posts"], [link])],
      nodes: nodes(schema, { posts: ["id"], users: ["id"] }),
      existing: [],
      compact: false,
    });
    expect(hidden[0].sourceHandle).toBe(TABLE_SOURCE_HANDLE);
    expect(hidden[0].targetHandle).toBe("id-left");

    const compact = notedEdges({
      schema,
      notes: [noted(["public", "posts"], [link])],
      nodes: nodes(schema),
      existing: [],
      compact: true,
    });
    expect(compact[0].sourceHandle).toBe(TABLE_SOURCE_HANDLE);
    expect(compact[0].targetHandle).toBe(TABLE_TARGET_HANDLE);

    const duplicate = notedEdges({
      schema,
      notes: [noted(["public", "posts"], [link])],
      nodes: nodes(schema),
      existing: [
        { source: detail[0].source, target: detail[0].target, sourceHandle: "title-right", targetHandle: "id-left" },
      ],
      compact: false,
    });
    expect(duplicate).toEqual([]);
  });

  test("skips a note that does not name two tables on this canvas", () => {
    const edges = notedEdges({
      schema,
      notes: [
        noted(["ghost"], [link]),
        noted(["users"], [link]),
        noted(["public", "posts"], [{ fromColumn: "", toTable: "public.users", toColumn: "id" }]),
        noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.users", toColumn: "" }]),
        noted(["public", "posts"], [{ fromColumn: "title", toTable: "missing.table", toColumn: "id" }]),
        noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.posts", toColumn: "id" }]),
        noted(["public", "posts"], [link]),
        noted(["public", "users"], [link]),
      ],
      nodes: nodes([posts]),
      existing: [{ source: "nowhere", target: "else" }],
      compact: false,
    });
    expect(edges).toEqual([]);
  });
});
