import { describe, expect, test } from "bun:test";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { TableNote } from "@/lib/data-dictionary";
import { diagramNodeId, TABLE_SOURCE_HANDLE, TABLE_TARGET_HANDLE } from "@/components/schema-diagram/graph";
import {
  columnLink,
  listedRelationships,
  notedEdges,
  notedHandleColumns,
} from "@/components/schema-diagram/note-edges";

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

describe("notedHandleColumns", () => {
  test("keeps a column handle on each end, including a second column on the same card", () => {
    const anchors = notedHandleColumns(schema, [
      noted(
        ["public", "posts"],
        [
          { fromColumn: "title", toTable: "public.users", toColumn: "id" },
          { fromColumn: "id", toTable: "public.users", toColumn: "email" },
        ],
      ),
    ]);
    const postsId = diagramNodeId(posts.path);
    const usersId = diagramNodeId(users.path);
    expect([...(anchors.get(postsId)?.sources ?? [])].sort()).toEqual(["id", "title"]);
    expect(anchors.get(postsId)?.targets.size).toBe(0);
    expect([...(anchors.get(usersId)?.targets ?? [])].sort()).toEqual(["email", "id"]);
    expect(anchors.get(usersId)?.sources.size).toBe(0);
  });

  test("skips a note that does not join two different tables on this canvas", () => {
    const anchors = notedHandleColumns(schema, [
      noted(["ghost"], [{ fromColumn: "title", toTable: "public.users", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "", toTable: "public.users", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.users", toColumn: "" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "missing", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.posts", toColumn: "id" }]),
    ]);
    expect(anchors.size).toBe(0);
  });
});

describe("listedRelationships", () => {
  test("lists database keys and notes, and leaves out anything that is not this table", () => {
    const postsWithKeys = {
      ...posts,
      foreignKeys: [
        { columnName: "title", referencedTable: "public.users", referencedColumn: "id" },
        { columnName: "id", referencedTable: "gone", referencedColumn: "id" },
      ],
    };
    const usersWithKeys = {
      ...users,
      foreignKeys: [
        { columnName: "email", referencedTable: "public.posts", referencedColumn: "title" },
        { columnName: "id", referencedTable: "nowhere", referencedColumn: "id" },
        { columnName: "email", referencedTable: "public.orders", referencedColumn: "id" },
      ],
    };
    const orders = table("orders", ["public", "orders"], ["id"]);
    const reading = [postsWithKeys, usersWithKeys, orders];
    const notes = [
      noted(["ghost"], [{ fromColumn: "title", toTable: "public.users", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "", toTable: "public.users", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.users", toColumn: "" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.posts", toColumn: "id" }]),
      noted(["public", "orders"], [{ fromColumn: "id", toTable: "public.users", toColumn: "id" }]),
      noted(["public", "posts"], [{ fromColumn: "title", toTable: "public.users", toColumn: "email" }]),
      noted(["public", "users"], [{ fromColumn: "email", toTable: "public.posts", toColumn: "title" }]),
    ];

    const onPosts = listedRelationships(postsWithKeys, reading, notes);
    expect(onPosts.map((row) => `${row.fromDatabase ? "db" : "note"}:${row.text}`)).toEqual([
      "db:title references public.users.id",
      "db:id references gone.id",
      "db:public.users.email references title",
      "note:title references public.users.email",
      "note:public.users.email references title",
    ]);
    expect(onPosts[3]?.remove).toEqual({
      path: ["public", "posts"],
      relationship: { fromColumn: "title", toTable: "public.users", toColumn: "email" },
    });
    expect(onPosts[4]?.remove?.path).toEqual(["public", "users"]);

    const onOrders = listedRelationships(orders, reading, notes);
    expect(onOrders.map((row) => row.text)).toEqual([
      "public.users.email references id",
      "id references public.users.id",
    ]);
    expect(onOrders[0]?.fromDatabase).toBe(true);
    expect(onOrders[1]?.fromDatabase).toBe(false);
  });
});
