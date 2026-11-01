import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { emptyDictionary } from "@/lib/data-dictionary";
import { schemaContextOf, type DetailedObject } from "@/lib/db/detailed-object";
import { storage } from "@/lib/storage";
import { useSchemaContext } from "@/hooks/use-schema-context";

const users: DetailedObject = {
  name: "users",
  kind: "table",
  path: ["public", "users"],
  columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
  indexes: [],
};

describe("useSchemaContext", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("a connection with no notes keeps the catalog bytes", () => {
    const { result, unmount } = renderHook(() => useSchemaContext([users], null));
    expect(result.current).toBe(schemaContextOf([users]));
    unmount();
  });

  test("saved notes are folded in, and a later save replaces them", () => {
    storage.saveDataDictionary({
      ...emptyDictionary("c1"),
      tables: [
        {
          path: ["public", "users"],
          description: "Accounts",
          endorsement: "normal",
          columns: {},
          columnTypes: {},
          relationships: [],
        },
      ],
    });

    const { result, unmount } = renderHook(() => useSchemaContext([users], "c1"));
    expect(result.current).toContain("Accounts");

    act(() => {
      window.dispatchEvent(new Event("libredb-storage-change"));
      window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
    });
    expect(result.current).toContain("Accounts");

    act(() => {
      storage.saveDataDictionary({
        ...emptyDictionary("c1"),
        tables: [
          {
            path: ["public", "users"],
            description: "Renamed",
            endorsement: "normal",
            columns: {},
            columnTypes: {},
            relationships: [],
          },
        ],
      });
    });
    expect(result.current).toContain("Renamed");
    unmount();

    act(() => {
      window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "data_dictionaries" } }));
    });
  });
});
