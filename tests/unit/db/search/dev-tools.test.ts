import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEV_TOOLS_BODY_MAX,
  DOCUMENT_WRITE_ADMIN,
  SEARCH_POST_SUFFIXES,
  devToolsAction,
  documentWriteRefusal,
  isDocumentWrite,
  readDevToolsRequest,
} from "@/lib/db/search-dev-tools";

const SEARCH = 'GET orders/_search\n{"size":1}';

describe("readDevToolsRequest", () => {
  test("leaves SQL alone, including a DELETE the SQL plugin understands", () => {
    expect(readDevToolsRequest("SELECT 1")).toEqual({ kind: "sql" });
    expect(readDevToolsRequest("DELETE FROM probe_orders WHERE id = 1")).toEqual({ kind: "sql" });
    expect(readDevToolsRequest("   \n# only a comment\n")).toEqual({ kind: "sql" });
    expect(readDevToolsRequest("")).toEqual({ kind: "sql" });
  });

  test("reads a search, skipping comments and a byte order mark", () => {
    const read = readDevToolsRequest('\uFEFF# note\n// another\n\nget orders/_search\n\n# then\n{"size":1}');
    expect(read).toEqual({ kind: "request", request: { method: "GET", path: "orders/_search", body: '{"size":1}' } });
  });

  test("reads a request with no body, and a Windows line ending", () => {
    expect(readDevToolsRequest("HEAD /_cluster/health\r\n")).toEqual({
      kind: "request",
      request: { method: "HEAD", path: "/_cluster/health" },
    });
  });

  test("a method with no path is not sent as SQL", () => {
    expect(readDevToolsRequest("GET\n{}")).toEqual({
      kind: "invalid",
      error: "A search request needs a path. The query was not sent.",
    });
    expect(readDevToolsRequest("POST ")).toEqual({
      kind: "invalid",
      error: "A search request needs a path. The query was not sent.",
    });
  });

  test("a DELETE with a path is a request, and a body that is not one object is refused", () => {
    expect(readDevToolsRequest("DELETE orders/_doc/1")).toEqual({
      kind: "request",
      request: { method: "DELETE", path: "orders/_doc/1" },
    });
    for (const body of ["[1]", "null", "{", "1"]) {
      const read = readDevToolsRequest(`POST orders/_doc\n${body}`);
      expect(read.kind).toBe("invalid");
      if (read.kind === "invalid") expect(read.error).toContain("one JSON object");
    }
  });

  test("refuses a body over the cap before parsing it", () => {
    const read = readDevToolsRequest(`GET orders/_search\n{${" ".repeat(DEV_TOOLS_BODY_MAX)}}`);
    expect(read.kind).toBe("invalid");
    if (read.kind === "invalid") expect(read.error).toContain(String(DEV_TOOLS_BODY_MAX));
  });
});

describe("devToolsAction", () => {
  test("a search is a read, including the endpoints that take a POST body", () => {
    expect(devToolsAction({ method: "GET", path: "orders/_search?pretty#top" })).toBe("read");
    expect(devToolsAction({ method: "POST", path: "/orders/_count/" })).toBe("read");
    expect(devToolsAction({ method: "POST", path: "/orders/_explain/1" })).toBe("read");
    expect(devToolsAction({ method: "POST", path: "/orders/_validate/query" })).toBe("read");
    expect(devToolsAction({ method: "HEAD", path: "/_cluster/health" })).toBe("read");
    expect(devToolsAction({ method: "GET", path: "/_cluster/health" })).toBe("read");
  });

  test("one document insert or update is a write, and a delete is not", () => {
    expect(devToolsAction({ method: "POST", path: "orders/_doc" })).toBe("insert");
    expect(devToolsAction({ method: "PUT", path: "/orders/_doc/1" })).toBe("insert");
    expect(devToolsAction({ method: "POST", path: "/orders/_create/1?refresh=true" })).toBe("insert");
    expect(devToolsAction({ method: "POST", path: "/orders/_update/1" })).toBe("update");
    expect(devToolsAction({ method: "PUT", path: "/orders/_update/1" })).toBe("refused");
    expect(devToolsAction({ method: "DELETE", path: "/orders/_doc/1" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/orders/_delete_by_query" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/_bulk" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/logs-*/_doc/1" })).toBe("refused");
    expect(devToolsAction({ method: "PUT", path: "/.kibana/_doc/1" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/_all/_doc/1" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/orders,logs/_doc/1" })).toBe("refused");
    expect(devToolsAction({ method: "POST", path: "/orders/_update" })).toBe("refused");
  });

  test("the transport spells every search suffix the parser allows", () => {
    const transport = readFileSync(
      join(import.meta.dir, "../../../../src/lib/db/providers/sql/search/http-transport.ts"),
      "utf8",
    );
    for (const suffix of SEARCH_POST_SUFFIXES) {
      expect(transport).toContain(JSON.stringify(suffix));
    }
  });
});

describe("document writes and the admin role", () => {
  test("an admin may insert, and any other role may not", () => {
    expect(isDocumentWrite(SEARCH)).toBe(false);
    expect(isDocumentWrite("DELETE FROM t")).toBe(false);
    expect(isDocumentWrite("PUT orders/_doc/1\n{")).toBe(false);
    expect(isDocumentWrite('PUT orders/_doc/1\n{"title":"mug"}')).toBe(true);
    expect(documentWriteRefusal(['PUT orders/_doc/1\n{"title":"mug"}'], "admin")).toBeUndefined();
    expect(documentWriteRefusal(["SELECT 1"], "user")).toBeUndefined();
    expect(documentWriteRefusal([], "user")).toBeUndefined();
    expect(documentWriteRefusal(["SELECT 1", 'POST orders/_update/1\n{"doc":{"title":"mug"}}'], "user")).toBe(
      DOCUMENT_WRITE_ADMIN,
    );
  });
});
