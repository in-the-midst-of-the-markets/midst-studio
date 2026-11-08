import { describe, expect, test } from "bun:test";
import { CROSS_DB_EDITOR_MIN_SIZE_PX, editorTopMinSize, SIDEBAR_MIN_SIZE_PX } from "@/components/studio/pane-floors";

describe("pane floors", () => {
  test("the sidebar floor is wide enough for the lockup and its icons", () => {
    expect(SIDEBAR_MIN_SIZE_PX).toBe(240);
  });

  test("Cross DB keeps a pixel floor and every other connection stays a percentage", () => {
    expect(editorTopMinSize(true)).toBe(CROSS_DB_EDITOR_MIN_SIZE_PX);
    expect(editorTopMinSize(true)).toBe(480);
    expect(editorTopMinSize(false)).toBe("20");
  });
});
