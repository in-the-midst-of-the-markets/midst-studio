/**
 * Pixel floors for panes a percentage minimum collapses.
 *
 * react-resizable-panels 4 reads a bare number as pixels and a unitless
 * string as a percentage. The sidebar is omitted below 768px, and 35% of
 * 768 is 269, so a 240px floor stays under the 35% cap while the sidebar
 * is mounted. Below that floor the lockup and the header icons paint on
 * top of each other.
 */
export const SIDEBAR_MIN_SIZE_PX = 240;

/**
 * Toolbar, a wrapped Cross DB join bar, and a 12rem editor. A percentage
 * minimum lets the join bar take the whole pane on a short window. The
 * editor then shrinks to nothing, and the pane's scrollbar never reaches
 * a place to type.
 */
export const CROSS_DB_EDITOR_MIN_SIZE_PX = 480;

/** The editor pane's minimum. Cross DB is pixels; every other connection stays a percentage. */
export function editorTopMinSize(crossDb: boolean): number | "20" {
  return crossDb ? CROSS_DB_EDITOR_MIN_SIZE_PX : "20";
}
