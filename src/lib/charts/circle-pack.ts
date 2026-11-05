/**
 * Circle packing for the Scatter "Circle packing" variation.
 *
 * D3 computes the circles. The chart canvas paints them as SVG, because a pack
 * layout is not an ECharts series.
 */

import { hierarchy, pack } from "d3-hierarchy";

export const CIRCLE_PACK = "circle-pack";

export interface PackTree {
  name: string;
  value?: number;
  children?: PackTree[];
}

export interface CirclePackCircle {
  readonly name: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly depth: number;
  readonly leaf: boolean;
  readonly color: string;
}

/** Laid-out circles in a 100 by 100 square, or null when nothing has a size. */
export function layoutCircles(
  tree: PackTree,
  colors: readonly string[],
  grid: string,
): readonly CirclePackCircle[] | null {
  const root = hierarchy(tree).sum((node) => (node.children === undefined ? (node.value ?? 0) : 0));
  if ((root.value ?? 0) <= 0) return null;
  const laid = pack<PackTree>().size([100, 100]).padding(1)(root);
  const drawn = laid.descendants().filter((node) => node.depth > 0 && node.r > 0);
  if (drawn.length === 0) return null;
  let leafIndex = 0;
  return drawn.map((node) => {
    const leaf = node.children === undefined;
    const color = leaf && colors.length > 0 ? (colors[leafIndex % colors.length] ?? grid) : grid;
    if (leaf) leafIndex += 1;
    return {
      name: node.data.name,
      value: node.value ?? 0,
      x: node.x,
      y: node.y,
      r: node.r,
      depth: node.depth,
      leaf,
      color,
    };
  });
}

function isCircle(value: unknown): value is CirclePackCircle {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.value === "number" &&
    typeof record.x === "number" &&
    typeof record.y === "number" &&
    typeof record.r === "number" &&
    typeof record.depth === "number" &&
    typeof record.leaf === "boolean" &&
    typeof record.color === "string"
  );
}

/** An option this module produced. Chart code stores the look and the query refills `data`. */
export function isCirclePack(option: Record<string, unknown>): boolean {
  if (option.libredb !== CIRCLE_PACK || !Array.isArray(option.data)) return false;
  return option.data.every(isCircle);
}
