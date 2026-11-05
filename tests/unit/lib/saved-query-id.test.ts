import { describe, expect, test } from "bun:test";
import { SAVED_QUERY_TABLE_ID_MAX, savedQueryTableIdError } from "@/lib/saved-query-id";

describe("savedQueryTableIdError", () => {
  test("accepts a table name", () => {
    expect(savedQueryTableIdError("monthly_active_users")).toBeNull();
    expect(savedQueryTableIdError("_orders")).toBeNull();
    expect(savedQueryTableIdError("café")).toBeNull();
    expect(savedQueryTableIdError("A1")).toBeNull();
  });

  test("refuses an empty ID, a leading digit, spaces, and other characters a table name cannot use", () => {
    expect(savedQueryTableIdError("")).toContain("Enter an ID");
    expect(savedQueryTableIdError("1orders")).toContain("letter or underscore");
    expect(savedQueryTableIdError("monthly active")).toContain("letters, numbers, and underscores");
    expect(savedQueryTableIdError("monthly-active")).toContain("letters, numbers, and underscores");
    expect(savedQueryTableIdError("saved.orders")).toContain("letters, numbers, and underscores");
    expect(savedQueryTableIdError("a$b")).toContain("letters, numbers, and underscores");
    expect(savedQueryTableIdError("a".repeat(SAVED_QUERY_TABLE_ID_MAX + 1))).toContain(
      String(SAVED_QUERY_TABLE_ID_MAX),
    );
  });
});
