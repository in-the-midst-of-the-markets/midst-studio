import { describe, expect, test } from "bun:test";
import { notionCell, notionTitle } from "@/lib/db/providers/sql/notion/values";

const text = (plain: string) => [{ plain_text: plain }];

describe("notionCell", () => {
  test("flattens each property Notion returns on a page", () => {
    expect(notionCell(null)).toBeNull();
    expect(notionCell({ type: 1 })).toBeNull();
    expect(notionCell({ type: "title", title: text("Hello") })).toBe("Hello");
    expect(notionCell({ type: "rich_text", rich_text: [...text("A"), { plain_text: "B" }, "nope"] })).toBe("AB");
    expect(notionCell({ type: "rich_text", rich_text: "nope" })).toBe("");
    expect(notionCell({ type: "number", number: 3 })).toBe(3);
    expect(notionCell({ type: "number", number: null })).toBeNull();
    expect(notionCell({ type: "select", select: { name: "Open" } })).toBe("Open");
    expect(notionCell({ type: "select", select: null })).toBeNull();
    expect(notionCell({ type: "status", status: { name: "Done" } })).toBe("Done");
    expect(notionCell({ type: "multi_select", multi_select: [{ name: "A" }, { id: "b" }, "nope"] })).toBe("A, b");
    expect(notionCell({ type: "multi_select", multi_select: null })).toBe("");
    expect(notionCell({ type: "date", date: { start: "2026-01-01", end: "2026-01-02" } })).toBe(
      "2026-01-01/2026-01-02",
    );
    expect(notionCell({ type: "date", date: { start: "2026-01-01", end: "" } })).toBe("2026-01-01");
    expect(notionCell({ type: "date", date: null })).toBeNull();
    expect(notionCell({ type: "people", people: [{ name: "Ada" }, { id: "user-2" }, {}] })).toBe("Ada, user-2");
    expect(notionCell({ type: "relation", relation: [{ id: "page-1" }] })).toBe("page-1");
    expect(
      notionCell({
        type: "files",
        files: [
          { name: "plan.pdf" },
          { file: { url: "https://files.example/a" } },
          { external: { url: "https://cdn.example/b" } },
          {},
        ],
      }),
    ).toBe("plan.pdf, https://files.example/a, https://cdn.example/b");
    expect(notionCell({ type: "files", files: null })).toBe("");
    expect(notionCell({ type: "checkbox", checkbox: false })).toBe(false);
    expect(notionCell({ type: "checkbox", checkbox: "yes" })).toBeNull();
    expect(notionCell({ type: "url", url: "https://example.com" })).toBe("https://example.com");
    expect(notionCell({ type: "email", email: null })).toBeNull();
    expect(notionCell({ type: "phone_number", phone_number: "555" })).toBe("555");
    expect(notionCell({ type: "created_time", created_time: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(notionCell({ type: "last_edited_time", last_edited_time: "2026-01-02T00:00:00.000Z" })).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(notionCell({ type: "formula", formula: { type: "string", string: "ok" } })).toBe("ok");
    expect(notionCell({ type: "formula", formula: { type: "string", string: 1 } })).toBeNull();
    expect(notionCell({ type: "formula", formula: { type: "number", number: 4 } })).toBe(4);
    expect(notionCell({ type: "formula", formula: { type: "number", number: "4" } })).toBeNull();
    expect(notionCell({ type: "formula", formula: { type: "boolean", boolean: true } })).toBe(true);
    expect(notionCell({ type: "formula", formula: { type: "boolean", boolean: 1 } })).toBeNull();
    expect(notionCell({ type: "formula", formula: { type: "date", date: { start: "2026-03-01" } } })).toBe(
      "2026-03-01",
    );
    expect(notionCell({ type: "formula", formula: { type: "array" } })).toBeNull();
    expect(notionCell({ type: "formula", formula: null })).toBeNull();
    expect(notionCell({ type: "rollup", rollup: { type: "number", number: 8 } })).toBe(8);
    expect(notionCell({ type: "rollup", rollup: { type: "number", number: null } })).toBeNull();
    expect(
      notionCell({ type: "rollup", rollup: { type: "date", date: { start: "2026-04-01", end: "2026-04-02" } } }),
    ).toBe("2026-04-01/2026-04-02");
    expect(notionCell({ type: "rollup", rollup: { type: "array", array: [{ name: "Ada" }] } })).toBe("Ada");
    expect(notionCell({ type: "rollup", rollup: { type: "array", array: text("note") } })).toBe("note");
    expect(notionCell({ type: "rollup", rollup: { type: "array", array: null } })).toBeNull();
    expect(notionCell({ type: "rollup", rollup: { type: "unsupported" } })).toBeNull();
    expect(notionCell({ type: "rollup", rollup: null })).toBeNull();
    expect(notionCell({ type: "unique_id", unique_id: { prefix: "TASK", number: 12 } })).toBe("TASK-12");
    expect(notionCell({ type: "unique_id", unique_id: { number: 3 } })).toBe(3);
    expect(notionCell({ type: "unique_id", unique_id: { prefix: "", number: 3 } })).toBe(3);
    expect(notionCell({ type: "unique_id", unique_id: {} })).toBeNull();
    expect(notionCell({ type: "created_by", created_by: { name: "Ada" } })).toBe("Ada");
    expect(notionCell({ type: "last_edited_by", last_edited_by: { id: "user-9" } })).toBe("user-9");
    expect(notionCell({ type: "created_by", created_by: {} })).toBeNull();
    expect(notionCell({ type: "created_by", created_by: null })).toBeNull();
    expect(notionCell({ type: "verification", verification: { state: "verified" } })).toBe("verified");
    expect(notionCell({ type: "verification", verification: {} })).toBeNull();
    expect(notionCell({ type: "place", place: "desk" })).toBe("desk");
    expect(notionCell({ type: "place", place: { lat: 1 } })).toBeNull();
    expect(notionTitle([{ plain_text: " Tasks " }, { nope: true }])).toBe("Tasks");
    expect(notionTitle("nope")).toBe("");
  });
});
