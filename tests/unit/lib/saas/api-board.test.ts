import { describe, expect, test } from "bun:test";
import {
  API_BOARD_CAP,
  API_BOARD_KEY,
  addApiResource,
  apiConnectionIssue,
  connectionFromBoard,
  describeApiFlows,
  emptyApiBoard,
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

function resource(id: string, patch: Partial<ApiResourceNode> = {}): ApiResourceNode {
  const number = id.slice("res-".length);
  return { id, name: `items${number}`, path: `/items${number}`, rows: "", x: 0, y: 0, ...patch };
}

function ready(board: ApiBoard, patch: Partial<ApiBoard["api"]> = {}): ApiBoard {
  return {
    ...board,
    api: { ...board.api, name: "Acme", host: "api.example.com", secret: "super-secret", ...patch },
  };
}

describe("api board", () => {
  test("reads an empty board when nothing is stored", () => {
    expect(readApiBoard(undefined)).toEqual(emptyApiBoard());
    const store = { getItem: () => null, setItem: () => undefined };
    expect(readApiBoard(store)).toEqual(emptyApiBoard());
    expect(readApiBoard({ getItem: () => "", setItem: () => undefined })).toEqual(emptyApiBoard());
    expect(readApiBoard({ getItem: () => "{", setItem: () => undefined })).toEqual(emptyApiBoard());
    expect(readApiBoard({ getItem: () => "[]", setItem: () => undefined })).toEqual(emptyApiBoard());
    expect(readApiBoard({ getItem: () => "4", setItem: () => undefined })).toEqual(emptyApiBoard());
  });

  test("keeps only readable resources and lines", () => {
    const nodes = Array.from({ length: API_BOARD_CAP + 1 }, (_, index) => resource(`res-${index + 1}`));
    const raw = JSON.stringify({
      api: { name: 4, host: null, auth: "nope", headerName: "", user: 1, secret: false, x: "nope", y: Number.NaN },
      nodes: [null, { id: "nope" }, resource("res-1"), resource("res-1"), ...nodes.slice(1)],
      edges: [null, { target: "missing" }, { target: "res-1" }, { target: "res-1" }, { target: 4 }],
    });
    const board = readApiBoard({ getItem: () => raw, setItem: () => undefined });
    expect(board.api).toMatchObject({
      name: "",
      host: "",
      auth: "bearer",
      headerName: "X-API-Key",
      user: "",
      secret: "",
    });
    expect(board.api.x).toBe(0);
    expect(board.nodes).toHaveLength(API_BOARD_CAP);
    expect(board.nodes[0]?.id).toBe("res-1");
    expect(board.edges).toEqual([{ id: "api::res-1", target: "res-1" }]);
    const bare = readApiBoard({
      getItem: () => JSON.stringify({ api: null, nodes: "no", edges: "no" }),
      setItem: () => undefined,
    });
    expect(bare.nodes).toEqual([]);
    expect(bare.api.auth).toBe("bearer");
    const header = readApiBoard({
      getItem: () => JSON.stringify({ api: { auth: "header", headerName: "X-Token", x: 3, y: 4 } }),
      setItem: () => undefined,
    });
    expect(header.api).toMatchObject({ auth: "header", headerName: "X-Token", x: 3, y: 4 });
    const basic = readApiBoard({
      getItem: () => JSON.stringify({ api: { auth: "basic", headerName: "" } }),
      setItem: () => undefined,
    });
    expect(basic.api).toMatchObject({ auth: "basic", headerName: "X-API-Key" });
  });

  test("writes the board and reports a store that refuses", () => {
    let saved = "";
    writeApiBoard(
      {
        getItem: () => null,
        setItem: (_key, value) => {
          saved = value;
        },
      },
      emptyApiBoard(),
    );
    expect(JSON.parse(saved)).toEqual(emptyApiBoard());
    expect(() =>
      writeApiBoard(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("full");
          },
        },
        emptyApiBoard(),
      ),
    ).toThrow("full");
    expect(API_BOARD_KEY).toBe("libredb_api_board");
  });

  test("adds, moves, edits, links, and describes resources", () => {
    const first = addApiResource(emptyApiBoard(), Number.NaN, 12);
    expect(first.nodes[0]).toMatchObject({ id: "res-1", x: 0, y: 12 });
    expect(first.edges).toEqual([{ id: "api::res-1", target: "res-1" }]);
    const taken = addApiResource({ ...emptyApiBoard(), nodes: [resource("res-1")], edges: [] }, 4, 5);
    expect(taken.nodes.map((node) => node.id)).toEqual(["res-1", "res-2"]);

    const moved = moveApiNode(first, "api", 8, 9);
    expect(moved.api).toMatchObject({ x: 8, y: 9 });
    expect(moveApiNode(first, "missing", 1, 1)).toBe(first);
    expect(moveApiNode(first, "res-1", Number.POSITIVE_INFINITY, 3).nodes[0]).toMatchObject({ x: 0, y: 3 });

    const named = setApiSettings(setApiResource(first, "res-1", { name: "orders", path: "/orders", rows: "data" }), {
      name: "Acme",
    });
    expect(named.api.name).toBe("Acme");
    expect(named.nodes[0]).toMatchObject({ name: "orders", path: "/orders", rows: "data" });
    expect(setApiResource(first, "missing", { name: "nope" })).toBe(first);
    expect(setApiSettings(first, {}).api.auth).toBe("bearer");
    expect(
      setApiSettings(first, {
        host: "api.example.com",
        auth: "basic",
        headerName: "X-Key",
        user: "ada",
        secret: "super-secret",
      }).api,
    ).toMatchObject({
      host: "api.example.com",
      auth: "basic",
      headerName: "X-Key",
      user: "ada",
      secret: "super-secret",
    });
    expect(moveApiNode(taken, "res-2", 6, 7).nodes.map((node) => node.x)).toEqual([0, 6]);
    expect(removeApiResource(taken, "res-1").nodes.map((node) => node.id)).toEqual(["res-2"]);

    const unlinked = unlinkApiResource(named, "api::res-1");
    expect(unlinked.edges).toEqual([]);
    expect(unlinkApiResource(unlinked, "api::res-1")).toBe(unlinked);
    expect(linkApiResource(unlinked, "res-1", "res-1")).toBe(unlinked);
    expect(linkApiResource(unlinked, "api", "api")).toBe(unlinked);
    expect(linkApiResource(unlinked, "api", "missing")).toBe(unlinked);
    const relinked = linkApiResource(unlinked, "api", "res-1");
    expect(relinked.edges).toEqual([{ id: "api::res-1", target: "res-1" }]);
    expect(linkApiResource(relinked, "api", "res-1")).toBe(relinked);

    expect(describeApiFlows(relinked)).toEqual([{ id: "api::res-1", label: "Acme feeds orders" }]);
    expect(
      describeApiFlows({
        ...relinked,
        api: { ...relinked.api, name: "  " },
        nodes: [{ ...relinked.nodes[0], name: "  " }],
      }),
    ).toEqual([{ id: "api::res-1", label: "This API feeds resource" }]);
    expect(describeApiFlows({ ...relinked, nodes: [] })).toEqual([{ id: "api::res-1", label: "Acme feeds resource" }]);

    expect(removeApiResource(relinked, "missing")).toBe(relinked);
    expect(removeApiResource(relinked, "res-1").nodes).toEqual([]);
  });

  test("stops at 24 resources", () => {
    const nodes = Array.from({ length: API_BOARD_CAP }, (_, index) => resource(`res-${index + 1}`));
    const full: ApiBoard = { ...emptyApiBoard(), nodes, edges: [] };
    expect(addApiResource(full, 1, 1)).toBe(full);
  });

  test("saves a bearer connection and refuses an unfinished board", () => {
    const board = ready(addApiResource(emptyApiBoard(), 1, 2));
    expect(apiConnectionIssue(emptyApiBoard())).toBe("Name this API.");
    expect(apiConnectionIssue(ready(emptyApiBoard(), { host: "" }))).toBe("Add the API hostname.");
    expect(apiConnectionIssue(ready(emptyApiBoard(), { host: "http://api.example.com" }))).toBe(
      "Use HTTPS. The secret is not sent over plain HTTP.",
    );
    expect(apiConnectionIssue(ready(emptyApiBoard(), { secret: "short" }))).toBe(
      "Add the secret. It is sent as a header, never in the URL.",
    );
    expect(apiConnectionIssue(ready(emptyApiBoard(), { secret: "line\nsecret" }))).toBe(
      "Add the secret. It is sent as a header, never in the URL.",
    );
    expect(apiConnectionIssue(ready(emptyApiBoard()))).toBe("Add a resource and draw a line from the API to it.");
    const unlinked = unlinkApiResource(board, "api::res-1");
    expect(apiConnectionIssue(unlinked)).toBe("Add a resource and draw a line from the API to it.");
    expect(connectionFromBoard(unlinked, 5)).toMatchObject({ id: "invalid", type: "rest" });

    const saved = connectionFromBoard({ ...board, api: { ...board.api, host: "https://api.example.com/" } }, 40);
    expect(saved).toMatchObject({
      id: "custom-40",
      name: "Acme",
      type: "rest",
      host: "api.example.com",
      password: "super-secret",
    });
    expect(saved).not.toHaveProperty("user");
    expect(JSON.parse(saved.apiCatalog ?? "")).toMatchObject({
      auth: "bearer",
      resources: [{ name: "items1", path: "/items1", rows: "" }],
    });

    const header = ready(board, { auth: "header", headerName: "X-API-Key" });
    expect(apiConnectionIssue(ready(board, { auth: "header", headerName: "  " }))).toBe(
      "Name the header the secret is sent in.",
    );
    expect(apiConnectionIssue(ready(board, { auth: "header", headerName: "Host" }))).toBe(
      "Name the header the secret is sent in.",
    );
    expect(JSON.parse(connectionFromBoard(header, 1).apiCatalog ?? "").headerName).toBe("X-API-Key");

    const basic = ready(board, { auth: "basic", user: "account" });
    expect(apiConnectionIssue(ready(board, { auth: "basic", user: "" }))).toBe(
      "Add the username for basic authentication.",
    );
    expect(apiConnectionIssue(ready(board, { auth: "basic", user: "a:b" }))).toBe(
      "Add the username for basic authentication.",
    );
    expect(connectionFromBoard(basic, 2)).toMatchObject({ user: "account" });

    const duplicate = setApiResource(addApiResource(board, 3, 4), "res-2", { name: "items1" });
    expect(apiConnectionIssue(ready(duplicate))).toBe("Use a different name for each resource.");
    const broken = setApiResource(board, "res-1", { path: "/../secret" });
    expect(apiConnectionIssue(ready(broken))).toBe("A resource path starts with / and has no query.");
    const rows = setApiResource(board, "res-1", { rows: "data items" });
    expect(apiConnectionIssue(ready(rows))).toBe("The rows path names one JSON field, such as data.");
  });
});
